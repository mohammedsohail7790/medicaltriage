import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { renderCatalogue, scanErrorCodes } from "../src/utils/errorCodeScan.js";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const pkg = JSON.parse(read("package.json"));

describe("NFR-099 / NFR-100 supported runtime and component inventory", () => {
  it("uses one supported Node major in the container, CI, the declared engine and the lifecycle record", () => {
    const docker = [...read("Dockerfile").matchAll(/FROM node:(\d+)/g)].map((m) => m[1]);
    const ci = [...read(".github/workflows/ci.yml").matchAll(/node-version:\s*(\d+)/g)].map((m) => m[1]);
    const life = JSON.parse(read("docs/operations/component-lifecycle.json"));
    const tracked = life.components.find((c: { name: string }) => c.name === "node").track;
    const engine = /(\d+)/.exec(pkg.engines.node)![1];
    expect(new Set([...docker, ...ci, tracked, engine])).toEqual(new Set([tracked]));
  });

  it("keeps an inventory entry for each tracked component, and records when it was reviewed", () => {
    const md = read("docs/supported-components.md");
    const life = JSON.parse(read("docs/operations/component-lifecycle.json"));
    for (const c of life.components) expect(md).toContain(`| ${c.name} |`);
    expect(life.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(life.verifiedAgainstVendorPages).toBe(false);
  });

  it("tracks the major version of each tracked package that is a direct dependency", () => {
    const life = JSON.parse(read("docs/operations/component-lifecycle.json"));
    for (const c of life.components.filter((x: { kind: string }) => x.kind === "package")) {
      const range: string | undefined = pkg.dependencies?.[c.name] ?? pkg.devDependencies?.[c.name];
      if (!range || c.track === "0") continue;
      expect(`${c.name}@${/(\d+)/.exec(range)![1]}`).toBe(`${c.name}@${c.track}`);
    }
  });
});

describe("NFR-156 software bill of materials", () => {
  it("is CycloneDX 1.5 and lists every direct production dependency with a package URL", () => {
    expect(existsSync(path.join(root, "docs/sbom/sbom.cdx.json"))).toBe(true);
    const bom = JSON.parse(read("docs/sbom/sbom.cdx.json"));
    expect(bom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.5" });
    const names = new Set(bom.components.map((c: { name: string }) => c.name));
    for (const dep of Object.keys(pkg.dependencies)) expect(names.has(dep)).toBe(true);
    expect(bom.components.every((c: { purl: string; version: string }) => c.purl.startsWith("pkg:npm/") && c.version)).toBe(true);
    expect(bom.dependencies.length).toBeGreaterThan(bom.components.length / 2);
  });
});

describe("NFR-114 error codes and manual diagnosis", () => {
  it("documents every error code the source can return", () => {
    const codes = scanErrorCodes();
    expect(codes.length).toBeGreaterThan(100);
    const committed = read("docs/operations/error-catalogue.md");
    const missing = codes.filter((c) => !committed.includes(`\`${c.code}\``)).map((c) => c.code);
    expect(missing).toEqual([]);
    expect(renderCatalogue(codes)).toBe(committed);
  });
});

describe("NFR-085 observability checklist for customisations", () => {
  // Routers that only read, or that record their own audit trail through a service, are listed with the reason.
  const NO_DIRECT_AUDIT: Record<string, string> = {
    "apiDocsRouter.ts": "serves the specification",
    "developerRouter.ts": "public registration; the service audits",
    "helpRouter.ts": "help content",
    "me.ts": "reads the caller's own profile",
    "meRouter.ts": "reads the caller's own profile",
    "protocols.ts": "reads content; rule changes audited here",
    "search.ts": "read-only search",
    "staff.ts": "directory validation; the service audits",
    "queueRouter.ts": "the queue service audits every change",
    "triage.ts": "the persistence service audits",
    "simulation.ts": "simulation only",
    "voiceAssessment.ts": "the service audits",
    "hrms.ts": "the sync service audits",
    "callCenterGateway.ts": "the gateway service audits",
    "ccp.ts": "the communication service audits",
    "emr.ts": "the write-back service audits",
    "feedback.ts": "feedback capture",
    "approvalRouter.ts": "the approval service audits",
    "auth.ts": "the security service audits sign-in events",
    "admin.ts": "the security service audits"
  };

  it("has every route file either recording its own audit events or named, with a reason, as audited by its service", () => {
    const files = readdirSync(path.join(root, "src/routes")).filter((f) => f.endsWith(".ts"));
    const offenders = files.filter((f) => !read(`src/routes/${f}`).includes("recordAuditEvent") && !(f in NO_DIRECT_AUDIT));
    expect(offenders).toEqual([]);
  });

  it("applies request counting, tracing and analytics before any API route is mounted", () => {
    const app = read("src/app.ts");
    const firstApiRoute = app.indexOf('app.use("/api/v1/auth"');
    for (const middleware of ["requestDurationLogger()", "requestCounter()", "tracingMiddleware()", "apiAnalytics()"]) {
      const at = app.indexOf(middleware);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(firstApiRoute);
    }
  });

  it("states the checklist in the customisation guide", () => {
    const guide = read("docs/customisation-guide.md");
    for (const item of ["Logs", "Metrics", "Alerts", "Traces"]) expect(guide).toContain(item);
  });
});
