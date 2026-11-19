import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { AUDIT_CHANGE_SCHEMA, buildAuditChange } from "../src/services/auditChange.js";
import { auditLedgerHash } from "../src/services/auditLedger.js";
import { resetQueueStoreForTests } from "../src/services/queueOrchestration.js";
import { listAuditEvents, resetSecurityStoreForTests } from "../src/services/securityAdmin.js";
import type { AuditEvent } from "../src/types/security.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
const app = createApp();

async function nurseAgent() {
  const agent = request.agent(app);
  await agent
    .post("/api/v1/auth/login")
    .send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" })
    .expect(200);
  return agent;
}

describe("M-007 before and after values", () => {
  describe("buildAuditChange", () => {
    it("keeps only the fields that changed", () => {
      const change = buildAuditChange({ status: "INCOMING", stage: "A", severity: "LOW" }, { status: "IN_PROCESS", stage: "A", severity: "LOW" });
      expect(change.schema).toBe(AUDIT_CHANGE_SCHEMA);
      expect(change.fields).toEqual(["status"]);
      expect(change.before).toEqual({ status: "INCOMING" });
      expect(change.after).toEqual({ status: "IN_PROCESS" });
    });

    it("lists every field on a create and every field on a delete", () => {
      expect(buildAuditChange(null, { status: "INCOMING" })).toMatchObject({ before: null, after: { status: "INCOMING" } });
      expect(buildAuditChange({ status: "X" }, null)).toMatchObject({ before: { status: "X" }, after: null });
    });

    it("limits the comparison to the agreed fields when asked", () => {
      const change = buildAuditChange({ a: 1, b: 1 }, { a: 2, b: 2 }, ["a"]);
      expect(change.fields).toEqual(["a"]);
    });

    it("redacts sensitive values and truncates long text", () => {
      const change = buildAuditChange({ note: "x", passwordHash: "old" }, { note: "y".repeat(900), passwordHash: "new" });
      expect(change.before).toMatchObject({ passwordHash: "[redacted]" });
      expect(change.after).toMatchObject({ passwordHash: "[redacted]" });
      expect(String((change.after as Record<string, unknown>).note)).toMatch(/\[truncated\]$/);
    });

    it("treats a missing value and null as the same", () => {
      expect(buildAuditChange({ a: undefined }, { a: null }).fields).toEqual([]);
    });
  });

  describe("hash chain", () => {
    const base: AuditEvent = {
      id: "evt-1",
      timestampIso: "2026-11-19T00:00:00.000Z",
      userId: "u1",
      activeRole: "remote_triage_nurse",
      organization: "org",
      facility: "",
      department: "",
      action: "QUEUE_CONTEXT_UPDATE",
      module: "Queue",
      resource: "TriageQueueItem:1",
      ipAddress: "",
      device: "",
      success: true,
      risk: "medium",
      metadata: { changedFields: ["dispositionCode"] }
    };
    const prev = "0".repeat(64);

    it("signs before and after values, so editing them breaks the hash", () => {
      const signed = { ...base, metadata: { ...base.metadata, change: buildAuditChange({ dispositionCode: "A" }, { dispositionCode: "B" }) } };
      const hash = auditLedgerHash(signed, prev, "v1", "test-secret");
      const tampered = { ...signed, metadata: { ...signed.metadata, change: buildAuditChange({ dispositionCode: "A" }, { dispositionCode: "C" }) } };
      expect(auditLedgerHash(tampered, prev, "v1", "test-secret")).not.toBe(hash);
      expect(auditLedgerHash(JSON.parse(JSON.stringify(signed)), prev, "v1", "test-secret")).toBe(hash);
    });

    it("leaves the hash of an entry written before this change untouched", () => {
      // Pinned value computed on the 1cb733d baseline: entries without before and after
      // values must keep verifying exactly as they did.
      expect(auditLedgerHash(base, prev, "v1", "test-secret")).toBe("5bca092e3ba4f1e782e09c4853b696ea2d0af43059caf196f5622e3c3357912f");
    });
  });

  describe("queue audit entries", () => {
    beforeEach(() => {
      resetQueueStoreForTests();
      resetSecurityStoreForTests();
      resetRateLimitBucketsForTests();
    });

    it("records before and after for a claim and a disposition change", async () => {
      const nurse = await nurseAgent();
      await nurse.post("/api/v1/queue/case-10002/claim").expect(200);
      await nurse.patch("/api/v1/queue/case-10002/context").send({ vitals: { heartRate: 72 } }).expect(200);

      const events = listAuditEvents();
      const claim = events.find((e) => e.action === "QUEUE_ITEM_CLAIM");
      const change = (claim?.metadata as { change?: ReturnType<typeof buildAuditChange> } | undefined)?.change;
      expect(change?.schema).toBe(AUDIT_CHANGE_SCHEMA);
      expect(change?.fields).toEqual(expect.arrayContaining(["assignedNurseId", "lockedBy"]));
      expect(change?.before).toMatchObject({ lockedBy: null });
      expect(change?.after).toMatchObject({ lockedBy: expect.any(String) });
      expect(events.some((e) => e.action === "QUEUE_CONTEXT_UPDATE" && (e.metadata as { change?: unknown })?.change)).toBe(true);
    });
  });
});
