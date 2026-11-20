import { registerBrokerPublishing } from "../integration/messageBroker.js";
import { getEmailAdapter } from "./communicationAdapters.js";
import { registerRuleSubscriber } from "./eventRules.js";
import { registerJobHandler, startJobWorker } from "./integrationQueue.js";
import { startSchedulerWorker } from "./jobScheduler.js";
import { registerSchedulerHandlers } from "./schedulerHandlers.js";
import { registerWebhookSubscriber, startWebhookWorker } from "./webhooks.js";

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

/** Starts the background workers that deliver webhooks and run queued integration jobs. */
export function startPlatformWorkers(): void {
  startWebhookWorker();
  startJobWorker();
  startSchedulerWorker();
}
