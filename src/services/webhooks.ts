import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { callExternal } from "../integration/externalClient.js";
import { prisma } from "../db.js";
import { shouldPersistPlatformInDatabase } from "../config/runtime.js";
import { eventMatches, subscribe, toCloudEvent, type PlatformEvent } from "./eventBus.js";
import { recordAuditEvent } from "./securityAdmin.js";

/**
 * Outbound webhooks (NFR-166).
 *
 * A subscriber registers a URL and the event types it wants ("queue.item.completed", "queue.*", "*"). Each
 * matching event becomes a delivery, a signed CloudEvents JSON POST:
 *   X-Webhook-Id, X-Webhook-Timestamp and X-Webhook-Signature: t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<body>">
 * A failed delivery is retried with exponential back-off (WEBHOOK_BACKOFF_BASE_MS, default 30 s, doubling, capped
 * at one hour, with jitter) up to WEBHOOK_MAX_ATTEMPTS (default 6). After that it moves to the dead-letter queue,
 * where an administrator can inspect it and replay it. Deliveries are durable in PostgreSQL, so a restart loses nothing.
 */

export class WebhookError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
    this.name = "WebhookError";
  }
}

export function requireDatabase(): void {
  if (!shouldPersistPlatformInDatabase()) throw new WebhookError(409, "Webhooks need database persistence, which is off in this environment.", "WEBHOOKS_NEED_DATABASE");
}

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verifyWebhookSignature(secret: string, header: string, body: string, toleranceSeconds = 300, now = Date.now()): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = signWebhook(secret, timestamp, body).split("v1=")[1];
  return typeof parts.v1 === "string" && parts.v1.length === expected.length && parts.v1 === expected;
}

export function webhookPolicy(env: Record<string, string | undefined> = process.env) {
  const maxAttempts = Number(env.WEBHOOK_MAX_ATTEMPTS);
  const base = Number(env.WEBHOOK_BACKOFF_BASE_MS);
  return { maxAttempts: Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 6, baseDelayMs: Number.isFinite(base) && base > 0 ? base : 30_000 };
}

/** Delay before the next attempt after `attempts` failures: base * 2^(attempts-1), capped at an hour, with up to 10% jitter. */
export function backoffMs(attempts: number, policy = webhookPolicy(), random = Math.random): number {
  const delay = Math.min(policy.baseDelayMs * 2 ** Math.max(attempts - 1, 0), 3_600_000);
  return Math.round(delay * (1 + (random() - 0.5) * 0.2));
}

// ---- subscriptions -------------------------------------------------------------------------------

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|.*\.internal$|.*\.local$)/i;

export function validateWebhookUrl(raw: string, env: Record<string, string | undefined> = process.env): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookError(400, "The webhook URL is not valid.", "WEBHOOK_URL_INVALID");
  }
  const production = env.NODE_ENV === "production";
  if (url.protocol !== "https:" && !(!production && url.protocol === "http:")) throw new WebhookError(400, "The webhook URL must use https.", "WEBHOOK_URL_INSECURE");
  // A subscriber cannot point the service at its own network.
  if (production && PRIVATE_HOST.test(url.hostname)) throw new WebhookError(400, "The webhook URL must be a public address.", "WEBHOOK_URL_PRIVATE");
  return url;
}

export const SubscriptionInput = z.object({
  name: z.string().trim().min(2).max(120),
  url: z.string().trim().min(8).max(500),
  events: z.array(z.string().trim().min(1).max(80)).min(1).max(50)
});

export async function createSubscription(input: z.infer<typeof SubscriptionInput>, actorUserId: string): Promise<{ id: string; secret: string }> {
  requireDatabase();
  validateWebhookUrl(input.url);
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const row = await prisma.webhookSubscription.create({ data: { name: input.name, url: input.url, secret, events: input.events, createdBy: actorUserId } });
  return { id: row.id, secret };
}

// ---- enqueue -------------------------------------------------------------------------------------

export async function enqueueForEvent(event: PlatformEvent): Promise<number> {
  if (!shouldPersistPlatformInDatabase()) return 0;
  const subscriptions = await prisma.webhookSubscription.findMany({ where: { status: "active" } });
  const payload = toCloudEvent(event);
  let queued = 0;
  for (const subscription of subscriptions) {
    const wanted = (subscription.events as string[]).some((pattern) => eventMatches(pattern, event.type, String(event.data.action ?? "")));
    if (!wanted) continue;
    await prisma.webhookDelivery.create({ data: { subscriptionId: subscription.id, eventId: event.id, eventType: payload.type, payload: payload as never } });
    queued += 1;
  }
  return queued;
}

export function registerWebhookSubscriber(): void {
  subscribe({ name: "webhooks", handle: async (event) => void (await enqueueForEvent(event)) });
}

// ---- delivery --------------------------------------------------------------------------------------

type Sender = (url: string, init: RequestInit) => Promise<Response>;
let sender: Sender | undefined;
export function setWebhookSenderForTests(fn: Sender | undefined): void {
  sender = fn;
}

export type DeliveryRun = { attempted: number; succeeded: number; retried: number; dead: number };

export async function processDueDeliveries(options: { limit?: number; now?: Date } = {}): Promise<DeliveryRun> {
  requireDatabase();
  const now = options.now ?? new Date();
  const policy = webhookPolicy();
  const result: DeliveryRun = { attempted: 0, succeeded: 0, retried: 0, dead: 0 };
  const due = await prisma.webhookDelivery.findMany({
    where: { status: "pending", nextAttemptAt: { lte: now }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    orderBy: { nextAttemptAt: "asc" },
    take: options.limit ?? 25,
    include: { subscription: true }
  });
  for (const delivery of due) {
    // Claim it: only one worker wins the update, so a delivery is never sent twice at once.
    const claimed = await prisma.webhookDelivery.updateMany({
      where: { id: delivery.id, status: "pending", OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      data: { lockedUntil: new Date(now.getTime() + 60_000) }
    });
    if (claimed.count !== 1) continue;
    result.attempted += 1;
    const attempts = delivery.attempts + 1;
    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(now.getTime() / 1000);
    let status: number | undefined;
    let error: string | undefined;
    try {
      const send: Sender = sender ?? ((url, init) => callExternal("webhook", url, init, { attempts: 1, correlationId: delivery.eventId }));
      const response = await send(delivery.subscription.url, {
        method: "POST",
        headers: {
          "content-type": "application/cloudevents+json",
          "x-webhook-id": delivery.id,
          "x-webhook-timestamp": String(timestamp),
          "x-webhook-signature": signWebhook(delivery.subscription.secret, timestamp, body)
        },
        body
      });
      status = response.status;
      if (response.status < 200 || response.status >= 300) error = `HTTP ${response.status}`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "error";
    }
    if (!error) {
      await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: "succeeded", attempts, lastStatus: status, lastError: null, deliveredAt: now, lockedUntil: null } });
      result.succeeded += 1;
    } else if (attempts >= policy.maxAttempts) {
      await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: "dead", attempts, lastStatus: status ?? null, lastError: error, lockedUntil: null } });
      result.dead += 1;
      await recordDeadLetter(delivery.id, delivery.subscription.name, delivery.eventType, error);
    } else {
      await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { attempts, lastStatus: status ?? null, lastError: error, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts, policy)), lockedUntil: null } });
      result.retried += 1;
    }
  }
  return result;
}

async function recordDeadLetter(deliveryId: string, subscription: string, eventType: string, error: string): Promise<void> {
  await recordAuditEvent({
    id: randomUUID(), timestampIso: new Date().toISOString(), userId: "system", activeRole: "system", organization: "", facility: "", department: "",
    action: "WEBHOOK_DELIVERY_DEAD", module: "EventDelivery", resource: `WebhookDelivery:${deliveryId}`, purpose: `${subscription}: ${eventType} could not be delivered (${error})`,
    ipAddress: "", device: "", success: false, risk: "medium"
  });
}

/** Puts dead deliveries back in the queue for another full run of attempts. */
export async function replayDeliveries(filter: { id?: string; subscriptionId?: string }): Promise<number> {
  requireDatabase();
  const result = await prisma.webhookDelivery.updateMany({
    where: { status: "dead", ...(filter.id ? { id: filter.id } : {}), ...(filter.subscriptionId ? { subscriptionId: filter.subscriptionId } : {}) },
    data: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lockedUntil: null, lastError: null }
  });
  return result.count;
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startWebhookWorker(everyMs = 5000): void {
  if (timer || !shouldPersistPlatformInDatabase()) return;
  timer = setInterval(() => void processDueDeliveries().catch((e) => console.error(JSON.stringify({ type: "webhook_worker_failed", error: e instanceof Error ? e.name : "error" }))), everyMs);
  timer.unref?.();
}
