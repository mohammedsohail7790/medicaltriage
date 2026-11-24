import { readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../src/app.js";
import * as contracts from "../src/services/apiContracts.js";
import { ROUTE_OVERRIDES, generateOpenApiFromApp } from "../src/services/openApiGenerator.js";
import { inferSchema, mergeSchemas } from "../src/services/schemaInference.js";
import { loadSchemaRegistry } from "../src/services/schemaRegistry.js";

const root = process.cwd();
type Op = { requestBody?: unknown; description?: string; responses: Record<string, { content?: Record<string, { schema?: unknown }> }> };
const spec = JSON.parse(readFileSync(path.join(root, "docs/openapi.json"), "utf8")) as { paths: Record<string, Record<string, Op>>; info: { description: string } };
const ops = Object.entries(spec.paths).flatMap(([p, v]) => Object.entries(v).map(([method, op]) => ({ method, path: p, op })));

describe("NFR-164 the API specification describes what every operation takes and answers", () => {
  it("is what the generator produces from the routes and schemas in the code", async () => {
    const srcDir = path.join(root, "src");
    const observed = JSON.parse(readFileSync(path.join(root, "docs/observed-responses.json"), "utf8"));
    const { spec: fresh } = generateOpenApiFromApp(createApp(), srcDir, await loadSchemaRegistry(srcDir), { title: "IST Health Tele-Triage API", version: "1.0.0", description: spec.info.description }, observed);
    expect(JSON.parse(JSON.stringify(fresh))).toEqual(spec);
  }, 60_000);

  it("gives every operation that changes something a request schema or says it takes no body", () => {
    const missing = ops.filter((o) => ["post", "put", "patch"].includes(o.method) && !o.op.requestBody && !o.op.description).map((o) => `${o.method} ${o.path}`);
    expect(missing).toEqual([]);
  });

  it("describes the answer of every read-only endpoint that was observed, and says which these are", () => {
    const withResponse = ops.filter((o) => o.op.responses["200"]?.content?.["application/json"]?.schema);
    expect(withResponse.length).toBeGreaterThanOrEqual(75);
    expect(spec.info.description).toContain("where the response was observed");
    const observed = JSON.parse(readFileSync(path.join(root, "docs/observed-responses.json"), "utf8")) as Record<string, unknown>;
    expect(withResponse.length).toBe(Object.keys(observed).length);
  });

  it("states honestly, in the document, what it does not yet cover", () => {
    const doc = readFileSync(path.join(root, "docs/api-specification-coverage.md"), "utf8");
    const total = ops.length;
    const withResponse = ops.filter((o) => o.op.responses["200"]?.content?.["application/json"]?.schema).length;
    expect(doc).toContain(`${total} operations`);
    expect(doc).toContain(`${withResponse} of them have a response schema`);
    expect(doc).toMatch(/not described by schema/);
  });
});

describe("request contracts for handlers that check their own body", () => {
  const names = Object.keys(contracts).filter((n) => n.endsWith("Schema"));
  it("are all found by the generator", async () => {
    const registry = await loadSchemaRegistry(path.join(root, "src"));
    for (const n of names) expect(registry[n]).toBeDefined();
  });
  it("are each used by the route that the marker or the handler names", () => {
    const sources = ["admin", "auth", "developerRouter", "integrationAdmin", "opsAdmin", "queueRouter", "safetyRouter", "noteTemplates"].map((f) => readFileSync(path.join(root, `src/routes/${f}.ts`), "utf8")).join("\n");
    for (const n of names) expect(sources.includes(n) || n === "NoteTemplateRenderBodySchema").toBe(true);
    for (const o of Object.values(ROUTE_OVERRIDES)) if (o.schemaName) expect(o.schemaName).toMatch(/Schema$/);
  });
  it("accept a valid sample and refuse an invalid one", () => {
    const { ElevateBodySchema, RevealDecisionBodySchema, ExportDecisionBodySchema, ExtractAckBodySchema, RetentionPolicyBodySchema, WebhookChangeBodySchema, EventRuleTestBodySchema, RedFlagsBodySchema, OauthTokenBodySchema } = contracts;
    expect(ElevateBodySchema.safeParse({ code: "123456" }).success).toBe(true);
    expect(ElevateBodySchema.safeParse({}).success).toBe(false);
    expect(RevealDecisionBodySchema.safeParse({ decision: "approved" }).success).toBe(true);
    expect(RevealDecisionBodySchema.safeParse({ decision: "approve" }).success).toBe(false);
    expect(ExportDecisionBodySchema.safeParse({ decision: "reject", comments: "no" }).success).toBe(true);
    expect(ExportDecisionBodySchema.safeParse({ decision: "maybe" }).success).toBe(false);
    expect(ExtractAckBodySchema.safeParse({ consumer: "bi", token: "t" }).success).toBe(true);
    expect(ExtractAckBodySchema.safeParse({ consumer: "bi" }).success).toBe(false);
    expect(RetentionPolicyBodySchema.safeParse({ days: 365, legalBasis: "Contract clause 4", decisionReference: "DEC-1" }).success).toBe(true);
    expect(RetentionPolicyBodySchema.safeParse({ days: 0, legalBasis: "x", decisionReference: "y" }).success).toBe(false);
    expect(WebhookChangeBodySchema.safeParse({ status: "paused" }).success).toBe(true);
    expect(WebhookChangeBodySchema.safeParse({ events: [] }).success).toBe(false);
    expect(EventRuleTestBodySchema.parse({ type: "x" }).risk).toBe("medium");
    expect(RedFlagsBodySchema.safeParse({ text: "chest pain" }).success).toBe(true);
    expect(RedFlagsBodySchema.safeParse({}).success).toBe(false);
    expect(OauthTokenBodySchema.safeParse({ grant_type: "password" }).success).toBe(false);
  });
});

describe("schema inference from observed answers", () => {
  it("describes values and merges what several answers show", () => {
    expect(inferSchema({ a: 1, b: "x", c: [1, 2], d: null })).toMatchObject({ type: "object", properties: { a: { type: "integer" }, b: { type: "string" }, c: { type: "array", items: { type: "integer" } }, d: { nullable: true } } });
    const merged = mergeSchemas(inferSchema({ a: 1, b: "x" }), inferSchema({ a: 2.5 })) as { required: string[]; properties: Record<string, { type: string }> };
    expect(merged.required).toEqual(["a"]);
    expect(merged.properties.a.type).toBe("number");
    expect(mergeSchemas(inferSchema({ a: 1 }), inferSchema({ a: "x" }))).toMatchObject({ properties: { a: { oneOf: expect.any(Array) } } });
    expect(inferSchema([])).toEqual({ type: "array", items: {} });
  });
});

describe("the deployment documents name only things that exist", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const docs = ["docs/operations/deployment-checklist.md", "docs/operations/tenant-first-run-checks.md"].map((d) => readFileSync(path.join(root, d), "utf8")).join("\n");
  it("uses only package scripts, files and commands that exist", async () => {
    const { existsSync } = await import("node:fs");
    for (const m of docs.matchAll(/pnpm run ([\w:-]+)|pnpm ([\w:-]+) /g)) {
      const name = m[1] ?? m[2];
      if (["exec", "run"].includes(name)) continue;
      expect(pkg.scripts[name]).toBeDefined();
    }
    for (const m of docs.matchAll(/`((?:scripts|src|prisma|terraform|docs)\/[\w./-]+\.[a-z]+)`/g)) expect(existsSync(path.join(root, m[1]))).toBe(true);
    for (const m of docs.matchAll(/node (scripts\/[\w.]+)|tsx (src\/scripts\/[\w.]+)/g)) expect(existsSync(path.join(root, m[1] ?? m[2]))).toBe(true);
  });
  it("says plainly that nothing has been deployed or planned", () => {
    expect(docs).toMatch(/Nothing here has been done/);
    expect(docs).toMatch(/Never run so far/);
    expect(docs).toMatch(/built but not proven at peak/);
  });
});
