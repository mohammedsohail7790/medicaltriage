import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireElevatedPermission, requirePermission, type AuthorizedRequest } from "../services/authorization.js";
import { buildAuditChange } from "../services/auditChange.js";
import { ConsumerError, DecisionInput, decide as decideConsumer, rotateSecret as rotateConsumerSecret, setStatus as setConsumerStatus } from "../services/apiConsumers.js";
import { apiAnalyticsReport } from "../services/apiAnalytics.js";
import { integrationRegistry, probeIntegration } from "../services/integrationRegistry.js";
import { RuleError, RuleInput, createRule, deleteRule, getRule, listRules, updateRule } from "../services/eventRules.js";
import { publishEvent } from "../services/eventBus.js";
import { jobHandlerTypes, processJobs, replayJobs } from "../services/integrationQueue.js";
import { recordAuditEvent } from "../services/securityAdmin.js";
import { SubscriptionInput, WebhookError, createSubscription, processDueDeliveries, replayDeliveries, requireDatabase, validateWebhookUrl } from "../services/webhooks.js";
import type { AuthenticatedSession } from "../types/security.js";

/**
 * Administration of the event-driven integration features: outbound webhooks (NFR-166), event and alert rules
 * (NFR-092) and the integration job queue (NFR-094). Reading needs audit access; every change needs elevation
 * and is audited with before and after values.
 */

async function audit(session: AuthenticatedSession, action: string, resource: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  await recordAuditEvent({
    id: randomUUID(), timestampIso: new Date().toISOString(), userId: session.user.id, activeRole: session.activeRole, organization: session.user.organizationId ?? "", facility: "", department: "",
    action, module: "Integrations", resource, ipAddress: "", device: "", success: true, risk: "medium", metadata: { change: buildAuditChange(before, after) }
  });
}

export function createIntegrationAdminRouter(): Router {
  const router = Router();
  const read = requirePermission("audit.events.view");
  const write = requireElevatedPermission("admin.users.manage");
  const fail = (res: import("express").Response, error: unknown, next: import("express").NextFunction) =>
    error instanceof WebhookError || error instanceof RuleError ? res.status(error.status).json({ error: error.message, code: error.code }) : next(error);

  // ---- webhooks ----
  router.get("/webhooks", read, async (_req, res, next) => {
    try {
      requireDatabase();
      const rows = await prisma.webhookSubscription.findMany({ orderBy: { createdAt: "desc" } });
      const counts = await prisma.webhookDelivery.groupBy({ by: ["subscriptionId", "status"], _count: true });
      return res.json({
        subscriptions: rows.map((row) => ({ id: row.id, name: row.name, url: row.url, events: row.events, status: row.status, createdAt: row.createdAt, deliveries: Object.fromEntries(counts.filter((c) => c.subscriptionId === row.id).map((c) => [c.status, c._count])) }))
      });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/webhooks", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = SubscriptionInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid subscription", details: parsed.error.flatten() });
      const created = await createSubscription(parsed.data, req.securitySession!.user.id);
      await audit(req.securitySession!, "WEBHOOK_SUBSCRIPTION_CREATED", `WebhookSubscription:${created.id}`, null, { name: parsed.data.name, url: parsed.data.url, events: parsed.data.events });
      // The signing secret is shown once, here, and never again.
      return res.status(201).json({ id: created.id, secret: created.secret, note: "Store this secret now; it cannot be shown again." });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.patch("/webhooks/:id", write, async (req: AuthorizedRequest, res, next) => {
    try {
      requireDatabase();
      const body = z.object({ status: z.enum(["active", "paused"]).optional(), url: z.string().optional(), events: z.array(z.string()).min(1).optional() }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "Invalid change" });
      if (body.data.url) validateWebhookUrl(body.data.url);
      const before = await prisma.webhookSubscription.findUnique({ where: { id: req.params.id } });
      if (!before) return res.status(404).json({ error: "Subscription not found." });
      const after = await prisma.webhookSubscription.update({ where: { id: req.params.id }, data: { ...(body.data.status ? { status: body.data.status } : {}), ...(body.data.url ? { url: body.data.url } : {}), ...(body.data.events ? { events: body.data.events } : {}) } });
      await audit(req.securitySession!, "WEBHOOK_SUBSCRIPTION_UPDATED", `WebhookSubscription:${after.id}`, { status: before.status, url: before.url, events: before.events }, { status: after.status, url: after.url, events: after.events });
      return res.json({ id: after.id, status: after.status, url: after.url, events: after.events });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.delete("/webhooks/:id", write, async (req: AuthorizedRequest, res, next) => {
    try {
      requireDatabase();
      const before = await prisma.webhookSubscription.findUnique({ where: { id: req.params.id } });
      if (!before) return res.status(404).json({ error: "Subscription not found." });
      await prisma.webhookSubscription.delete({ where: { id: req.params.id } });
      await audit(req.securitySession!, "WEBHOOK_SUBSCRIPTION_DELETED", `WebhookSubscription:${before.id}`, { name: before.name, url: before.url, events: before.events }, null);
      return res.status(204).end();
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.get("/webhooks/deliveries", read, async (req, res, next) => {
    try {
      requireDatabase();
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
      const rows = await prisma.webhookDelivery.findMany({ where: { ...(status ? { status } : {}), ...(subscriptionId ? { subscriptionId } : {}) }, orderBy: { createdAt: "desc" }, take: Math.min(Number(req.query.limit) || 100, 500) });
      return res.json({ deliveries: rows.map(({ payload: _payload, lockedUntil: _l, ...row }) => row) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/webhooks/deliveries/:id/replay", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const count = await replayDeliveries({ id: req.params.id });
      if (count === 0) return res.status(404).json({ error: "No dead delivery with that id." });
      await audit(req.securitySession!, "WEBHOOK_DELIVERY_REPLAYED", `WebhookDelivery:${req.params.id}`, { status: "dead" }, { status: "pending" });
      return res.json({ replayed: count });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/webhooks/:id/replay-dead", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const count = await replayDeliveries({ subscriptionId: req.params.id });
      await audit(req.securitySession!, "WEBHOOK_DELIVERY_REPLAYED", `WebhookSubscription:${req.params.id}`, { dead: count }, { dead: 0 });
      return res.json({ replayed: count });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/webhooks/:id/test", write, async (req: AuthorizedRequest, res, next) => {
    try {
      requireDatabase();
      const subscription = await prisma.webhookSubscription.findUnique({ where: { id: req.params.id } });
      if (!subscription) return res.status(404).json({ error: "Subscription not found." });
      const { toCloudEvent } = await import("../services/eventBus.js");
      const event = { id: randomUUID(), type: "webhook.test", occurredAtIso: new Date().toISOString(), risk: "low" as const, success: true, subject: subscription.id, data: { action: "WEBHOOK_TEST", note: "Test delivery requested by an administrator." } };
      await prisma.webhookDelivery.create({ data: { subscriptionId: subscription.id, eventId: event.id, eventType: toCloudEvent(event).type, payload: toCloudEvent(event) as never } });
      return res.status(202).json({ queued: true });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  // Runs the delivery worker once, for operators and scheduled jobs.
  router.post("/webhooks/run", write, async (_req, res, next) => {
    try {
      return res.json(await processDueDeliveries());
    } catch (error) {
      return fail(res, error, next);
    }
  });

  // ---- event and alert rules ----
  router.get("/event-rules", read, async (_req, res, next) => {
    try {
      return res.json({ rules: await listRules(), channels: ["log", "email", "webhook"], riskLevels: ["low", "medium", "high", "critical"] });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/event-rules", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = RuleInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid rule", details: parsed.error.flatten() });
      const rule = await createRule(parsed.data, req.securitySession!.user.id);
      await audit(req.securitySession!, "EVENT_RULE_CREATED", `EventRule:${rule.id}`, null, { ...parsed.data });
      return res.status(201).json({ rule });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.put("/event-rules/:id", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = RuleInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid rule", details: parsed.error.flatten() });
      const before = await getRule(req.params.id);
      const rule = await updateRule(req.params.id, parsed.data, req.securitySession!.user.id);
      await audit(req.securitySession!, "EVENT_RULE_UPDATED", `EventRule:${rule.id}`, before ? { name: before.name, enabled: before.enabled, eventPattern: before.eventPattern, minRisk: before.minRisk ?? null, channel: before.channel, recipients: before.recipients, cooldownSeconds: before.cooldownSeconds, condition: before.condition ?? null } : null, { ...parsed.data, minRisk: parsed.data.minRisk ?? null, condition: parsed.data.condition ?? null });
      return res.json({ rule });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.delete("/event-rules/:id", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const before = await getRule(req.params.id);
      await deleteRule(req.params.id);
      await audit(req.securitySession!, "EVENT_RULE_DELETED", `EventRule:${req.params.id}`, before ? { name: before.name, eventPattern: before.eventPattern, channel: before.channel } : null, null);
      return res.status(204).end();
    } catch (error) {
      return fail(res, error, next);
    }
  });

  // Lets an administrator see a rule fire: publishes a synthetic event through the same path as real ones.
  router.post("/event-rules/test-event", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const body = z.object({ type: z.string().min(1).max(100), risk: z.enum(["low", "medium", "high", "critical"]).default("medium") }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "type is required" });
      await publishEvent({ id: randomUUID(), type: body.data.type, occurredAtIso: new Date().toISOString(), risk: body.data.risk, success: true, subject: "rule-test", data: { action: body.data.type.toUpperCase(), module: "RuleTest", resource: "RuleTest", userId: req.securitySession!.user.id, activeRole: req.securitySession!.activeRole } });
      return res.status(202).json({ published: true });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  // ---- API consumers (NFR-003) ----
  const consumerFail = (res: import("express").Response, error: unknown, next: import("express").NextFunction) =>
    error instanceof ConsumerError ? res.status(error.status).json({ error: error.message, code: error.code }) : fail(res, error, next);

  router.get("/api-consumers", read, async (req, res, next) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const rows = await prisma.apiConsumer.findMany({ where: status ? { status } : {}, orderBy: { requestedAt: "desc" }, take: 200 });
      return res.json({ consumers: rows.map(({ clientSecretHash: _h, ...row }) => row) });
    } catch (error) {
      return consumerFail(res, error, next);
    }
  });

  router.post("/api-consumers/:id/decision", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = DecisionInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid decision", details: parsed.error.flatten() });
      const result = await decideConsumer(req.params.id, parsed.data, req.securitySession!.user.id);
      await audit(req.securitySession!, parsed.data.decision === "approve" ? "API_CONSUMER_APPROVED" : "API_CONSUMER_REJECTED", `ApiConsumer:${req.params.id}`, { status: "pending" }, { status: result.status, role: parsed.data.role ?? null, rateLimitPerMinute: parsed.data.rateLimitPerMinute ?? null, clientId: result.clientId ?? null });
      res.setHeader("Cache-Control", "no-store");
      return res.json(result.clientSecret ? { ...result, note: "Send these credentials to the consumer now; the secret cannot be shown again." } : result);
    } catch (error) {
      return consumerFail(res, error, next);
    }
  });

  router.post("/api-consumers/:id/rotate-secret", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const result = await rotateConsumerSecret(req.params.id);
      await audit(req.securitySession!, "API_CONSUMER_SECRET_ROTATED", `ApiConsumer:${req.params.id}`, null, { clientId: result.clientId });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ...result, note: "The previous secret no longer works. Send the new one now; it cannot be shown again." });
    } catch (error) {
      return consumerFail(res, error, next);
    }
  });

  for (const [path, status] of [["suspend", "suspended"], ["reinstate", "approved"]] as const) {
    router.post(`/api-consumers/:id/${path}`, write, async (req: AuthorizedRequest, res, next) => {
      try {
        await setConsumerStatus(req.params.id, status);
        await audit(req.securitySession!, status === "suspended" ? "API_CONSUMER_SUSPENDED" : "API_CONSUMER_REINSTATED", `ApiConsumer:${req.params.id}`, { status: status === "suspended" ? "approved" : "suspended" }, { status });
        return res.json({ status });
      } catch (error) {
        return consumerFail(res, error, next);
      }
    });
  }

  // ---- integration job queue ----
  router.get("/jobs", read, async (req, res, next) => {
    try {
      requireDatabase();
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const rows = await prisma.integrationJob.findMany({ where: status ? { status } : {}, orderBy: { createdAt: "desc" }, take: Math.min(Number(req.query.limit) || 100, 500) });
      return res.json({ handlers: jobHandlerTypes(), jobs: rows.map(({ payload: _p, lockedUntil: _l, ...row }) => row) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/jobs/:id/replay", write, async (req: AuthorizedRequest, res, next) => {
    try {
      requireDatabase();
      const count = await replayJobs({ id: req.params.id });
      if (count === 0) return res.status(404).json({ error: "No dead job with that id." });
      await audit(req.securitySession!, "INTEGRATION_JOB_REPLAYED", `IntegrationJob:${req.params.id}`, { status: "dead" }, { status: "pending" });
      return res.json({ replayed: count });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  // ---- NFR-008: API consumption analytics ----
  router.get("/api-analytics", read, (req, res) => {
    const consumer = typeof req.query.consumer === "string" ? req.query.consumer : undefined;
    const route = typeof req.query.route === "string" ? req.query.route : undefined;
    return res.json({ scope: "this instance, recent window", ...apiAnalyticsReport({ consumer, route }) });
  });

  // ---- NFR-090: integration readiness ----
  router.get("/registry", read, (_req, res) => res.json({ integrations: integrationRegistry() }));

  router.post("/registry/:name/test", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const result = await probeIntegration(String(req.params.name));
      await audit(req.securitySession!, "INTEGRATION_CONNECTIVITY_TESTED", `Integration:${req.params.name}`, null, { reachable: result.reachable, httpStatus: result.httpStatus ?? null });
      return res.json(result);
    } catch (error) {
      if (error instanceof Error && /Unknown integration|not configured/.test(error.message)) return res.status(400).json({ error: error.message });
      return next(error);
    }
  });

  router.post("/jobs/run", write, async (_req, res, next) => {
    try {
      requireDatabase();
      return res.json(await processJobs());
    } catch (error) {
      return fail(res, error, next);
    }
  });

  return router;
}
