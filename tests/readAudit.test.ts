import request from "supertest";
import { createApp } from "../src/app.js";
import { auditedScreens, resetReadAuditForTests } from "../src/middleware/readAudit.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { resetQueueStoreForTests } from "../src/services/queueOrchestration.js";
import { listAuditEvents, resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
const app = createApp();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function agent(username: string, role: string) {
  const a = request.agent(app);
  await a.post("/api/v1/auth/login").send({ username, password: process.env.ADMIN_PASSWORD, simulateRole: role }).expect(200);
  return a;
}
const reads = (since = "") => listAuditEvents().filter((e) => e.action === "DATA_READ" && e.timestampIso >= since);
const mark = async () => {
  await sleep(5);
  return new Date().toISOString();
};

describe("NFR-012 read-access auditing and trace view", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    resetSecurityStoreForTests();
    resetQueueStoreForTests();
    resetRateLimitBucketsForTests();
    resetReadAuditForTests();
  });
  afterEach(() => {
    process.env = { ...originalEnv, ADMIN_PASSWORD: "TestAdminPassword!2026" };
  });

  it("records who viewed a call record, with a reference and no content", async () => {
    const nurse = await agent("layla@irisstar.tech", "remote_triage_nurse");
    const since = await mark();
    await nurse.get("/api/v1/queue/case-10002").expect(200);
    await sleep(50);
    const event = reads(since).find((e) => e.resource === "TriageQueueItem");
    expect(event).toMatchObject({ userId: "usr_nurse_10001", recordReference: "case-10002", module: "DataAccess", success: true });
    expect(JSON.stringify(event)).not.toMatch(/narrative|vitals|summary/i);
  });

  it("does not record a read that failed", async () => {
    const nurse = await agent("layla@irisstar.tech", "remote_triage_nurse");
    const since = await mark();
    await nurse.get("/api/v1/queue/does-not-exist").expect(404);
    await sleep(50);
    expect(reads(since)).toHaveLength(0);
  });

  it("writes one entry for a screen that refreshes itself, and one per record viewed", async () => {
    const nurse = await agent("layla@irisstar.tech", "remote_triage_nurse");
    const since = await mark();
    for (let i = 0; i < 5; i += 1) await nurse.get("/api/v1/queue").expect(200);
    await nurse.get("/api/v1/queue/case-10002").expect(200);
    await nurse.get("/api/v1/queue/case-10002").expect(200);
    await nurse.get("/api/v1/queue/case-10003").expect(200);
    await sleep(80);
    const added = reads(since);
    expect(added.filter((e) => e.resource === "TriageQueue")).toHaveLength(1);
    expect(added.filter((e) => e.recordReference === "case-10002")).toHaveLength(1);
    expect(added.filter((e) => e.recordReference === "case-10003")).toHaveLength(1);
  });

  it("covers the user directory and the audit trail itself", async () => {
    const admin = await agent("rishma@irisstar.tech", "platform_super_administrator");
    const since = await mark();
    await admin.get("/api/v1/admin/users").expect(200);
    await admin.get("/api/v1/admin/audit-events").expect(200);
    await sleep(80);
    const resources = reads(since).map((e) => e.resource);
    expect(resources).toEqual(expect.arrayContaining(["UserDirectory", "AuditTrail"]));
  });

  it("can be narrowed to the agreed screens, but never switched off", () => {
    expect([...auditedScreens({})].length).toBeGreaterThanOrEqual(6);
    expect([...auditedScreens({ AUDIT_READ_SCREENS: "queue-item, user-record" })]).toEqual(["queue-item", "user-record"]);
    expect(() => auditedScreens({ AUDIT_READ_SCREENS: "payroll" })).toThrow(/unknown screens/);
    expect(() => auditedScreens({ AUDIT_READ_SCREENS: " , " })).toThrow(/cannot be switched off/);
  });

  it("stops recording a screen that is not on the agreed list", async () => {
    process.env.AUDIT_READ_SCREENS = "queue-item";
    const nurse = await agent("layla@irisstar.tech", "remote_triage_nurse");
    const since = await mark();
    await nurse.get("/api/v1/queue").expect(200);
    await nurse.get("/api/v1/queue/case-10002").expect(200);
    await sleep(80);
    expect(reads(since).map((e) => e.resource)).toEqual(["TriageQueueItem"]);
  });

  describe("trace view", () => {
    it("finds the modification history of a record, with before and after values", async () => {
      const nurse = await agent("layla@irisstar.tech", "remote_triage_nurse");
      await nurse.post("/api/v1/queue/case-10002/claim").expect(200);
      await nurse.patch("/api/v1/queue/case-10002/context").send({ vitals: { heartRate: 72 } }).expect(200);
      await nurse.get("/api/v1/queue/case-10002").expect(200);
      await sleep(80);

      const admin = await agent("rishma@irisstar.tech", "platform_super_administrator");
      const changes = await admin.get("/api/v1/admin/audit-trace?kind=changes&user=usr_nurse_10001").expect(200);
      const claim = changes.body.events.find((e: { action: string }) => e.action === "QUEUE_ITEM_CLAIM");
      expect(claim.change.fields).toEqual(expect.arrayContaining(["lockedBy"]));
      expect(claim.summary).toMatch(/usr_nurse_10001 .* queue item claim/);
      expect(changes.body.events.every((e: { action: string }) => e.action !== "DATA_READ")).toBe(true);

      const readsOnly = await admin.get("/api/v1/admin/audit-trace?kind=reads&user=usr_nurse_10001").expect(200);
      expect(readsOnly.body.events.length).toBeGreaterThan(0);
      expect(readsOnly.body.events.every((e: { action: string }) => e.action === "DATA_READ")).toBe(true);
      expect(readsOnly.body.events[0].summary).toMatch(/viewed/);
    });

    it("filters by record, action and time, and pages", async () => {
      const nurse = await agent("layla@irisstar.tech", "remote_triage_nurse");
      await nurse.get("/api/v1/queue/case-10002").expect(200);
      await nurse.get("/api/v1/queue/case-10003").expect(200);
      await sleep(80);
      const admin = await agent("rishma@irisstar.tech", "platform_super_administrator");
      const one = await admin.get("/api/v1/admin/audit-trace?record=case-10003").expect(200);
      expect(one.body.events.length).toBeGreaterThan(0);
      expect(one.body.events.every((e: { recordReference?: string }) => e.recordReference === "case-10003")).toBe(true);
      const none = await admin.get(`/api/v1/admin/audit-trace?until=2000-01-01`).expect(200);
      expect(none.body.count).toBe(0);
      const paged = await admin.get("/api/v1/admin/audit-trace?limit=1").expect(200);
      expect(paged.body.events).toHaveLength(1);
      expect(paged.body.nextOffset).toBe(1);
    });

    it("rejects bad filters and is closed to people who may not view audit information", async () => {
      const admin = await agent("rishma@irisstar.tech", "platform_super_administrator");
      await admin.get("/api/v1/admin/audit-trace?kind=everything").expect(400);
      await admin.get("/api/v1/admin/audit-trace?since=yesterday-ish").expect(400);
      const nurse = await agent("layla@irisstar.tech", "remote_triage_nurse");
      await nurse.get("/api/v1/admin/audit-trace").expect(403);
    });
  });
});
