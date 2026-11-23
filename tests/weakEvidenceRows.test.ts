import { readFileSync } from "node:fs";
import path from "node:path";
import { evaluate, Thresholds, DEFAULT_THRESHOLDS } from "../src/services/performanceMonitor.js";
import { MODES, ScheduleInput } from "../src/services/jobScheduler.js";
import { RETENTION_TARGETS } from "../src/services/retentionEngine.js";
import { handOffArchive, validateArchiveHandoffConfiguration } from "../src/services/archiveHandoff.js";

const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf8");
const openapi = JSON.parse(read("docs/openapi.json")) as { paths: Record<string, unknown> };
const paths = Object.keys(openapi.paths);
const tenant = (file: string) => read(`terraform/tenant-qatar-airways/${file}`);

describe("NFR-041 scheduled jobs: calendar, once, counted and user-triggered, listed, paused and resumed", () => {
  it("offers the four run modes the reply states", () => {
    expect([...MODES].sort()).toEqual(["cron", "manual", "once", "times"]);
  });
  it("requires what each mode needs", () => {
    const base = { name: "Nightly job", handler: "purge" };
    expect(ScheduleInput.safeParse({ ...base, mode: "cron" }).success).toBe(false);
    expect(ScheduleInput.safeParse({ ...base, mode: "cron", cron: "0 2 * * *" }).success).toBe(true);
    expect(ScheduleInput.safeParse({ ...base, mode: "once" }).success).toBe(false);
    expect(ScheduleInput.safeParse({ ...base, mode: "once", runAtIso: "2026-12-01T02:00:00Z" }).success).toBe(true);
    expect(ScheduleInput.safeParse({ ...base, mode: "times", cron: "0 2 * * *" }).success).toBe(false);
    expect(ScheduleInput.safeParse({ ...base, mode: "times", cron: "0 2 * * *", times: 5 }).success).toBe(true);
    expect(ScheduleInput.safeParse({ ...base, mode: "manual" }).success).toBe(true);
  });
  it("lists, pauses, resumes and runs schedules through the API", () => {
    for (const p of ["/api/v1/admin/ops/schedules", "/api/v1/admin/ops/schedules/{id}/enable", "/api/v1/admin/ops/schedules/{id}/disable", "/api/v1/admin/ops/schedules/{id}/run"]) {
      expect(paths).toContain(p);
    }
  });
  it("is triggered in production by Cloud Scheduler", () => {
    expect(tenant("jobs.tf")).toContain("google_cloud_scheduler_job");
  });
});

describe("NFR-126 non-interactive work runs asynchronously with a status API and retry", () => {
  it("exposes run status and cancel", () => {
    for (const p of ["/api/v1/admin/ops/runs", "/api/v1/admin/ops/runs/{id}", "/api/v1/admin/ops/runs/{id}/cancel"]) expect(paths).toContain(p);
  });
  it("retries with a bounded number of attempts", () => {
    const parsed = ScheduleInput.parse({ name: "Export job", handler: "export", mode: "manual" });
    expect(parsed.maxAttempts).toBe(3);
    expect(ScheduleInput.safeParse({ name: "Export job", handler: "export", mode: "manual", maxAttempts: 11 }).success).toBe(false);
  });
});

describe("NFR-132 alerts on p95 latency, error rate and queue backlog age, with thresholds Qatar Airways can set", () => {
  const rows = (over: Partial<{ requests: number; serverErrors: number; p95Ms: number }>) =>
    [{ method: "GET", route: "/api/v1/queue", requests: 100, serverErrors: 0, p95Ms: 100, ...over }] as unknown as Parameters<typeof evaluate>[1];
  const calm = { eventLoopLagMs: 0 } as unknown as Parameters<typeof evaluate>[2];

  it("raises a finding for latency and for errors, and stays quiet when both are within the thresholds", () => {
    expect(evaluate(DEFAULT_THRESHOLDS, rows({}), calm)).toEqual([]);
    expect(evaluate(DEFAULT_THRESHOLDS, rows({ p95Ms: 5000 }), calm).map((f) => f.kind)).toEqual(["latency"]);
    expect(evaluate(DEFAULT_THRESHOLDS, rows({ serverErrors: 20 }), calm).map((f) => f.kind)).toEqual(["errors"]);
  });
  it("uses the thresholds an administrator sets, and ignores routes with too little traffic", () => {
    const strict = { ...DEFAULT_THRESHOLDS, p95Ms: 50 };
    expect(evaluate(strict, rows({ p95Ms: 100 }), calm).map((f) => f.kind)).toEqual(["latency"]);
    expect(evaluate(strict, rows({ p95Ms: 100, requests: 5 }), calm)).toEqual([]);
  });
  it("rejects nonsensical thresholds", () => {
    expect(Thresholds.safeParse({ ...DEFAULT_THRESHOLDS, errorRate: 5 }).success).toBe(false);
    expect(Thresholds.safeParse({ ...DEFAULT_THRESHOLDS, p95Ms: -1 }).success).toBe(false);
  });
  it("lets an administrator read and change them in the application", () => {
    expect(paths).toContain("/api/v1/admin/ops/thresholds");
  });
  it("defines Cloud Monitoring alert policies for all three, with thresholds as variables", () => {
    const monitoring = tenant("monitoring.tf");
    const variables = tenant("variables.tf");
    for (const resource of ["latency_p95", "error_rate", "queue_backlog_age"]) expect(monitoring).toContain(`resource "google_monitoring_alert_policy" "${resource}"`);
    for (const variable of ["alert_p95_latency_ms", "alert_error_rate", "alert_queue_backlog_age_seconds"]) {
      expect(variables).toContain(`variable "${variable}"`);
      expect(monitoring).toContain(`var.${variable}`);
    }
    expect(monitoring).toContain("ALIGN_PERCENTILE_95");
  });
});

describe("NFR-055 purge after archive, per data type, with legal holds respected", () => {
  it("covers each data type with its own code, and clinical encounters can only go after an archive copy exists", () => {
    const codes = RETENTION_TARGETS.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    const encounter = RETENTION_TARGETS.find((t) => t.code === "AVIATION_TRIAGE_ENCOUNTER");
    expect(encounter).toMatchObject({ requiresArchive: true, archivable: true, holdResourceType: "AviationTriageEncounter" });
  });
  it("lets legal holds block clinical and case data", () => {
    const held = RETENTION_TARGETS.filter((t) => t.holdResourceType).map((t) => t.model);
    expect(held).toEqual(expect.arrayContaining(["TriageQueueItem", "AviationTriageEncounter"]));
  });
  it("never archives short-lived technical data", () => {
    for (const code of ["USER_SESSION_EXPIRED", "LOGIN_NONCE", "EXPORT_APPROVAL"]) expect(RETENTION_TARGETS.find((t) => t.code === code)?.archivable).toBe(false);
  });
});

describe("NFR-056 archive handoff to the designated system, IRISSTAR keeps no clinical archive", () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });
  it("does nothing, and says why, when no designated archive system is configured", async () => {
    process.env = { ...env };
    delete process.env.ARCHIVE_HANDOFF_URL;
    expect(await handOffArchive()).toMatchObject({ attempted: 0, handedOff: 0, skipped: expect.stringContaining("ARCHIVE_HANDOFF_URL") });
  });
  it("accepts only https, and in production requires the signing secret", () => {
    expect(() => validateArchiveHandoffConfiguration({ ARCHIVE_HANDOFF_URL: "http://archive.example/in", NODE_ENV: "production" })).toThrow(/https/);
    expect(() => validateArchiveHandoffConfiguration({ ARCHIVE_HANDOFF_URL: "https://archive.example/in", NODE_ENV: "production" })).toThrow(/SECRET/);
    expect(() => validateArchiveHandoffConfiguration({ ARCHIVE_HANDOFF_URL: "https://archive.example/in", NODE_ENV: "production", ARCHIVE_HANDOFF_SECRET: "x" })).not.toThrow();
    expect(() => validateArchiveHandoffConfiguration({ ARCHIVE_HANDOFF_URL: "not a url" })).toThrow(/valid URL/);
  });
});

describe("NFR-076 open standards are documented", () => {
  const guide = read("docs/customisation-guide.md");
  it("documents JSON over HTTPS, OpenAPI and CloudEvents", () => {
    for (const standard of ["JSON over HTTPS", "OpenAPI 3.0", "CloudEvents 1.0"]) expect(guide).toContain(standard);
  });
  it("states plainly that Kafka-compatible export and a Redis-protocol cache are not built", () => {
    expect(guide).toMatch(/Not built:\*\* Kafka-compatible export, a Redis-protocol cache/);
  });
});
