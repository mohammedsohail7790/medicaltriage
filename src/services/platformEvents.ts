import { registerBrokerPublishing } from "../integration/messageBroker.js";
import { getEmailAdapter } from "./communicationAdapters.js";
import { registerRuleSubscriber } from "./eventRules.js";
import { registerJobHandler, startJobWorker } from "./integrationQueue.js";
import { registerWebhookSubscriber, startWebhookWorker } from "./webhooks.js";

/** Connects the event subscribers and job handlers. Safe to call more than once. */
export function registerPlatformSubscribers(): void {
  registerWebhookSubscriber();
  registerRuleSubscriber();
  registerBrokerPublishing();
  registerJobHandler("email.send", async (payload) => {
    const result = await getEmailAdapter().send({ to: String(payload.to), subject: String(payload.subject), body: String(payload.body) });
    if (!result.ok) throw new Error(result.error ?? "Email could not be sent.");
  });
}

/** Starts the background workers that deliver webhooks and run queued integration jobs. */
export function startPlatformWorkers(): void {
  startWebhookWorker();
  startJobWorker();
}
