import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Express } from "express";
import { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// NFR-164: the OpenAPI document is generated from the routes the running app actually registers
// (Express router stack introspection), not from a hand-kept list. Request schemas are taken from the
// zod validator each handler runs (bound by reading the handler source), so the contract and the
// validation cannot drift apart silently. Responses are documented by status class only.

export type RouteRecord = { method: string; path: string; sessionRequired: boolean };
export type SchemaBinding = { schemaName: string; location: "body" | "query" | "params" };

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function mountPathFromRegexp(layer: { regexp?: RegExp; keys?: unknown[] }): string {
  const source = layer.regexp?.source ?? "";
  if (source === "^\\/?(?=\\/|$)" || source === "^\\/?$") return "";
  return source
    .replace(/^\^/, "")
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
    .replace(/\\\/\?\$$/, "")
    .replace(/\\\//g, "/");
}

type Layer = {
  name?: string;
  regexp?: RegExp;
  keys?: unknown[];
  route?: { path: unknown; methods: Record<string, boolean>; stack: Array<{ name?: string }> };
  handle?: { stack?: Layer[] };
};

export function collectRoutes(app: Express): RouteRecord[] {
  const root = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
  const guards: string[] = [];
  const out: RouteRecord[] = [];
  const walk = (stack: Layer[], prefix: string, guarded: boolean) => {
    // A guard registered before a router at the same mount protects every route inside that router.
    for (const layer of stack) {
      if (layer.route) {
        const routePath = layer.route.path;
        if (typeof routePath !== "string") continue;
        const routeGuard = guarded || layer.route.stack.some((handler) => handler.name === "requireAuthenticatedSession");
        for (const method of Object.keys(layer.route.methods)) {
          if (METHODS.has(method)) out.push({ method, path: (prefix + routePath).replace(/\/$/, "") || "/", sessionRequired: routeGuard });
        }
      } else if (layer.name === "router" && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPathFromRegexp(layer), guarded || guards.includes(mountPathFromRegexp(layer)));
      } else if (layer.name === "requireAuthenticatedSession") {
        guards.push(mountPathFromRegexp(layer));
      }
    }
  };
  walk(root, "", false);
  return out.filter((route) => route.path.startsWith("/api/")).sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? listSources(full) : full.endsWith(".ts") ? [full] : [];
  });
}

// Maps "METHOD <path within router>" to the zod schema the handler parses, per route source file.
export function bindSchemas(routesDir: string): Map<string, SchemaBinding> {
  const bindings = new Map<string, SchemaBinding>();
  for (const file of listSources(routesDir)) {
    const source = readFileSync(file, "utf8");
    const starts = [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)];
    starts.forEach((match, index) => {
      const end = starts[index + 1]?.index ?? source.length;
      const chunk = source.slice(match.index ?? 0, end);
      const marker = /\/\/ contract:\s*(\w+Schema)/.exec(chunk);
      const parse = (marker ? [marker[0], marker[1], "body"] : null) ?? /(\w+(?:Schema|Input))\.(?:safeParse|parse)\(\s*(?:\{[^}]*\.\.\.\(?[^)]*\)?[^}]*\}|req\.(body|query|params))/.exec(chunk) ?? /(\w+(?:Schema|Input))\.(?:safeParse|parse)\(\s*req\.(body|query|params)/.exec(chunk);
      if (parse) {
        bindings.set(`${path.basename(file)}|${match[1].toUpperCase()} ${match[2]}`, {
          schemaName: parse[1],
          location: (parse[2] as SchemaBinding["location"]) ?? "body"
        });
      }
    });
  }
  return bindings;
}

/** Routes that change something but never read a request body (actions on an item by its identifier). */
export function bodylessRoutes(routesDir: string): Set<string> {
  const out = new Set<string>();
  for (const file of listSources(routesDir)) {
    const source = readFileSync(file, "utf8");
    const starts = [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)];
    starts.forEach((match, index) => {
      if (!["post", "put", "patch"].includes(match[1])) return;
      const chunk = source.slice(match.index ?? 0, starts[index + 1]?.index ?? source.length);
      if (!/req\.body|Schema\.(?:safeParse|parse)|Input\.(?:safeParse|parse)/.test(chunk)) out.add(`${path.basename(file)}|${match[1].toUpperCase()} ${match[2]}`);
    });
  }
  return out;
}

/** Routes registered through a loop or a configurable path, which the source scan cannot bind. */
export const ROUTE_OVERRIDES: Record<string, { schemaName?: string; note?: string }> = {
  "POST /api/v1/auth/login": { schemaName: "LoginRequestSchema" },
  "POST /api/v1/admin/integrations/api-consumers/:id/suspend": { note: "Takes no request body." },
  "POST /api/v1/admin/integrations/api-consumers/:id/reinstate": { note: "Takes no request body." },
  "POST /api/v1/admin/ops/schedules/:id/enable": { note: "Takes no request body." },
  "POST /api/v1/admin/ops/schedules/:id/disable": { note: "Takes no request body." },
  "POST /api/v1/ccp/webhooks/twilio": { note: "Form-encoded callback from the messaging provider; its signature is verified. Not called by clients." }
};

export type OpenApiBuildResult = {
  spec: Record<string, unknown>;
  stats: { operations: number; withRequestSchema: number; unresolvedSchemas: string[] };
};

export function buildOpenApi(
  routes: RouteRecord[],
  schemaFor: (route: RouteRecord) => { name: string; location: SchemaBinding["location"]; schema: ZodType } | undefined,
  info: { title: string; version: string; description: string },
  serverUrl?: string,
  extras: { isBodyless?: (route: RouteRecord) => boolean; observedResponse?: (route: RouteRecord) => Record<string, Record<string, unknown>> | undefined } = {}
): OpenApiBuildResult {
  const paths: Record<string, Record<string, unknown>> = {};
  const components: Record<string, unknown> = {};
  let withRequestSchema = 0;
  for (const route of routes) {
    const openPath = route.path.replace(/:(\w+)/g, "{$1}");
    const params = [...route.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    const operation: Record<string, unknown> = {
      tags: [route.path.split("/")[3] ?? "api"],
      summary: `${route.method.toUpperCase()} ${openPath}`,
      security: route.sessionRequired ? [{ bearerAuth: [] }, { sessionCookie: [] }] : [],
      ...(params.length ? { parameters: params } : {}),
      responses: {
        "200": { description: "Success" },
        "400": { description: "Invalid request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } }, "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
        ...(route.sessionRequired ? { "401": { description: "Authentication required" }, "403": { description: "Not permitted" } } : {}),
        "429": { description: "Rate limit exceeded; see Retry-After" }
      }
    };
    const bound = schemaFor(route);
    if (bound) {
      const json = zodToJsonSchema(bound.schema, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;
      delete json.$schema;
      components[bound.name] = json;
      const ref = { $ref: `#/components/schemas/${bound.name}` };
      if (bound.location === "body") operation.requestBody = { required: true, content: { "application/json": { schema: ref } } };
      else if (bound.location === "query") {
        const props = ((json.properties ?? {}) as Record<string, unknown>);
        const required = new Set((json.required as string[] | undefined) ?? []);
        operation.parameters = [
          ...params,
          ...Object.entries(props).map(([name, schema]) => ({ name, in: "query", required: required.has(name), schema }))
        ];
      }
      withRequestSchema += 1;
    }
    if (!bound && extras.isBodyless?.(route)) operation.description = ROUTE_OVERRIDES[`${route.method.toUpperCase()} ${route.path}`]?.note ?? "Takes no request body.";
    const observed = extras.observedResponse?.(route);
    if (observed) {
      for (const [status, schema] of Object.entries(observed)) {
        (operation.responses as Record<string, unknown>)[status] = { description: "Success (schema inferred from observed responses)", content: { "application/json": { schema } } };
      }
    }
    paths[openPath] ??= {};
    paths[openPath][route.method] = operation;
  }
  const spec = {
    openapi: "3.0.3",
    info,
    servers: [{ url: serverUrl ?? "https://triagedsoc2.irisstar.tech", description: "SOC 2 staging" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        sessionCookie: { type: "apiKey", in: "cookie", name: "ist_triage_session" }
      },
      schemas: {
        Error: { type: "object", required: ["error"], properties: { error: { type: "string" } }, additionalProperties: true },
        Problem: { type: "object", required: ["type", "title", "status"], properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "integer" }, detail: { type: "string" }, instance: { type: "string" }, requestId: { type: "string" } }, additionalProperties: true },
        ...components
      }
    },
    paths
  };
  return { spec, stats: { operations: routes.length, withRequestSchema, unresolvedSchemas: [] } };
}

// Resolve which router file serves a route, from the mount list in app.ts.
function mountFiles(srcDir: string): Array<{ prefix: string; file: string }> {
  const appSource = readFileSync(path.join(srcDir, "app.ts"), "utf8");
  const files = listSources(path.join(srcDir, "routes"));
  const found: Array<{ prefix: string; file: string }> = [];
  for (const match of appSource.matchAll(/app\.use\(\s*"([^"]+)"[^;]*?\b(create\w+Router)\(\)/g)) {
    const file = files.find((candidate) => new RegExp(`function ${match[2]}\\b`).test(readFileSync(candidate, "utf8")));
    if (file) found.push({ prefix: match[1], file });
  }
  return found.sort((a, b) => b.prefix.length - a.prefix.length);
}

export function generateOpenApiFromApp(
  app: Express,
  srcDir: string,
  schemas: Record<string, unknown>,
  info: { title: string; version: string; description: string },
  observed?: Record<string, Record<string, Record<string, unknown>>>
): OpenApiBuildResult {
  const bodyless = bodylessRoutes(path.join(srcDir, "routes"));
  const routes = collectRoutes(app);
  const mounts = mountFiles(srcDir);
  const bindings = bindSchemas(path.join(srcDir, "routes"));
  const unresolved = new Set<string>();
  const result = buildOpenApi(
    routes,
    (route) => {
      const override = ROUTE_OVERRIDES[`${route.method.toUpperCase()} ${route.path}`];
      if (override?.schemaName && schemas[override.schemaName] instanceof ZodType) return { name: override.schemaName, location: "body", schema: schemas[override.schemaName] as ZodType };
      const mount = mounts.find((m) => route.path === m.prefix || route.path.startsWith(`${m.prefix}/`));
      if (!mount) return undefined;
      const rest = route.path.slice(mount.prefix.length) || "/";
      const key = (p: string) => `${path.basename(mount.file)}|${route.method.toUpperCase()} ${p}`;
      const binding = bindings.get(key(rest)) ?? bindings.get(key(rest.replace(/^\/$/, ""))) ?? bindings.get(key(rest.replace(/^(.+)$/, "$1/")));
      if (!binding) return undefined;
      const schema = schemas[binding.schemaName];
      if (!(schema instanceof ZodType)) {
        unresolved.add(binding.schemaName);
        return undefined;
      }
      return { name: binding.schemaName, location: binding.location, schema };
    },
    info,
    undefined,
    {
      isBodyless: (route) => {
        if (ROUTE_OVERRIDES[`${route.method.toUpperCase()} ${route.path}`]?.note) return true;
        const mount = mounts.find((m) => route.path === m.prefix || route.path.startsWith(`${m.prefix}/`));
        if (!mount) return false;
        const rest = route.path.slice(mount.prefix.length) || "/";
        return bodyless.has(`${path.basename(mount.file)}|${route.method.toUpperCase()} ${rest}`);
      },
      observedResponse: (route) => observed?.[`${route.method.toUpperCase()} ${route.path}`]
    }
  );
  result.stats.unresolvedSchemas = [...unresolved].sort();
  return result;
}
