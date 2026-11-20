import type { Application } from "express";

// Sprint 4 paths that need PostgreSQL: durable webhook delivery with retry, dead-letter and replay, the
// integration job queue, and the interface watcher log. Skipped without DATABASE_URL.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
process.env.MOCK_MODE = "false"; // database persistence on for the subsystems under test
process.env.AUDIT_EVENT_DB_PERSISTENCE = "true";
process.env.AUDIT_HMAC_SECRET ??= "ci-only-audit-hmac-secret-not-for-production";
process.env.FIELD_ENCRYPTION_ENABLED = "true";
process.env.FIELD_ENCRYPTION_KEY = "sprint4-field-key-0123456789abcdef";
process.env.WEBHOOK_MAX_ATTEMPTS = "3";
process.env.WEBHOOK_BACKOFF_BASE_MS = "1000";

describeDb("Sprint 4 database-backed behaviour", () => {
  let basePrisma: typeof import("../src/db.js").basePrisma;
  let wh: typeof import("../src/services/webhooks.js");
  let bus: typeof import("../src/services/eventBus.js");
  let jobs: typeof import("../src/services/integrationQueue.js");
  const run = `s4-${Date.now()}`;

  beforeAll(async () => {
    ({ basePrisma } = await import("../src/db.js"));
    wh = await import("../src/services/webhooks.js");
    bus = await import("../src/services/eventBus.js");
    jobs = await import("../src/services/integrationQueue.js");
    (await import("../src/services/platformEvents.js")).registerPlatformSubscribers();
    // Start from an empty queue so earlier runs cannot be picked up by these workers.
    await basePrisma.webhookDelivery.deleteMany({});
    await basePrisma.webhookSubscription.deleteMany({});
    await basePrisma.integrationJob.deleteMany({});
  });
  afterEach(() => wh.setWebhookSenderForTests(undefined));
  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  const event = (type: string): import("../src/services/eventBus.js").PlatformEvent => ({ id: `${run}-${type}-${Math.random()}`, type, occurredAtIso: new Date().toISOString(), risk: "low", success: true, subject: "case-1", data: { action: type.toUpperCase(), userId: "u1" } });

  describe("NFR-166 outbound webhooks", () => {
    async function subscription(events: string[]) {
      const { id, secret } = await wh.createSubscription({ name: `${run}-sub`, url: "http://localhost:9999/hook", events }, "usr_test");
      return { id, secret };
    }

    it("stores the signing secret encrypted, and queues a delivery only for matching subscriptions", async () => {
      const match = await subscription(["queue.*"]);
      const other = await subscription(["export.*"]);
      const raw = await basePrisma.webhookSubscription.findUniqueOrThrow({ where: { id: match.id } });
      expect(raw.secret).toMatch(/^enc:v1:/);
      expect(raw.secret).not.toContain("whsec_");
      const e = event("queue.item.completed");
      await bus.publishEvent(e);
      expect(await basePrisma.webhookDelivery.count({ where: { eventId: e.id, subscriptionId: match.id } })).toBe(1);
      expect(await basePrisma.webhookDelivery.count({ where: { eventId: e.id, subscriptionId: other.id } })).toBe(0);
      await basePrisma.webhookSubscription.deleteMany({ where: { id: { in: [match.id, other.id] } } });
    });

    it("delivers a signed CloudEvents POST the receiver can verify", async () => {
      const { id, secret } = await subscription(["*"]);
      const e = event("approval.recorded");
      await bus.publishEvent(e);
      const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
      wh.setWebhookSenderForTests(async (url, init) => {
        sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
        return new Response("ok", { status: 200 });
      });
      const result = await wh.processDueDeliveries({ limit: 200 });
      expect(result.succeeded).toBeGreaterThanOrEqual(1);
      const mine = sent.find((s) => JSON.parse(s.body).id === e.id)!;
      expect(mine.headers["content-type"]).toBe("application/cloudevents+json");
      expect(wh.verifyWebhookSignature(secret, mine.headers["x-webhook-signature"], mine.body)).toBe(true);
      expect(JSON.parse(mine.body)).toMatchObject({ specversion: "1.0", type: "com.irisstar.aimltriage.approval.recorded" });
      const delivery = await basePrisma.webhookDelivery.findFirstOrThrow({ where: { eventId: e.id, subscriptionId: id } });
      expect(delivery).toMatchObject({ status: "succeeded", attempts: 1 });
      await basePrisma.webhookSubscription.delete({ where: { id } });
    });

    it("retries a failure with exponential back-off, dead-letters it after the last attempt, and replays it", async () => {
      const { id } = await subscription(["retry.*"]);
      const e = event("retry.me");
      await bus.publishEvent(e);
      let answer = 500;
      let calls = 0;
      wh.setWebhookSenderForTests(async () => {
        calls += 1;
        return new Response("nope", { status: answer });
      });
      const find = () => basePrisma.webhookDelivery.findFirstOrThrow({ where: { eventId: e.id, subscriptionId: id } });
      const t0 = new Date();
      const first = await wh.processDueDeliveries({ limit: 500, now: t0 });
      let d = await find();
      expect(d).toMatchObject({ status: "pending", attempts: 1, lastStatus: 500 });
      expect(d.nextAttemptAt.getTime() - t0.getTime()).toBeGreaterThanOrEqual(900); // about 1 s

      // Not due yet: nothing is sent.
      const before = calls;
      await wh.processDueDeliveries({ limit: 500, now: new Date(t0.getTime() + 100) });
      expect(calls).toBe(before);

      const t1 = new Date(t0.getTime() + 5000);
      await wh.processDueDeliveries({ limit: 500, now: t1 });
      d = await find();
      expect(d.attempts).toBe(2);
      expect(d.nextAttemptAt.getTime() - t1.getTime()).toBeGreaterThanOrEqual(1800); // about 2 s: doubled

      await wh.processDueDeliveries({ limit: 500, now: new Date(t1.getTime() + 10_000) });
      d = await find();
      expect(d).toMatchObject({ status: "dead", attempts: 3, lastError: "HTTP 500" });
      expect(await basePrisma.auditEvent.findFirst({ where: { action: "WEBHOOK_DELIVERY_DEAD", resource: `WebhookDelivery:${d.id}` } })).not.toBeNull();

      // The dead-letter queue is replayable once the receiver is back.
      answer = 200;
      expect(await wh.replayDeliveries({ id: d.id })).toBe(1);
      await wh.processDueDeliveries({ limit: 500, now: new Date(Date.now() + 1000) });
      expect(await find()).toMatchObject({ status: "succeeded", attempts: 1 });
      await basePrisma.webhookSubscription.delete({ where: { id } });
    });

    it("sends a delivery once even when two workers run at the same time", async () => {
      const { id } = await subscription(["race.*"]);
      const e = event("race.now");
      await bus.publishEvent(e);
      let calls = 0;
      wh.setWebhookSenderForTests(async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return new Response("ok", { status: 200 });
      });
      await Promise.all([wh.processDueDeliveries({ limit: 500 }), wh.processDueDeliveries({ limit: 500 }), wh.processDueDeliveries({ limit: 500 })]);
      expect(calls).toBe(1);
      await basePrisma.webhookSubscription.delete({ where: { id } });
    });

    it("does not send to a paused subscription", async () => {
      const { id } = await subscription(["paused.*"]);
      await basePrisma.webhookSubscription.update({ where: { id }, data: { status: "paused" } });
      const e = event("paused.event");
      await bus.publishEvent(e);
      expect(await basePrisma.webhookDelivery.count({ where: { eventId: e.id } })).toBe(0);
      await basePrisma.webhookSubscription.delete({ where: { id } });
    });
  });

  describe("NFR-094 queue-based integration processing", () => {
    it("runs a job, retries a failure with back-off, dead-letters it, and replays it", async () => {
      let fail = true;
      let ran = 0;
      jobs.registerJobHandler("test.job", async () => {
        ran += 1;
        if (fail) throw new Error("partner unavailable");
      });
      process.env.INTEGRATION_JOB_MAX_ATTEMPTS = "2";
      process.env.INTEGRATION_JOB_BACKOFF_BASE_MS = "1000";
      const id = await jobs.enqueueJob({ type: "test.job", payload: { n: 1 }, correlationId: `${run}-job` });
      const t0 = new Date();
      expect((await jobs.processJobs({ types: ["test.job"], now: t0 })).retried).toBe(1);
      let row = await basePrisma.integrationJob.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "partner unavailable", correlationId: `${run}-job` });
      expect((await jobs.processJobs({ types: ["test.job"], now: new Date(t0.getTime() + 20_000) })).dead).toBe(1);
      row = await basePrisma.integrationJob.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("dead");

      fail = false;
      expect(await jobs.replayJobs({ id })).toBe(1);
      expect((await jobs.processJobs({ types: ["test.job"], now: new Date(Date.now() + 1000) })).succeeded).toBe(1);
      expect(await basePrisma.integrationJob.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "succeeded", attempts: 1 });
      expect(ran).toBe(3);
      delete process.env.INTEGRATION_JOB_MAX_ATTEMPTS;
    });

    it("keeps events for a broker that is down and delivers them when it is back", async () => {
      const { setBrokerPostForTests } = await import("../src/integration/messageBroker.js");
      process.env.MESSAGE_BROKER = "pubsub";
      process.env.PUBSUB_PROJECT = "qr";
      process.env.PUBSUB_ACCESS_TOKEN = "t";
      let up = false;
      const published: string[] = [];
      setBrokerPostForTests(async (_url, init) => {
        if (!up) return new Response("down", { status: 503 });
        published.push(JSON.parse(Buffer.from(JSON.parse(String(init.body)).messages[0].data, "base64").toString()).id);
        return new Response("{}", { status: 200 });
      });
      const e = event("broker.test");
      await bus.publishEvent(e);
      await jobs.processJobs({ types: ["broker.publish"], limit: 500 });
      expect(published).toEqual([]);
      const pending = await basePrisma.integrationJob.findMany({ where: { type: "broker.publish", correlationId: e.id } });
      expect(pending).toHaveLength(1);
      up = true;
      await basePrisma.integrationJob.update({ where: { id: pending[0].id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await jobs.processJobs({ types: ["broker.publish"], limit: 500 });
      expect(published).toEqual([e.id]);
      setBrokerPostForTests(undefined);
      delete process.env.MESSAGE_BROKER;
      delete process.env.PUBSUB_PROJECT;
      delete process.env.PUBSUB_ACCESS_TOKEN;
    });
  });

  describe("NFR-096 interface watcher in the database", () => {
    it("writes the entry before the call, then its outcome, and keeps the payload redacted", async () => {
      process.env.INTERFACE_LOG_DB_PERSISTENCE = "true";
      const { callExternal, setExternalClientForTests } = await import("../src/integration/externalClient.js");
      let rowDuringCall = 0;
      setExternalClientForTests({
        fetch: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          rowDuringCall = await basePrisma.interfaceLog.count({ where: { correlationId: `${run}-corr` } });
          return new Response("{}", { status: 200 });
        }
      });
      await callExternal("emr-fhir", "https://emr.example/fhir/DocumentReference", { method: "POST", body: JSON.stringify({ patient: { fullName: "Secret Name" }, kind: "note" }) }, { correlationId: `${run}-corr` });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(rowDuringCall).toBe(1);
      const row = await basePrisma.interfaceLog.findFirstOrThrow({ where: { correlationId: `${run}-corr` } });
      expect(row).toMatchObject({ direction: "outbound", integration: "emr-fhir", sender: "aimltriage", receiver: "emr.example", status: 200, attempts: 1 });
      expect(row.durationMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(row.payload)).not.toContain("Secret Name");
      setExternalClientForTests(undefined);
      delete process.env.INTERFACE_LOG_DB_PERSISTENCE;
    });
  });
});
