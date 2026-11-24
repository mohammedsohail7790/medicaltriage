import { readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../src/app.js";
import { collectRoutes, generateOpenApiFromApp } from "../src/services/openApiGenerator.js";
import { loadSchemaRegistry } from "../src/services/schemaRegistry.js";

// NFR-164: the published specification is generated from the registered routes and cannot drift from them.
describe("OpenAPI generation", () => {
  const srcDir = path.resolve(process.cwd(), "src");
  const info = { title: "t", version: "1", description: "d" };

  it("documents every registered /api route", async () => {
    const app = createApp();
    const { spec } = generateOpenApiFromApp(app, srcDir, await loadSchemaRegistry(srcDir), info);
    const paths = (spec as { paths: Record<string, Record<string, unknown>> }).paths;
    for (const route of collectRoutes(app)) {
      expect(paths[route.path.replace(/:(\w+)/g, "{$1}")]?.[route.method]).toBeDefined();
    }
  });

  it("matches the committed docs/openapi.json (run `pnpm docs:openapi` after changing routes)", async () => {
    const committed = JSON.parse(readFileSync(path.resolve(process.cwd(), "docs", "openapi.json"), "utf8"));
    const { spec } = generateOpenApiFromApp(createApp(), srcDir, await loadSchemaRegistry(srcDir), committed.info, JSON.parse(readFileSync(path.resolve(process.cwd(), "docs", "observed-responses.json"), "utf8")));
    expect(Object.keys((spec as { paths: object }).paths).sort()).toEqual(Object.keys(committed.paths).sort());
    expect(JSON.stringify(spec)).toEqual(JSON.stringify(committed));
  });

  it("derives request bodies from the zod validators and never loses one", async () => {
    const { spec, stats } = generateOpenApiFromApp(createApp(), srcDir, await loadSchemaRegistry(srcDir), info);
    expect(stats.unresolvedSchemas).toEqual([]);
    expect(stats.withRequestSchema).toBeGreaterThanOrEqual(47);
    const queue = (spec as { components: { schemas: Record<string, { properties?: object }> } }).components.schemas;
    expect(Object.keys(queue).length).toBeGreaterThan(40);
  });

  it("keeps the count of write operations without a derived request schema from growing", async () => {
    const { spec } = generateOpenApiFromApp(createApp(), srcDir, await loadSchemaRegistry(srcDir), info);
    const paths = (spec as { paths: Record<string, Record<string, { requestBody?: unknown }>> }).paths;
    const missing = Object.values(paths).flatMap((ops) => Object.entries(ops).filter(([m, o]) => ["post", "put", "patch"].includes(m) && !o.requestBody));
    expect(missing.length).toBeLessThanOrEqual(35); // the rest take no body (see docs/api-specification-coverage.md)
  });
});
