// NFR-130: entry point of the Cloud Run job that runs scheduled platform jobs outside the API instances.
// Cloud Scheduler starts it every minute; it starts what is due, waits for those runs to finish (up to
// SCHEDULER_JOB_MAX_SECONDS) and exits. Runs and diagnoses are recorded exactly as when the API ran them.
import { assertRuntimeConfiguration } from "./config/runtime.js";
import { idle, tick } from "./services/jobScheduler.js";
import { registerSchedulerHandlers } from "./services/schedulerHandlers.js";

assertRuntimeConfiguration();
registerSchedulerHandlers();
const started = await tick();
const maxSeconds = Math.max(5, Number(process.env.SCHEDULER_JOB_MAX_SECONDS ?? 540));
await idle(maxSeconds * 1000);
console.log(JSON.stringify({ type: "scheduler_job_done", started: started.started.length, deferred: started.deferred.length }));
process.exit(0);
