import { execFile } from "node:child_process";
import path from "node:path";

// NFR-130: the scheduler job runs a due schedule outside the API and records the run. Skipped without DATABASE_URL.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
process.env.PLATFORM_DB_PERSISTENCE = "true";

describeDb("Sprint 10 database-backed behaviour", () => {
  it("runs a due schedule in the separate job process and records the run for the API to read", async () => {
    const { createSchedule, listRuns } = await import("../src/services/jobScheduler.js");
    const { registerSchedulerHandlers } = await import("../src/services/schedulerHandlers.js");
    const { basePrisma } = await import("../src/db.js");
    registerSchedulerHandlers();
    const schedule = await createSchedule({ name: "sprint10-job", handler: "demo.wait", mode: "once", runAtIso: new Date(Date.now() - 1000).toISOString(), timezone: "UTC", priority: "critical", maxAttempts: 1, params: { ms: 1500 } } as never, "tester");
    const out = await new Promise<string>((resolve, reject) => {
      execFile("npx", ["tsx", "src/schedulerJob.ts"], { cwd: path.resolve(process.cwd()), env: { ...process.env, SCHEDULER_MODE: "external", SCHEDULER_JOB_MAX_SECONDS: "20", QUEUE_DRAIN_SECONDS: "0", PLATFORM_DB_PERSISTENCE: "true" }, timeout: 90000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || String(err))) : resolve(stdout)));
    });
    expect(out).toContain("scheduler_job_done");
    const runs = await listRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    // The job waited for a run that takes time, rather than exiting while it was still starting.
    expect(runs[0].status).toBe("succeeded");
    expect(runs[0].result).toMatchObject({ waitedMs: 1500 });
    await basePrisma.$disconnect();
  }, 120_000);
});
