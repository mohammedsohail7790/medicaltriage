import { authenticator } from "otplib";
import request from "supertest";
import { createApp } from "../src/app.js";
import { JmsBridgeBroker, PubSubBroker, brokerFromEnv, setBrokerPostForTests } from "../src/integration/messageBroker.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { auditToEvent, eventMatches, eventTypeFor, publishEvent, subscribe, toCloudEvent, clearSubscribersForTests, type PlatformEvent } from "../src/services/eventBus.js";
import { RuleInput, onAlertForTests, resetRulesForTests, ruleMatches, type StoredRule } from "../src/services/eventRules.js";
import { backoffMs, signWebhook, validateWebhookUrl, verifyWebhookSignature, webhookPolicy } from "../src/services/webhooks.js";
import { confirmMfaEnrollment, enrollMfa, listAuditEvents, resetSecurityStoreForTests } from "../src/services/securityAdmin.js";
import { registerPlatformSubscribers } from "../src/services/platformEvents.js";
import type { AuditEvent } from "../src/types/security.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";

const audit = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  id: "evt-1", timestampIso: "2026-11-20T10:00:00.000Z", userId: "u1", activeRole: "remote_triage_nurse", organization: "org", facility: "", department: "", action: "QUEUE_ITEM_COMPLETE",
  module: "Queue", resource: "TriageQueueItem", recordReference: "case-1", ipAddress: "", device: "", success: true, risk: "high", metadata: { change: { fields: ["status"], before: { status: "A" }, after: { status: "B" } } }, ...over
});

describe("platform events", () => {
  it("turns audit events into CloudEvents that name references and changed fields, never the values", () => {
    const event = auditToEvent(audit())!;
    expect(event.type).toBe("queue.item.completed");
    const cloud = toCloudEvent(event);
    expect(cloud).toMatchObject({ specversion: "1.0", id: "evt-1", source: "/aimltriage", type: "com.irisstar.aimltriage.queue.item.completed", subject: "case-1", datacontenttype: "application/json" });
    expect(cloud.data).toMatchObject({ changedFields: ["status"], risk: "high", success: true, userId: "u1" });
    expect(JSON.stringify(cloud)).not.toContain('"before"');
    expect(eventTypeFor("SOMETHING_ELSE")).toBe("audit.something_else");
  });

  it("does not republish the delivery machinery's own events or read events", () => {
    expect(auditToEvent(audit({ module: "EventDelivery" }))).toBeUndefined();
    expect(auditToEvent(audit({ module: "DataAccess", action: "DATA_READ" }))).toBeUndefined();
  });

  it("matches exact types, audit actions, prefixes and *", () => {
    expect(eventMatches("*", "queue.item.completed")).toBe(true);
    expect(eventMatches("queue.*", "queue.item.completed")).toBe(true);
    expect(eventMatches("queue.item.completed", "queue.item.completed")).toBe(true);
    expect(eventMatches("QUEUE_ITEM_COMPLETE", "queue.item.completed", "QUEUE_ITEM_COMPLETE")).toBe(true);
    expect(eventMatches("QUEUE_*", "queue.item.completed", "QUEUE_ITEM_COMPLETE")).toBe(true);
    expect(eventMatches("export.*", "queue.item.completed")).toBe(false);
  });

  it("isolates a failing subscriber from the others", async () => {
    clearSubscribersForTests();
    const seen: string[] = [];
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    subscribe({ name: "broken", handle: async () => { throw new Error("boom"); } });
    subscribe({ name: "fine", handle: async (e) => void seen.push(e.id) });
    await expect(publishEvent(auditToEvent(audit())!)).resolves.toBeUndefined();
    expect(seen).toEqual(["evt-1"]);
    errors.mockRestore();
    clearSubscribersForTests();
    registerPlatformSubscribers();
  });
});

describe("NFR-166 webhook signing, back-off and addresses", () => {
  it("signs with HMAC-SHA256 over timestamp and body, and verifies within a tolerance", () => {
    const header = signWebhook("whsec_x", 1_700_000_000, '{"a":1}');
    expect(header).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
    const now = 1_700_000_100 * 1000;
    expect(verifyWebhookSignature("whsec_x", header, '{"a":1}', 300, now)).toBe(true);
    expect(verifyWebhookSignature("whsec_y", header, '{"a":1}', 300, now)).toBe(false);
    expect(verifyWebhookSignature("whsec_x", header, '{"a":2}', 300, now)).toBe(false);
    expect(verifyWebhookSignature("whsec_x", header, '{"a":1}', 300, now + 10_000_000)).toBe(false);
  });

  it("backs off exponentially, capped at an hour, with jitter", () => {
    const policy = { maxAttempts: 6, baseDelayMs: 30_000 };
    const mid = () => 0.5;
    expect([1, 2, 3, 4].map((n) => backoffMs(n, policy, mid))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(backoffMs(20, policy, mid)).toBe(3_600_000);
    expect(backoffMs(2, policy, () => 0)).toBe(54_000);
    expect(backoffMs(2, policy, () => 1)).toBe(66_000);
  });

  it("reads attempts and delay from configuration", () => {
    expect(webhookPolicy({})).toEqual({ maxAttempts: 6, baseDelayMs: 30_000 });
    expect(webhookPolicy({ WEBHOOK_MAX_ATTEMPTS: "3", WEBHOOK_BACKOFF_BASE_MS: "1000" })).toEqual({ maxAttempts: 3, baseDelayMs: 1000 });
  });

  it("requires https, and a public address in production", () => {
    expect(() => validateWebhookUrl("ftp://x.example", {})).toThrow(/https/);
    expect(() => validateWebhookUrl("not a url", {})).toThrow(/not valid/);
    expect(validateWebhookUrl("http://localhost:9000/hook", { NODE_ENV: "test" }).hostname).toBe("localhost");
    expect(() => validateWebhookUrl("http://x.example/hook", { NODE_ENV: "production" })).toThrow(/https/);
    for (const host of ["https://localhost/h", "https://10.1.2.3/h", "https://192.168.0.5/h", "https://169.254.169.254/h", "https://db.internal/h"]) {
      expect(() => validateWebhookUrl(host, { NODE_ENV: "production" })).toThrow(/public/);
    }
    expect(validateWebhookUrl("https://hooks.partner.example/in", { NODE_ENV: "production" }).host).toBe("hooks.partner.example");
  });
});

describe("NFR-092 event and alert rules", () => {
  const rule = (over: Partial<StoredRule> = {}): StoredRule => ({ id: "r1", name: "Critical", enabled: true, eventPattern: "*", channel: "log", recipients: ["siem"], cooldownSeconds: 0, createdBy: "a", updatedBy: "a", createdAtIso: "", updatedAtIso: "", ...over });
  const event: PlatformEvent = { id: "e1", type: "auth.login_failed", occurredAtIso: "2026-11-20T10:00:00Z", risk: "high", success: false, subject: "u1", data: { action: "FAILED_LOGIN", module: "Authentication", resource: "local", userId: "u1", activeRole: "nurse" } };

  it("matches on event, minimum risk and one field condition", () => {
    expect(ruleMatches(rule({ eventPattern: "auth.*" }), event)).toBe(true);
    expect(ruleMatches(rule({ eventPattern: "queue.*" }), event)).toBe(false);
    expect(ruleMatches(rule({ minRisk: "critical" }), event)).toBe(false);
    expect(ruleMatches(rule({ minRisk: "medium" }), event)).toBe(true);
    expect(ruleMatches(rule({ condition: { field: "success", equals: false } }), event)).toBe(true);
    expect(ruleMatches(rule({ condition: { field: "success", equals: true } }), event)).toBe(false);
    expect(ruleMatches(rule({ condition: { field: "module", contains: "auth" } }), event)).toBe(true);
    expect(ruleMatches(rule({ condition: { field: "userId", equals: "someone-else" } }), event)).toBe(false);
  });

  it("validates input", () => {
    const good = { name: "Failed sign-ins", eventPattern: "auth.login_failed", channel: "log", recipients: ["siem"] };
    expect(RuleInput.safeParse(good).success).toBe(true);
    expect(RuleInput.safeParse({ ...good, channel: "sms" }).success).toBe(false);
    expect(RuleInput.safeParse({ ...good, minRisk: "extreme" }).success).toBe(false);
    expect(RuleInput.safeParse({ ...good, condition: { field: "success" } }).success).toBe(false);
    expect(RuleInput.safeParse({ ...good, recipients: [] }).success).toBe(false);
  });

  describe("configured by an administrator, and seen to fire", () => {
    const app = createApp();
    beforeEach(() => {
      resetSecurityStoreForTests();
      resetRateLimitBucketsForTests();
      resetRulesForTests();
    });

    async function admin() {
      const agent = request.agent(app);
      await agent.post("/api/v1/auth/login").send({ username: "rishma@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);
      return agent;
    }
    async function elevated() {
      const agent = await admin();
      const { secret } = enrollMfa("usr_platform_admin_10001");
      confirmMfaEnrollment("usr_platform_admin_10001", authenticator.generate(secret));
      await agent.post("/api/v1/admin/elevate").send({ code: authenticator.generate(secret) }).expect(200);
      return agent;
    }

    it("creates, changes and removes a rule with no code change, audited with before and after values", async () => {
      const a = await elevated();
      const body = { name: "Failed sign-ins", eventPattern: "auth.login_failed", minRisk: "high", channel: "log", recipients: ["siem"], cooldownSeconds: 0 };
      const created = await a.post("/api/v1/admin/integrations/event-rules").send(body).expect(201);
      const id = created.body.rule.id as string;
      const updated = await a.put(`/api/v1/admin/integrations/event-rules/${id}`).send({ ...body, minRisk: "critical", enabled: false }).expect(200);
      expect(updated.body.rule).toMatchObject({ minRisk: "critical", enabled: false });
      const listed = await a.get("/api/v1/admin/integrations/event-rules").expect(200);
      expect(listed.body.rules).toHaveLength(1);
      const change = listAuditEvents().find((e) => e.action === "EVENT_RULE_UPDATED")?.metadata as { change: { fields: string[]; before: { minRisk: string }; after: { minRisk: string } } };
      expect(change.change.fields).toEqual(expect.arrayContaining(["minRisk", "enabled"]));
      expect(change.change).toMatchObject({ before: { minRisk: "high" }, after: { minRisk: "critical" } });
      await a.delete(`/api/v1/admin/integrations/event-rules/${id}`).expect(204);
      expect((await a.get("/api/v1/admin/integrations/event-rules")).body.rules).toHaveLength(0);
      expect(listAuditEvents().some((e) => e.action === "EVENT_RULE_CREATED")).toBe(true);
    });

    it("fires on a real event: a failed sign-in raises the alert the rule describes", async () => {
      const a = await elevated();
      await a.post("/api/v1/admin/integrations/event-rules").send({ name: "Failed sign-ins", eventPattern: "auth.login_failed", channel: "log", recipients: ["siem"], cooldownSeconds: 0 }).expect(201);
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const alerts: string[] = [];
      const off = onAlertForTests((alert) => alerts.push(alert.ruleName));
      await request(app).post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: "wrong-password", simulateRole: "remote_triage_nurse" }).expect(401);
      await new Promise((resolve) => setTimeout(resolve, 100));
      off();
      expect(alerts).toEqual(["Failed sign-ins"]);
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"type":"alert"'));
      expect(JSON.parse(line!)).toMatchObject({ type: "alert", rule: "Failed sign-ins", eventType: "auth.login_failed" });
      warn.mockRestore();
    });

    it("sends the email channel through the email adapter, and holds repeats back for the cooldown", async () => {
      const a = await elevated();
      await a.post("/api/v1/admin/integrations/event-rules").send({ name: "Mail me", eventPattern: "rule.test", channel: "email", recipients: ["security@irisstar.tech"], cooldownSeconds: 600 }).expect(201);
      const alerts: string[] = [];
      const off = onAlertForTests((alert) => alerts.push(alert.channel));
      await a.post("/api/v1/admin/integrations/event-rules/test-event").send({ type: "rule.test" }).expect(202);
      await a.post("/api/v1/admin/integrations/event-rules/test-event").send({ type: "rule.test" }).expect(202);
      await new Promise((resolve) => setTimeout(resolve, 100));
      off();
      expect(alerts).toEqual(["email"]);
    });

    it("rejects bad rules, email rules without addresses, and unknown rules; needs elevation to change", async () => {
      const a = await elevated();
      await a.post("/api/v1/admin/integrations/event-rules").send({ name: "x" }).expect(400);
      const noAddress = await a.post("/api/v1/admin/integrations/event-rules").send({ name: "Mail", eventPattern: "*", channel: "email", recipients: ["not-an-email"] }).expect(400);
      expect(noAddress.body.code).toBe("RULE_RECIPIENTS_INVALID");
      await a.put("/api/v1/admin/integrations/event-rules/nope").send({ name: "Rule", eventPattern: "*", channel: "log", recipients: ["siem"] }).expect(404);
      await a.post("/api/v1/admin/de-elevate").expect(200);
      await a.post("/api/v1/admin/integrations/event-rules").send({ name: "Rule", eventPattern: "*", channel: "log", recipients: ["siem"] }).expect(403);
      await a.get("/api/v1/admin/integrations/event-rules").expect(200);
    });
  });
});

describe("NFR-093 message-queue option", () => {
  afterEach(() => setBrokerPostForTests(undefined));

  it("is off unless configured, and validates what it needs", () => {
    expect(brokerFromEnv({})).toBeUndefined();
    expect(brokerFromEnv({ MESSAGE_BROKER: "none" })).toBeUndefined();
    expect(() => brokerFromEnv({ MESSAGE_BROKER: "pubsub" })).toThrow(/PUBSUB_PROJECT/);
    expect(() => brokerFromEnv({ MESSAGE_BROKER: "jms-bridge" })).toThrow(/JMS_BRIDGE_URL/);
    expect(() => brokerFromEnv({ MESSAGE_BROKER: "jms-bridge", JMS_BRIDGE_URL: "http://bridge.example", NODE_ENV: "production" })).toThrow(/https/);
    expect(() => brokerFromEnv({ MESSAGE_BROKER: "kafka" })).toThrow(/must be/);
    expect(brokerFromEnv({ MESSAGE_BROKER: "pubsub", PUBSUB_PROJECT: "p" })?.name).toBe("pubsub");
  });

  it("publishes CloudEvents JSON to Pub/Sub", async () => {
    const calls: Array<{ url: string; body: string; auth?: string }> = [];
    setBrokerPostForTests(async (url, init) => {
      calls.push({ url, body: String(init.body), auth: (init.headers as Record<string, string>).authorization });
      return new Response("{}", { status: 200 });
    });
    process.env.PUBSUB_ACCESS_TOKEN = "token-123";
    await new PubSubBroker("qr-project", "aimltriage-").publish("queue.item.completed", { id: "1", type: "x" }, { source: "/aimltriage" });
    delete process.env.PUBSUB_ACCESS_TOKEN;
    expect(calls[0].url).toBe("https://pubsub.googleapis.com/v1/projects/qr-project/topics/aimltriage-queue.item.completed:publish");
    expect(calls[0].auth).toBe("Bearer token-123");
    const message = JSON.parse(calls[0].body).messages[0];
    expect(JSON.parse(Buffer.from(message.data, "base64").toString())).toEqual({ id: "1", type: "x" });
    expect(message.attributes).toEqual({ source: "/aimltriage" });
  });

  it("publishes to a JMS-compatible broker through a signed bridge call, and reports a failure", async () => {
    process.env.JMS_BRIDGE_SECRET = "bridge-secret";
    const calls: Array<{ body: string; signature: string }> = [];
    setBrokerPostForTests(async (_url, init) => {
      calls.push({ body: String(init.body), signature: (init.headers as Record<string, string>)["x-bridge-signature"] });
      return new Response("{}", { status: 200 });
    });
    await new JmsBridgeBroker("https://bridge.example/in", "aimltriage.").publish("queue.item.completed", { id: "1" });
    expect(JSON.parse(calls[0].body)).toMatchObject({ destination: "aimltriage.queue.item.completed", type: "topic", body: { id: "1" } });
    expect(calls[0].signature).toMatch(/^[a-f0-9]{64}$/);
    setBrokerPostForTests(async () => new Response("no", { status: 503 }));
    await expect(new JmsBridgeBroker("https://bridge.example/in", "x.").publish("t", {})).rejects.toThrow(/503/);
    delete process.env.JMS_BRIDGE_SECRET;
  });
});
