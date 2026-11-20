import { authenticator } from "otplib";
import request from "supertest";
import { createApp } from "../src/app.js";
import { recordInterfaceCall, evaluateInterfaces, interfaceStats, interfaceThresholds, resetInterfaceStatsForTests, checkInterfaces } from "../src/integration/interfaceStats.js";
import { setExternalClientForTests, callExternal } from "../src/integration/externalClient.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { DEFAULT_VOLUME, volumeDip } from "../src/services/businessMetrics.js";
import { resetClinicalWorkForTests } from "../src/services/clinicalWork.js";
import { clearSubscribersForTests, subscribe } from "../src/services/eventBus.js";
import { diagnoseFailure } from "../src/services/failureDiagnosis.js";
import { JOB_RUNBOOKS, renderRunbooks, runbookFor } from "../src/services/jobRunbooks.js";
import { createSchedule, runNow, schedulerHandlerNames, registerSchedulerHandler, setSchedulerSleepForTests } from "../src/services/jobScheduler.js";
import { registerSchedulerHandlers } from "../src/services/schedulerHandlers.js";
import { registerPlatformSubscribers } from "../src/services/platformEvents.js";
import { RETENTION_TARGETS } from "../src/services/retentionEngine.js";
import { confirmMfaEnrollment, enrollMfa, resetSecurityStoreForTests } from "../src/services/securityAdmin.js";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
registerSchedulerHandlers();

describe("NFR-045 failure reason and likely cause", () => {
  it.each([
    ["connect ECONNREFUSED 10.0.0.1:443", "network"],
    ["The operation was aborted due to timeout", "timeout"],
    ["HTTP 401", "authentication"],
    ["HTTP 429", "rate_limit"],
    ["HTTP 503", "remote_error"],
    ["HTTP 422", "remote_error"],
    ["Invalid `prisma.x()` invocation P2002", "database"],
    ["QHIE_BASE_URL is not set", "configuration"],
    ["Cancelled.", "cancelled"],
    ["something odd", "unknown"]
  ])("reads %s as %s", (message, category) => {
    const d = diagnoseFailure(message);
    expect(d.category).toBe(category);
    expect(d.likelyCause.length).toBeGreaterThan(10);
    expect(d.firstCheck.length).toBeGreaterThan(10);
  });

  it("puts the reason and cause on a failed run and in the alert event", async () => {
    clearSubscribersForTests();
    resetClinicalWorkForTests();
    setSchedulerSleepForTests(async () => undefined);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    subscribe({ name: "t", handle: async (e) => { events.push({ type: e.type, data: e.data }); } });
    registerSchedulerHandler("test.fail", async () => { throw new Error("connect ECONNREFUSED 10.1.1.1:443"); });
    const s = await createSchedule({ name: "Failing job", handler: "test.fail", mode: "manual", timezone: "UTC", priority: "non_critical", maxAttempts: 1, params: {} }, "u");
    const run = await runNow(s.id);
    expect(run.status).toBe("failed");
    expect(run.diagnosis).toMatchObject({ category: "network" });
    expect(events[0]).toMatchObject({ type: "job.failed", data: { reason: expect.stringContaining("ECONNREFUSED"), category: "network", likelyCause: expect.any(String), firstCheck: expect.any(String) } });
    setSchedulerSleepForTests(undefined);
  });
});

describe("NFR-112 a runbook for every job", () => {
  it("has an entry for every scheduler handler and every queue handler", () => {
    for (const name of [...schedulerHandlerNames().filter((n) => !n.startsWith("test.")), "emr.writeback", "email.send"]) {
      const r = runbookFor(name);
      expect(r).toBeDefined();
      expect(r!.whenItFails.length).toBeGreaterThan(0);
    }
  });

  it("is published in the repository and in the handler list", () => {
    expect(readFileSync(path.resolve(process.cwd(), "docs/operations/job-runbooks.md"), "utf8")).toBe(renderRunbooks());
    expect(Object.keys(JOB_RUNBOOKS)).toEqual(expect.arrayContaining(["integrity.check", "emr.writeback"]));
  });

  it("warns that a replay of an email can send it twice", () => {
    expect(JOB_RUNBOOKS["email.send"].safeToRerun).toBe(false);
  });
});

describe("NFR-111 interface monitoring", () => {
  beforeEach(() => { resetInterfaceStatsForTests(); clearSubscribersForTests(); });
  afterEach(() => setExternalClientForTests(undefined));

  it("records every outbound call and flags a slow or failing interface, ignoring one with too few calls", () => {
    for (let i = 0; i < 10; i += 1) recordInterfaceCall("qhie", 5000, true);
    for (let i = 0; i < 10; i += 1) recordInterfaceCall("emr-fhir", 100, i < 4);
    for (let i = 0; i < 3; i += 1) recordInterfaceCall("rare", 9000, false);
    const found = evaluateInterfaces();
    expect(found.map((f) => `${f.integration}:${f.kind}`).sort()).toEqual(["emr-fhir:failing", "qhie:slow"]);
    expect(interfaceThresholds("qhie", { INTERFACE_QHIE_P95_MS: "8000" } as never).p95Ms).toBe(8000);
    expect(evaluateInterfaces(interfaceStats(), { INTERFACE_QHIE_P95_MS: "8000" } as never).some((f) => f.integration === "qhie")).toBe(false);
  });

  it("raises an interface.degraded event the alert rules can route", async () => {
    const seen: string[] = [];
    subscribe({ name: "t", handle: async (e) => { seen.push(`${e.type}:${e.subject}`); } });
    for (let i = 0; i < 8; i += 1) recordInterfaceCall("twilio", 100, false);
    expect((await checkInterfaces()).ok).toBe(false);
    expect(seen).toEqual(["interface.degraded:twilio"]);
  });

  it("is fed by the shared outbound client", async () => {
    setExternalClientForTests({ fetch: async () => new Response("ok", { status: 200 }) });
    await callExternal("probe-system", "https://probe.example/health", {}, { attempts: 1 });
    setExternalClientForTests({ fetch: async () => new Response("no", { status: 503 }) });
    await callExternal("probe-system", "https://probe.example/health", {}, { attempts: 1 });
    expect(interfaceStats().find((s) => s.integration === "probe-system")).toMatchObject({ calls: 2, failures: 1 });
  });
});

describe("NFR-107 call-volume dips", () => {
  const HOUR = 3_600_000;
  const now = new Date("2026-11-21T12:30:00Z");
  const hourStart = Math.floor(now.getTime() / HOUR) * HOUR - HOUR;
  const at = (weeksAgo: number, n: number) => Array.from({ length: n }, (_, i) => hourStart - weeksAgo * 7 * 24 * HOUR + i * 1000);

  it("raises nothing until two weeks of traffic exist", () => {
    const young = [...at(0, 1), ...at(1, 20), ...at(0, 1).map((t) => t - 6 * 24 * HOUR)];
    expect(volumeDip(young, now).status).toBe("baseline_not_ready");
  });

  it("compares with the same hour in earlier weeks and flags a fall below half", () => {
    const history = [...at(1, 40), ...at(2, 44), ...at(3, 38), ...at(4, 42), ...Array.from({ length: 3 }, (_, i) => hourStart - 20 * 24 * HOUR + i)];
    const quiet = volumeDip([...history, ...at(0, 10)], now);
    expect(quiet).toMatchObject({ status: "dip", observed: 10, baseline: 41 });
    expect(volumeDip([...history, ...at(0, 35)], now).status).toBe("ok");
  });

  it("does not judge an hour that is normally almost empty", () => {
    const small = [...at(1, 2), ...at(2, 3), ...at(3, 2), ...Array.from({ length: 3 }, (_, i) => hourStart - 20 * 24 * HOUR + i)];
    expect(volumeDip(small, now, { ...DEFAULT_VOLUME }).status).toBe("ok");
  });
});

describe("NFR-108 / NFR-109 log purge and archive", () => {
  it("includes the interface log among the data types purged on an approved policy, archived first", () => {
    const t = RETENTION_TARGETS.find((x) => x.code === "INTERFACE_LOG");
    expect(t).toMatchObject({ model: "InterfaceLog", archivable: true });
  });
});

describe("operations endpoints", () => {
  const app = createApp();
  beforeEach(() => { resetSecurityStoreForTests(); resetRateLimitBucketsForTests(); registerPlatformSubscribers(); });
  async function admin() {
    const agent = request.agent(app);
    await agent.post("/api/v1/auth/login").send({ username: "rishma@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);
    const { secret } = enrollMfa("usr_platform_admin_10001");
    confirmMfaEnrollment("usr_platform_admin_10001", authenticator.generate(secret));
    return agent;
  }

  it("serves interface statistics, the volume figure and the runbooks to an administrator", async () => {
    const a = await admin();
    recordInterfaceCall("qhie", 50, true);
    expect((await a.get("/api/v1/admin/ops/interfaces").expect(200)).body.interfaces.some((i: { integration: string }) => i.integration === "qhie")).toBe(true);
    expect((await a.get("/api/v1/admin/ops/volume").expect(200)).body.status).toBe("baseline_not_ready");
    const handlers = (await a.get("/api/v1/admin/ops/handlers").expect(200)).body;
    expect(handlers.runbooks["integrity.check"].title).toMatch(/Integrity/);
  });
});
