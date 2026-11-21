import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { disclosureConfig, renderDisclosurePage, renderSecurityTxt } from "../src/routes/securityTxt.js";
import { INTEGRATION_SPECS, renderDataFlowAssessment, renderIntegrationSpec } from "../src/services/integrationSpecs.js";
import { INTEGRATIONS } from "../src/services/integrationRegistry.js";
import { categorise, renderLicenceRegister, type Bom } from "../src/utils/licenceRegister.js";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("generated evidence documents match the code", () => {
  it("has the integration specification, data-flow assessment and licence register as generated", () => {
    expect(read("docs/integration-handoff-spec.md")).toBe(renderIntegrationSpec());
    expect(read("docs/compliance/data-flow-assessment.md")).toBe(renderDataFlowAssessment());
    expect(read("docs/licences/component-licence-register.md")).toBe(renderLicenceRegister(JSON.parse(read("docs/sbom/sbom.cdx.json")) as Bom));
  });

  it("specifies every integration in the registry, and no unknown one", () => {
    expect(INTEGRATION_SPECS.map((s) => s.name).sort()).toEqual(INTEGRATIONS.map((i) => i.name).sort());
    for (const s of INTEGRATION_SPECS) {
      expect(s.errors.length).toBeGreaterThan(20);
      expect(s.irisstarResponsible && s.customerResponsible).toBeTruthy();
    }
  });
});

describe("M-016 licences", () => {
  it("has no strong-copyleft or unknown licence among production components", () => {
    const bom = JSON.parse(read("docs/sbom/sbom.cdx.json")) as Bom;
    const bad = bom.components.filter((c) => ["strong-copyleft", "unknown"].includes(categorise(c.licenses?.[0]?.expression))).map((c) => `${c.name}@${c.version}`);
    expect(bad).toEqual([]);
  });

  it("sorts licences into the right categories", () => {
    expect(categorise("MIT")).toBe("permissive");
    expect(categorise("Apache-2.0")).toBe("permissive");
    expect(categorise("OFL-1.1")).toBe("font-licence");
    expect(categorise("MPL-2.0")).toBe("weak-copyleft");
    expect(categorise("LGPL-3.0")).toBe("weak-copyleft");
    expect(categorise("GPL-3.0-only")).toBe("strong-copyleft");
    expect(categorise("AGPL-3.0")).toBe("strong-copyleft");
    expect(categorise(undefined)).toBe("unknown");
    expect(categorise("SomethingElse-1.0")).toBe("unknown");
  });

  it("keeps the CI licence check in step with the families in use", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("OFL-1.1");
  });
});

describe("NFR-162 vulnerability disclosure pages", () => {
  const app = createApp();
  afterEach(() => { delete process.env.SECURITY_CONTACT; delete process.env.SECURITY_POLICY_URL; });

  it("serves nothing until a contact is set, so no public page points at an unread mailbox", async () => {
    await request(app).get("/.well-known/security.txt").expect(404);
    await request(app).get("/security/disclosure").expect(404);
  });

  it("serves RFC 9116 security.txt and the policy, publicly, once a contact is set", async () => {
    process.env.SECURITY_CONTACT = "security@example.com";
    const txt = await request(app).get("/.well-known/security.txt").set("Host", "triage.example.com").expect(200);
    expect(txt.type).toBe("text/plain");
    expect(txt.text).toMatch(/^Contact: mailto:security@example\.com$/m);
    expect(txt.text).toMatch(/^Expires: \d{4}-\d{2}-\d{2}T/m);
    expect(txt.text).toContain("Canonical: https://triage.example.com/.well-known/security.txt");
    expect(txt.text).toContain("Policy: https://triage.example.com/security/disclosure");
    const page = await request(app).get("/security/disclosure").expect(200);
    expect(page.text).toContain("Vulnerability disclosure policy");
    expect(page.text).toContain("security@example.com");
  });

  it("rejects a contact that is not an address or an https link, and escapes what it prints", () => {
    expect(disclosureConfig({ SECURITY_CONTACT: "not an address" } as never)).toBeUndefined();
    expect(disclosureConfig({ SECURITY_CONTACT: "http://insecure.example" } as never)).toBeUndefined();
    expect(disclosureConfig({ SECURITY_CONTACT: "https://example.com/report" } as never)?.contact).toBe("https://example.com/report");
    const cfg = disclosureConfig({ SECURITY_CONTACT: "https://example.com/r?a=1&b=<x>" } as never)!;
    expect(renderDisclosurePage(cfg)).not.toContain("<x>");
    expect(renderSecurityTxt(cfg, "h", new Date("2026-11-21T00:00:00Z"))).toContain("Expires: 2027-11-21");
  });
});

describe("F-001 licence usage", () => {
  const app = createApp();
  it("is closed to a nurse", async () => {
    process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
    const nurse = request.agent(app);
    await nurse.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
    await nurse.get("/api/v1/admin/ops/licence-usage").expect(403);
  });
});

describe("the documents keep to what the code does", () => {
  const files = (dir: string): string[] => readdirSync(path.join(root, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    return statSync(path.join(root, rel)).isDirectory() ? files(rel) : rel.endsWith(".md") ? [rel] : [];
  });
  const NEW_DOCS = [
    "docs/evidence-index.md", "docs/roadmap.md", "docs/quality-gates.md", "docs/browser-matrix.md", "docs/customisation-guide.md",
    "docs/security/owasp-asvs-mapping.md", "docs/security/penetration-test-scope-and-programme.md", "docs/security/vulnerability-and-patch-policy.md",
    "docs/security/zero-trust-alignment.md", "docs/security/vulnerability-disclosure-policy.md",
    "docs/operations/caching-and-freshness.md", "docs/operations/slos.md", "docs/operations/database-rollback.md", "docs/operations/manual-contingency-procedures.md",
    "docs/operations/availability-and-recovery.md", "docs/operations/release-and-environments.md", "docs/operations/performance-and-capacity.md", "docs/operations/alerts-and-dashboards.md",
    "docs/compliance/regulatory-applicability.md", "docs/compliance/sustainability.md", "docs/licences/stcc-licence-checklist.md", "docs/licences/open-source-consent-request.md",
    "docs/commercial/sponsor-and-team.md", "docs/accessibility/accessibility-self-evaluation.md",
    "docs/security/content-security-policy.md", "docs/security/human-approval-checkpoint.md", "docs/operations/background-jobs-and-database-isolation.md",
    "docs/performance/sizing-and-load-test.md", "docs/validation/handover-to-reshma.md"
  ];

  it("has every document the evidence index names", () => {
    const index = read("docs/evidence-index.md");
    for (const doc of NEW_DOCS.filter((d) => d !== "docs/evidence-index.md")) {
      expect(existsSync(path.join(root, doc))).toBe(true);
    }
    for (const m of index.matchAll(/`((?:[a-z-]+\/)*[a-z0-9-]+\.md)`/g)) {
      const candidates = [`docs/${m[1]}`, m[1]];
      expect(candidates.some((c) => existsSync(path.join(root, c)))).toBe(true);
    }
  });

  it("points only at files that exist", () => {
    const missing: string[] = [];
    for (const doc of NEW_DOCS) {
      for (const m of read(doc).matchAll(/`((?:docs|src|scripts|terraform|prisma|tests|frontend|\.github)\/[A-Za-z0-9_./@-]+\.[a-z0-9]+)`/g)) {
        if (!existsSync(path.join(root, m[1]))) missing.push(`${doc} -> ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("states the same patch service level everywhere it is stated", () => {
    for (const doc of ["docs/security/vulnerability-and-patch-policy.md", "docs/security/penetration-test-scope-and-programme.md", "docs/infrastructure/qatar-airways-tenant.md"]) {
      expect(read(doc)).toMatch(/30 calendar days/);
    }
  });

  it("leaves the commitments only management can make unfilled and says so", () => {
    const sponsor = read("docs/commercial/sponsor-and-team.md");
    expect(sponsor).toMatch(/Nothing in this file has been filled in/);
    expect(sponsor).toMatch(/| Name \| \|/);
    expect(read("docs/licences/open-source-consent-request.md")).toMatch(/Not sent/);
  });

  it("documents the session revocation interval the code uses", () => {
    expect(read("docs/operations/caching-and-freshness.md")).toContain("SESSION_REVOCATION_CHECK_SECONDS");
    const code = readFileSync(path.join(root, "src/services/securityAdmin.ts"), "utf8");
    expect(code).toContain('SESSION_REVOCATION_CHECK_SECONDS ?? 15');
  });

  it("never claims what has not happened", () => {
    for (const doc of NEW_DOCS) {
      const text = read(doc);
      expect(text).not.toMatch(/penetration test (was|has been) (completed|carried out|passed)/i);
      expect(text).not.toMatch(/WCAG 2\.1 AA conformant|fully conformant/i);
    }
    expect(files("docs").length).toBeGreaterThan(50);
  });
});
