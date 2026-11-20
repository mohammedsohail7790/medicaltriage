import { shouldUseDatabasePersistence } from "../config/runtime.js";
import { prisma } from "../db.js";
import { toCloudEvent, type PlatformEvent } from "./eventBus.js";

/** Sends one alert to one named webhook subscription, as a rule's webhook channel (NFR-092 over NFR-166). */
export async function enqueueForSubscription(subscriptionId: string, event: PlatformEvent, ruleName: string): Promise<void> {
  if (!shouldUseDatabasePersistence()) return;
  const subscription = await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } });
  if (!subscription || subscription.status !== "active") return;
  const payload = { ...toCloudEvent(event), type: "com.irisstar.aimltriage.alert.fired", data: { ...toCloudEvent(event).data, rule: ruleName, originalType: event.type } };
  await prisma.webhookDelivery.create({ data: { subscriptionId, eventId: event.id, eventType: payload.type, payload: payload as never } });
}
