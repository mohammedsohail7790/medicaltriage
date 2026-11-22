import { registerBrokerPublishing } from "../integration/messageBroker.js";
import { getEmailAdapter } from "./communicationAdapters.js";
import { registerRuleSubscriber } from "./eventRules.js";
import { processJobs, registerJobHandler, startJobWorker } from "./integrationQueue.js";
import { startTraceExporter } from "../observability/tracing.js";
import { schedulerRunsInProcess, startSchedulerWorker } from "./jobScheduler.js";
import { registerSchedulerHandlers } from "./schedulerHandlers.js";
import { processDueDeliveries, registerWebhookSubscriber, startWebhookWorker } from "./webhooks.js";

/** Connects the event subscribers and job handlers. Safe to call more than once. */
export function registerPlatformSubscribers(): void {
  registerWebhookSubscriber();
  registerRuleSubscriber();
  registerBrokerPublishing();
  registerSchedulerHandlers();
  // NFR-094: the EMR write-back, done by a worker with the tenant of the nurse who asked for it.
  registerJobHandler("emr.writeback", async (payload, job) => {
    const { executeWriteback } = await import("../integration/fhirWriteback.js");
    const organizationId = (payload.organizationId as string | null) ?? undefined;
    const session = {
      sessionId: `job:${job.id}`,
      user: { id: "system:integration-worker", organizationId, accountStatus: "active", roles: ["system"] },
      activeRole: "system",
      permissions: [],
      responsibilities: [],
      expiresAtIso: new Date(Date.now() + 600_000).toISOString(),
      authMethod: "local",
      mfaVerified: false
    } as unknown as import("../types/security.js").AuthenticatedSession;
    await executeWriteback(String(payload.encounterId), { ...(payload.options as object), requestId: job.correlationId }, session);
  });
  registerJobHandler("email.send", async (payload) => {
    const result = await getEmailAdapter().send({ to: String(payload.to), subject: String(payload.subject), body: String(payload.body) });
    if (!result.ok) throw new Error(result.error ?? "Email could not be sent.");
  });
}

/**
 * Starts the background workers. NFR-130: with SCHEDULER_MODE=external the API instances start none of the
 * queue workers (webhook delivery, queued integration jobs, scheduled jobs); the scheduler job runs them
 * (see drainPlatformQueues) so background work cannot take capacity from interactive traffic.
 */
export function startPlatformWorkers(env: NodeJS.ProcessEnv = process.env): void {
  if (schedulerRunsInProcess(env)) {
    startWebhookWorker();
    startJobWorker();
    startSchedulerWorker();
  }
  startTraceExporter();
}

/**
 * Used by the scheduler job: delivers due webhooks and runs queued integration jobs every few seconds for up to
 * `seconds`, with at least one pass. Both queues lock their rows, so overlapping runs do not repeat work.
 */
export async function drainPlatformQueues(seconds: number, everyMs = 5000): Promise<{ passes: number }> {
  const deadline = Date.now() + Math.max(0, seconds) * 1000;
  let passes = 0;
  do {
    passes += 1;
    await processJobs().catch((e) => console.error(JSON.stringify({ type: "job_worker_failed", error: e instanceof Error ? e.name : "error" })));
    await processDueDeliveries().catch((e) => console.error(JSON.stringify({ type: "webhook_worker_failed", error: e instanceof Error ? e.name : "error" })));
    if (Date.now() + everyMs >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  } while (Date.now() < deadline);
  return { passes };
}
