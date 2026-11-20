import { authenticator } from "otplib";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { resetClinicalWorkForTests } from "../src/services/clinicalWork.js";
import { ScheduleInput, cancelRun, createSchedule, getRun, idle, listRuns, listSchedules, nextCronTime, parseCron, registerSchedulerHandler, runNow, setScheduleEnabled, setSchedulerSleepForTests, tick } from "../src/services/jobScheduler.js";
import { registerSchedulerHandlers } from "../src/services/schedulerHandlers.js";
import { setResourceStatusForTests } from "../src/services/resourceGuard.js";
import { confirmMfaEnrollment, enrollMfa, resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
registerSchedulerHandlers();

const base = { name: "Nightly check", handler: "test.count", timezone: "UTC" as const, priority: "non_critical" as const, maxAttempts: 3, params: {} };
let calls = 0;
let failTimes = 0;
registerSchedulerHandler("test.count", async () => {
  calls += 1;
  if (failTimes > 0) {
    failTimes -= 1;
    throw new Error("boom");
  }
  return { n: calls };
});

beforeEach(() => {
  resetClinicalWorkForTests();
  calls = 0;
  failTimes = 0;
  setSchedulerSleepForTests(async () => undefined);
  setResourceStatusForTests(undefined);
});
afterEach(() => setSchedulerSleepForTests(undefined));

describe("cron", () => {
  it("accepts ranges, lists and steps, and rejects bad expressions", () => {
    expect(parseCron("*/15 0-6 * * 1,3").minute.size).toBe(4);
    expect(() => parseCron("* * *")).toThrow(/five fields/);
    expect(() => parseCron("61 * * * *")).toThrow(/outside/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
  });

  it("finds the next time, in UTC and in Qatar time", () => {
    const from = new Date("2026-11-20T10:07:30Z");
    expect(nextCronTime("*/15 * * * *", from)?.toISOString()).toBe("2026-11-20T10:15:00.000Z");
    expect(nextCronTime("0 6 * * *", from)?.toISOString()).toBe("2026-11-21T06:00:00.000Z");
    // 06:00 in Qatar (UTC+3) is 03:00 UTC.
    expect(nextCronTime("0 6 * * *", from, "Asia/Qatar")?.toISOString()).toBe("2026-11-21T03:00:00.000Z");
    // First of the month at midnight; and a Sunday.
    expect(nextCronTime("0 0 1 * *", from)?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(nextCronTime("30 8 * * 0", from)?.toISOString()).toBe("2026-11-22T08:30:00.000Z");
    expect(nextCronTime("0 0 30 2 *", from)).toBeUndefined();
  });
});

describe("modes, runs and history", () => {
  const user = "usr_admin";

  it("validates what each mode needs", () => {
    expect(ScheduleInput.safeParse({ ...base, mode: "cron" }).success).toBe(false);
    expect(ScheduleInput.safeParse({ ...base, mode: "once" }).success).toBe(false);
    expect(ScheduleInput.safeParse({ ...base, mode: "times", cron: "* * * * *" }).success).toBe(false);
    expect(ScheduleInput.safeParse({ ...base, mode: "manual" }).success).toBe(true);
    expect(ScheduleInput.safeParse({ ...base, mode: "cron", cron: "bad" }).success).toBe(false);
  });

  it("runs a one-off schedule once, at its date and time, and then ends it", async () => {
    const at = new Date("2026-11-21T09:00:00Z");
    const s = await createSchedule({ ...base, mode: "once", runAtIso: at.toISOString() }, user, new Date("2026-11-20T00:00:00Z"));
    expect(await tick(new Date("2026-11-20T12:00:00Z"))).toEqual({ started: [], deferred: [] });
    expect((await tick(at)).started).toEqual([s.id]);
    await idle();
    expect(calls).toBe(1);
    expect(await tick(new Date("2026-11-22T00:00:00Z"))).toEqual({ started: [], deferred: [] });
    expect((await listSchedules()).find((x) => x.id === s.id)?.status).toBe("completed");
  });

  it("runs a repeating schedule on its calendar times, and a counted one only that many times", async () => {
    const start = new Date("2026-11-20T10:00:00Z");
    const repeating = await createSchedule({ ...base, name: "Every five", mode: "cron", cron: "*/5 * * * *" }, user, start);
    const counted = await createSchedule({ ...base, name: "Twice only", mode: "times", cron: "*/5 * * * *", times: 2 }, user, start);
    let now = start;
    for (let i = 0; i < 4; i += 1) {
      now = new Date(now.getTime() + 5 * 60_000);
      await tick(now);
      await idle();
    }
    const runs = await listRuns();
    expect(runs.filter((r) => r.scheduleId === repeating.id)).toHaveLength(4);
    expect(runs.filter((r) => r.scheduleId === counted.id)).toHaveLength(2);
    expect((await listSchedules()).find((x) => x.id === counted.id)?.status).toBe("completed");
  });

  it("never starts a manual schedule on its own, but runs it when a user triggers it, recording the run", async () => {
    const s = await createSchedule({ ...base, mode: "manual" }, user);
    expect(await tick(new Date("2030-01-01T00:00:00Z"))).toEqual({ started: [], deferred: [] });
    const run = await runNow(s.id);
    expect(run).toMatchObject({ status: "succeeded", trigger: "manual", attempts: 1, error: null });
    expect(run.startedAtIso).toBeTruthy();
    expect(run.endedAtIso).toBeTruthy();
    expect(run.durationMs).not.toBeNull();
    expect(await listRuns(s.id)).toHaveLength(1);
  });

  it("retries a failing run with back-off, shows the attempts, and fails it after the last one", async () => {
    const waits: number[] = [];
    setSchedulerSleepForTests(async (ms) => { waits.push(ms); });
    const s = await createSchedule({ ...base, mode: "manual", maxAttempts: 3 }, user);
    failTimes = 2;
    expect(await runNow(s.id)).toMatchObject({ status: "succeeded", attempts: 3 });
    expect(waits).toEqual([1000, 2000]);
    failTimes = 5;
    const failed = await runNow(s.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 3, error: "boom", maxAttempts: 3 });
  });

  it("cancels a running execution", async () => {
    const s = await createSchedule({ ...base, handler: "demo.wait", mode: "manual", params: { ms: 30_000 } }, user);
    const started = await runNow(s.id, { wait: false });
    expect(started.status).toBe("running");
    const cancelled = await cancelRun(started.id);
    await idle();
    expect((await getRun(started.id))?.status).toBe("cancelled");
    expect(cancelled.id).toBe(started.id);
    await expect(cancelRun(started.id)).rejects.toMatchObject({ code: "RUN_NOT_RUNNING" });
  });

  it("can be switched off and on, and refuses an unknown handler", async () => {
    const s = await createSchedule({ ...base, mode: "cron", cron: "* * * * *" }, user, new Date("2026-11-20T10:00:00Z"));
    await setScheduleEnabled(s.id, false);
    expect(await tick(new Date("2026-11-20T11:00:00Z"))).toEqual({ started: [], deferred: [] });
    await setScheduleEnabled(s.id, true);
    await expect(createSchedule({ ...base, handler: "nope", mode: "manual" }, user)).rejects.toMatchObject({ code: "SCHEDULE_HANDLER_UNKNOWN" });
  });
});

describe("NFR-039 queueing under pressure", () => {
  it("defers non-critical jobs while the instance is constrained, and still runs critical ones", async () => {
    const start = new Date("2026-11-20T10:00:00Z");
    const soft = await createSchedule({ ...base, name: "Soft", mode: "cron", cron: "* * * * *", priority: "non_critical" }, "u", start);
    const hard = await createSchedule({ ...base, name: "Hard", mode: "cron", cron: "* * * * *", priority: "critical" }, "u", start);
    setResourceStatusForTests({ eventLoopLagMs: 900 });
    const now = new Date(start.getTime() + 60_000);
    const result = await tick(now);
    await idle();
    expect(result.deferred).toEqual([soft.id]);
    expect(result.started).toEqual([hard.id]);
    expect((await listSchedules()).find((x) => x.id === soft.id)?.deferrals).toBe(1);
    // Once the pressure eases, the deferred job runs.
    setResourceStatusForTests(undefined);
    expect((await tick(new Date(now.getTime() + 1000))).started).toContain(soft.id);
    await idle();
  });
});

describe("admin routes", () => {
  const app = createApp();
  beforeEach(() => {
    resetSecurityStoreForTests();
    resetRateLimitBucketsForTests();
  });

  async function elevated() {
    const agent = request.agent(app);
    await agent.post("/api/v1/auth/login").send({ username: "rishma@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);
    const { secret } = enrollMfa("usr_platform_admin_10001");
    confirmMfaEnrollment("usr_platform_admin_10001", authenticator.generate(secret));
    await agent.post("/api/v1/admin/elevate").send({ code: authenticator.generate(secret) }).expect(200);
    return agent;
  }

  it("creates a schedule, runs it asynchronously, and lets the run be polled and listed", async () => {
    const a = await elevated();
    const made = await a.post("/api/v1/admin/ops/schedules").send({ name: "Wait a moment", handler: "demo.wait", mode: "manual", params: { ms: 50 } }).expect(201);
    const id = made.body.schedule.id;
    const started = await a.post(`/api/v1/admin/ops/schedules/${id}/run?async=true`).expect(202);
    expect(started.body.run.status).toBe("running");
    await idle();
    const polled = await a.get(`/api/v1/admin/ops/runs/${started.body.run.id}`).expect(200);
    expect(polled.body.run.status).toBe("succeeded");
    const viaJobs = await a.get(`/api/v1/jobs/${started.body.run.id}`).expect(200);
    expect(viaJobs.body.job).toMatchObject({ type: "scheduled-run", status: "succeeded" });
    expect((await a.get("/api/v1/admin/ops/runs").query({ scheduleId: id }).expect(200)).body.runs).toHaveLength(1);
    expect((await a.get("/api/v1/admin/ops/handlers").expect(200)).body.handlers).toContain("demo.wait");
    await a.get("/api/v1/admin/ops/resources").expect(200);
  });

  it("needs elevation to change anything and a valid schedule", async () => {
    const a = await elevated();
    await a.post("/api/v1/admin/ops/schedules").send({ name: "x", handler: "demo.wait", mode: "cron" }).expect(400);
    await a.post("/api/v1/admin/de-elevate").expect(200);
    await a.post("/api/v1/admin/ops/schedules").send({ name: "Another one", handler: "demo.wait", mode: "manual" }).expect(403);
  });

  it("shows job status to the nurse who started the work and hides it from others", async () => {
    const nurse = request.agent(app);
    await nurse.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
    await nurse.get("/api/v1/jobs/does-not-exist").expect(404);
  });
});
