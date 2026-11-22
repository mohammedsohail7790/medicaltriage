// NFR-130: entry point of the Cloud Run job that runs scheduled platform jobs outside the API instances.
// Cloud Scheduler starts it every minute; it starts what is due, waits for those runs to finish (up to
// SCHEDULER_JOB_MAX_SECONDS) and exits. It also drains the queued integration jobs and webhook deliveries.
// Runs and diagnoses are recorded exactly as when the API ran them.
import { assertRuntimeConfiguration } from "./config/runtime.js";
import { idle, tick } from "./services/jobScheduler.js";
import { drainPlatformQueues, registerPlatformSubscribers } from "./services/platformEvents.js";

assertRuntimeConfiguration();
// Registers the scheduler handlers and the queued-job handlers, so this process can run both.
registerPlatformSubscribers();
const started = await tick();
// NFR-130: queued integration jobs and webhook deliveries are drained here, not in the API instances.
const drained = await drainPlatformQueues(Number(process.env.QUEUE_DRAIN_SECONDS ?? 45));
const maxSeconds = Math.max(5, Number(process.env.SCHEDULER_JOB_MAX_SECONDS ?? 540));
await idle(maxSeconds * 1000);
console.log(JSON.stringify({ type: "scheduler_job_done", started: started.started.length, deferred: started.deferred.length, queuePasses: drained.passes }));
process.exit(0);
