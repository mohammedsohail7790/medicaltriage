import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { schedulerRunsInProcess } from "../src/services/jobScheduler.js";
import { SafetyKernelError, assertHumanApprovalForExport } from "../src/services/safetyKernel.js";
import { evidenceFiles, renderRegister, type ReplyRow } from "../scripts/generateValidationPack.js";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("AI-041 human approval before any write or message", () => {
  const saved = { node: process.env.NODE_ENV, mock: process.env.MOCK_MODE };
  afterEach(() => {
    process.env.NODE_ENV = saved.node;
    if (saved.mock === undefined) delete process.env.MOCK_MODE; else process.env.MOCK_MODE = saved.mock;
  });

  it("lets demonstration mode through outside production, as the demo does", async () => {
    process.env.MOCK_MODE = "true";
    await expect(assertHumanApprovalForExport("enc-1", "EMR_WRITEBACK")).resolves.toMatchObject({ mode: "mock-mode" });
  });

  it("does not let a production runtime skip the checkpoint because demonstration mode was left on", async () => {
    process.env.MOCK_MODE = "true";
    process.env.NODE_ENV = "production";
    await expect(assertHumanApprovalForExport(undefined, "CCP_SEND")).rejects.toBeInstanceOf(SafetyKernelError);
    await expect(assertHumanApprovalForExport(undefined, "EMR_WRITEBACK")).rejects.toMatchObject({ status: 403 });
  });

  it("names the enforcement points the document describes", () => {
    expect(read("src/integration/fhirWriteback.ts")).toContain('assertHumanApprovalForExport(encounterId, "EMR_WRITEBACK")');
    expect(read("src/services/ccpCommunication.ts")).toContain('"CCP_SEND"');
    expect(read("src/services/clinicalHandoff.ts")).toContain("SIGNED_APPROVAL_REQUIRED");
  });
});

describe("NFR-130 background jobs apart from interactive traffic", () => {
  it("runs scheduled jobs in the application unless told they run elsewhere", () => {
    expect(schedulerRunsInProcess({} as NodeJS.ProcessEnv)).toBe(true);
    expect(schedulerRunsInProcess({ SCHEDULER_MODE: "in-process" } as NodeJS.ProcessEnv)).toBe(true);
    expect(schedulerRunsInProcess({ SCHEDULER_MODE: "external" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("has the tenant service hand scheduling to a Cloud Run job started every minute", () => {
    const run = read("terraform/tenant-qatar-airways/run.tf");
    const jobs = read("terraform/tenant-qatar-airways/jobs.tf");
    expect(run).toMatch(/name\s*=\s*"SCHEDULER_MODE"\s*\n\s*value\s*=\s*"external"/);
    expect(jobs).toContain('resource "google_cloud_run_v2_job" "scheduler"');
    expect(jobs).toContain("dist/schedulerJob.js");
    expect(jobs).toMatch(/schedule\s*=\s*"\* \* \* \* \*"/);
    expect(jobs).toContain("run.googleapis.com/apis/run.googleapis.com/v1/namespaces");
    expect(read("terraform/tenant-qatar-airways/network.tf")).toContain("cloudscheduler.googleapis.com");
    expect(existsSync(path.join(root, "src/schedulerJob.ts"))).toBe(true);
  });

  it("gives the tenant its own database and scales the service from 2 to 20 instances", () => {
    expect(read("terraform/tenant-qatar-airways/sql.tf")).toContain('resource "google_sql_database_instance" "primary"');
    expect(read("terraform/tenant-qatar-airways/run.tf")).toMatch(/min_instance_count = 2\s*\n\s*max_instance_count = 20/);
  });
});

describe("NFR-152 content security policy", () => {
  it("documents the policy the service actually sends", async () => {
    const res = await request(createApp()).get("/");
    const header = res.headers["content-security-policy"] as string;
    expect(header).toBeTruthy();
    const doc = read("docs/security/content-security-policy.md");
    for (const directive of header.split(";").map((d) => d.trim()).filter(Boolean)) expect(doc).toContain(directive);
    // The stated limit must stay true: if inline styles stop being allowed the document must be updated.
    expect(header.includes("style-src 'self' 'unsafe-inline'")).toBe(doc.includes("inline styles are allowed"));
    expect(header).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
  });
});

describe("AI-002 dynamic security testing is scheduled", () => {
  it("probes and scans on every change, and probes weekly", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/\n  dast:/);
    expect(ci).toContain("node scripts/dastProbe.mjs http://localhost:8080");
    expect(ci).toContain("zaproxy/action-baseline");
    const weekly = read(".github/workflows/dast-probe.yml");
    expect(weekly).toMatch(/cron:\s*"\d+ \d+ \* \* 1"/);
    expect(weekly).toContain("scripts/dastProbe.mjs");
  });
});

describe("the reply verification register", () => {
  const rows = JSON.parse(read("docs/validation/reply-register.json")) as ReplyRow[];

  it("has a row for every submitted reply, all submitted as Comply, and the generated files are current", () => {
    expect(rows).toHaveLength(173);
    expect(new Set(rows.map((r) => r.id)).size).toBe(173);
    const { md, csv } = renderRegister(rows, (p) => existsSync(path.join(root, p)));
    expect(read("docs/validation/reply-verification-register.md")).toBe(md);
    expect(read("docs/validation/reply-verification-register.csv")).toBe(csv);
  });

  it("names only files that exist", () => {
    const missing = rows.flatMap((r) => evidenceFiles(r.evidence).filter((f) => !existsSync(path.join(root, f))).map((f) => `${r.id}: ${f}`));
    expect(missing).toEqual([]);
  });

  it("says plainly that a named file is not proof", () => {
    expect(read("docs/validation/reply-verification-register.md")).toMatch(/does \*\*not\*\* prove that a reply is true/);
  });
});

describe("the side-by-side comparison tool", () => {
  it("finds no difference when a build is compared with itself", async () => {
    process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
    const servers = [createApp().listen(0, "127.0.0.1"), createApp().listen(0, "127.0.0.1")];
    try {
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => (s.listening ? resolve() : s.once("listening", () => resolve())))));
      const [a, b] = servers.map((s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`);
      const { execFileSync } = await import("node:child_process");
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(path.join(tmpdir(), "compare-"));
      try {
        const outFile = path.join(dir, "out.json");
        execFileSync("node", ["scripts/compareBuilds.mjs", a, b, outFile], { cwd: root, env: { ...process.env, COMPARE_PASSWORD: process.env.ADMIN_PASSWORD, COMPARE_ACCOUNTS: "layla@irisstar.tech:remote_triage_nurse" }, timeout: 120000, stdio: "pipe" });
        const result = JSON.parse(readFileSync(outFile, "utf8")) as { endpointsTried: number; counts: Record<string, number>; differences: unknown[] };
        expect(result.endpointsTried).toBeGreaterThan(50);
        expect(Object.keys(result.counts)).toEqual(["same"]);
        expect(result.differences).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      servers.forEach((s) => s.close());
    }
  }, 150_000);

  it("is documented with the figures it produced", () => {
    const handover = read("docs/validation/handover-to-reshma.md");
    const result = JSON.parse(read("docs/validation/side-by-side-baseline-soc2-1cb733d.json")) as { endpointsTried: number; counts: Record<string, number> };
    const total = Object.values(result.counts).reduce((x, y) => x + y, 0);
    expect(handover).toContain(`called ${result.endpointsTried} read-only endpoints each: ${total} comparisons`);
    expect(handover).toContain(`${result.counts.same} gave the same status`);
    expect(handover).toContain(`${result.counts["new in sprint build"]} are endpoints that exist only`);
  });
});

