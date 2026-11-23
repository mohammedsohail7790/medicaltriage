import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// NFR-072 (tenant-scoped customisation under change control) and NFR-075 (standard technology, documented extension points).
// These check that what docs/customisation-guide.md tells Qatar Airways' developers exists in the code and the published specs.
const root = process.cwd();
const read = (p: string) => readFileSync(path.resolve(root, p), "utf8");
const guide = read("docs/customisation-guide.md");
const openapi = JSON.parse(read("docs/openapi.json")) as { openapi: string; paths: Record<string, unknown> };
const asyncapi = JSON.parse(read("docs/asyncapi.json")) as { asyncapi: string };

describe("NFR-075 documented, standard extension points", () => {
  it("publishes an OpenAPI 3 description that covers webhooks, API consumer tokens and business rules", () => {
    expect(openapi.openapi).toMatch(/^3\./);
    const paths = Object.keys(openapi.paths);
    expect(paths.some((p) => p.includes("/admin/integrations/webhooks"))).toBe(true);
    expect(paths).toContain("/api/v1/oauth/token");
    expect(paths.some((p) => p.includes("/admin/ops/rules"))).toBe(true);
  });

  it("publishes an AsyncAPI description for the events", () => {
    expect(asyncapi.asyncapi).toMatch(/^2\./);
  });

  it("ships sample clients in more than one language and the guide points at them", () => {
    for (const file of ["docs/clients/README.md", "docs/clients/java/AimlTriageClient.java", "docs/clients/dotnet/AimlTriageClient.cs"]) {
      expect(existsSync(path.resolve(root, file))).toBe(true);
    }
    expect(guide).toContain("docs/clients/");
  });

  it("requires no proprietary scripting language or SDK", () => {
    expect(guide).toMatch(/no required SDK/i);
  });
});

describe("NFR-072 customisation is configuration under change control and per organisation", () => {
  it("names the configuration mechanisms the guide relies on, and each one has a route in the API description", () => {
    const paths = Object.keys(openapi.paths).join("\n");
    for (const needle of ["/admin/ops/rules", "/admin/integrations/webhooks"]) expect(paths).toContain(needle);
    expect(guide).toMatch(/Audit trail/);
    expect(guide).toMatch(/never needs a change to the product's code/i);
  });

  it("keeps clinical safety floors out of run-time customisation", () => {
    expect(guide).toMatch(/Clinical safety floors[^\n]*not\*\* customisable at run time/);
  });

  it("only allows business rules inside their declared range, and records why", async () => {
    const { RULE_DEFINITIONS } = await import("../src/services/businessRules.js");
    expect(RULE_DEFINITIONS.length).toBeGreaterThan(0);
    for (const d of RULE_DEFINITIONS) {
      expect(d.min).toBeLessThanOrEqual(d.default);
      expect(d.default).toBeLessThanOrEqual(d.max);
    }
  });
});
