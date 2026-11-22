import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

// These tests hold the configuration that the submitted replies describe. They check what the files
// say; they do not show the pipeline or the infrastructure has run.
describe("NFR-082 delivery pipeline carries the gates the reply lists", () => {
  const ci = read(".github/workflows/ci.yml");
  it.each([
    ["type check", /tsc -p tsconfig\.json --noEmit/],
    ["tests with coverage", /test:coverage/],
    ["dependency audit", /pnpm audit --audit-level high/],
    ["licence check", /license-checker/],
    ["SBOM", /cyclonedx/]
  ])("ci.yml runs the %s", (_name, pattern) => {
    expect(ci).toMatch(pattern);
  });
  it("has CodeQL and ZAP workflows", () => {
    expect(read(".github/workflows/codeql.yml")).toMatch(/codeql/i);
    expect(read(".github/workflows/zap-baseline.yml")).toMatch(/zap/i);
  });
});

describe("NFR-127 batch work runs as its own Cloud Run job", () => {
  it("the service delegates scheduling and the job and its trigger are defined", () => {
    expect(read("terraform/tenant-qatar-airways/run.tf")).toMatch(/SCHEDULER_MODE[\s\S]{0,80}external/);
    const jobs = read("terraform/tenant-qatar-airways/jobs.tf");
    expect(jobs).toMatch(/google_cloud_run_v2_job" "scheduler"/);
    expect(jobs).toMatch(/google_cloud_scheduler_job" "scheduler_tick"/);
  });
});
