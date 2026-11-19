import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basePrisma } from "../src/db.js";
import { appendOperationalAuditEvent, verifyAuditEventChain } from "../src/services/auditLedger.js";
import { resetAuditForwarderForTests, signAuditPayload } from "../src/services/auditForwarding.js";
import { buildAuditChange } from "../src/services/auditChange.js";
import {
  consumeExportApproval,
  decideExportApproval,
  ExportGovernanceError,
  requestExportApproval
} from "../src/services/exportGovernance.js";
import { isEncryptedValue, withFieldEncryption } from "../src/services/fieldEncryption.js";
import { resetSecretProvider } from "../src/config/secrets.js";
import { resetKeyProvider } from "../src/services/keyProvider.js";

// Sprint 1 paths that need a real PostgreSQL database. Skipped when DATABASE_URL is not
// set; in CI the isolated test database is migrated first (see .github/workflows/ci.yml).
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("Sprint 1 database-backed behaviour", () => {
  const originalEnv = { ...process.env };
  const run = `s1-${Date.now()}`;

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSecretProvider();
    resetKeyProvider();
    resetAuditForwarderForTests();
  });
  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  describe("M-019/M-020 field encryption", () => {
    const KEY_A = "db-test-field-key-A-0123456789abcdef";
    const KEY_B = "db-test-field-key-B-0123456789abcdef";

    it("stores ciphertext, returns plaintext, and encrypts nested relation writes", async () => {
      process.env.FIELD_ENCRYPTION_KEY = KEY_A;
      const encrypted = withFieldEncryption(basePrisma);
      const staff = await encrypted.staffMember.create({
        data: {
          istStaffId: `${run}-staff`,
          department: "Ops",
          jobTitle: "Tester",
          dependents: { create: [{ fullName: "Dependent Secret Name", relationshipType: "CHILD", age: 7, biologicalSex: "FEMALE" }] }
        },
        include: { dependents: true }
      });
      expect(staff.dependents[0].fullName).toBe("Dependent Secret Name");
      const rawDependent = await basePrisma.dependent.findFirstOrThrow({ where: { staffMemberId: staff.id } });
      expect(isEncryptedValue(rawDependent.fullName)).toBe(true);
      expect(rawDependent.fullName).not.toContain("Secret");

      const item = await encrypted.triageQueueItem.create({
        data: {
          istStaffId: `${run}-staff`,
          slaDeadline: new Date(Date.now() + 3600000),
          summary: "crushing chest pain",
          vitals: { heartRate: 131 },
          queuePayload: { reasonNarrative: "private story" },
          staffMemberId: staff.id
        }
      });
      expect(item.vitals).toEqual({ heartRate: 131 });
      const raw = await basePrisma.triageQueueItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(isEncryptedValue(raw.summary)).toBe(true);
      expect(typeof raw.vitals).toBe("string");
      expect(JSON.stringify(raw)).not.toMatch(/chest pain|private story|131/);

      const read = await encrypted.triageQueueItem.findUniqueOrThrow({ where: { id: item.id }, include: { staffMember: { include: { dependents: true } } } });
      expect(read.summary).toBe("crushing chest pain");
      expect(read.queuePayload).toEqual({ reasonNarrative: "private story" });
      expect(read.staffMember?.dependents[0].fullName).toBe("Dependent Secret Name");

      const updated = await encrypted.triageQueueItem.update({ where: { id: item.id }, data: { summary: "revised note" } });
      expect(updated.summary).toBe("revised note");
      expect(isEncryptedValue((await basePrisma.triageQueueItem.findUniqueOrThrow({ where: { id: item.id } })).summary)).toBe(true);
    });

    it("backfills legacy plaintext and re-wraps data keys after a rotation", async () => {
      const staffId = `${run}-legacy`;
      const legacy = await basePrisma.triageQueueItem.create({
        data: { istStaffId: staffId, slaDeadline: new Date(), summary: "legacy plaintext note", vitals: { heartRate: 70 } }
      });
      const env = { ...process.env, FIELD_ENCRYPTION_KEY: KEY_A, NODE_ENV: "test" };
      const script = (extra: string[], overrides: Record<string, string> = {}) =>
        execFileSync("npx", ["tsx", "src/scripts/encryptStoredFields.ts", "--models=TriageQueueItem", ...extra], { env: { ...env, ...overrides }, encoding: "utf8" });

      const dry = JSON.parse(script([]).slice(script([]).indexOf("{")));
      expect(dry.mode).toBe("DRY RUN");
      expect(dry.summary.TriageQueueItem.encrypted).toBeGreaterThan(0);
      expect((await basePrisma.triageQueueItem.findUniqueOrThrow({ where: { id: legacy.id } })).summary).toBe("legacy plaintext note");

      script(["--execute"]);
      const afterBackfill = await basePrisma.triageQueueItem.findUniqueOrThrow({ where: { id: legacy.id } });
      expect(isEncryptedValue(afterBackfill.summary)).toBe(true);
      const oldKeyId = (afterBackfill.summary as string).split(":")[2];

      script(["--execute", "--rewrap"], { FIELD_ENCRYPTION_KEY: KEY_B, FIELD_ENCRYPTION_KEY_PREVIOUS: KEY_A });
      const rotated = await basePrisma.triageQueueItem.findUniqueOrThrow({ where: { id: legacy.id } });
      expect((rotated.summary as string).split(":")[2]).not.toBe(oldKeyId);

      process.env.FIELD_ENCRYPTION_KEY = KEY_B;
      delete process.env.FIELD_ENCRYPTION_KEY_PREVIOUS;
      const read = await withFieldEncryption(basePrisma).triageQueueItem.findUniqueOrThrow({ where: { id: legacy.id } });
      expect(read.summary).toBe("legacy plaintext note");
      expect(read.vitals).toEqual({ heartRate: 70 });
    }, 120000);
  });

  describe("M-021 export approvals in the database", () => {
    beforeEach(() => {
      process.env.MOCK_MODE = "false";
    });

    it("binds an approval to requester and organisation, blocks self-approval, and works once even under a race", async () => {
      const approval = await requestExportApproval({ exportKind: "organization", resourceId: `${run}-org`, requesterId: "admin-a", reason: "database test" });
      await expect(decideExportApproval({ id: approval.id, approverId: "admin-a", decision: "approve" })).rejects.toMatchObject({ code: "EXPORT_SELF_APPROVAL" });
      await expect(consumeExportApproval({ id: approval.id, exportKind: "organization", resourceId: `${run}-org`, requesterId: "admin-a" })).rejects.toMatchObject({ code: "EXPORT_APPROVAL_REQUIRED" });
      await decideExportApproval({ id: approval.id, approverId: "admin-b", decision: "approve" });
      await expect(decideExportApproval({ id: approval.id, approverId: "admin-c", decision: "reject" })).rejects.toMatchObject({ code: "EXPORT_REQUEST_DECIDED" });
      await expect(consumeExportApproval({ id: approval.id, exportKind: "organization", resourceId: "other-org", requesterId: "admin-a" })).rejects.toBeInstanceOf(ExportGovernanceError);
      await expect(consumeExportApproval({ id: approval.id, exportKind: "organization", resourceId: `${run}-org`, requesterId: "someone-else" })).rejects.toBeInstanceOf(ExportGovernanceError);

      const attempts = await Promise.allSettled([1, 2, 3, 4].map(() => consumeExportApproval({ id: approval.id, exportKind: "organization", resourceId: `${run}-org`, requesterId: "admin-a" })));
      expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    });

    it("expires an approval", async () => {
      process.env.EXPORT_APPROVAL_TTL_MINUTES = "0.0001";
      const approval = await requestExportApproval({ exportKind: "organization", resourceId: `${run}-org2`, requesterId: "admin-a", reason: "expiry test" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(decideExportApproval({ id: approval.id, approverId: "admin-b", decision: "approve" })).rejects.toMatchObject({ code: "EXPORT_REQUEST_EXPIRED" });
    });
  });

  describe("M-007 and M-008 in the hash-chained ledger", () => {
    let server: Server;
    const received: Array<{ body: string; signature: string }> = [];
    beforeAll(async () => {
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          received.push({ body, signature: String(req.headers["x-audit-signature"]) });
          res.writeHead(200).end("ok");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it("keeps the chain valid with before and after values, and forwards each event with a valid signature", async () => {
      process.env.AUDIT_HMAC_SECRET = "ledger-secret-for-database-test";
      process.env.AUDIT_FORWARD_SECRET = "forward-secret-for-database-test";
      const port = (server.address() as AddressInfo).port;
      process.env.AUDIT_FORWARD_SINKS = JSON.stringify([{ name: "local", type: "https", url: `http://127.0.0.1:${port}/audit` }]);
      resetAuditForwarderForTests();

      const change = buildAuditChange({ dispositionCode: "A" }, { dispositionCode: "B" });
      const first = await appendOperationalAuditEvent({ action: "QUEUE_CONTEXT_UPDATE", module: "Queue", resource: "TriageQueueItem", recordReference: run, success: true, metadata: { change } });
      const second = await appendOperationalAuditEvent({ action: "QUEUE_ITEM_MOVE", module: "Queue", resource: "TriageQueueItem", recordReference: run, success: true });
      await new Promise((resolve) => setTimeout(resolve, 500));

      const verification = await verifyAuditEventChain();
      expect(verification.valid).toBe(true);
      const stored = await basePrisma.auditEvent.findFirstOrThrow({ where: { eventHash: first.eventHash } });
      expect((stored.metadata as { change: typeof change }).change.after).toEqual({ dispositionCode: "B" });

      const events = received.flatMap((r) => (JSON.parse(r.body).events as Array<{ eventHash: string; sequenceNumber: string; previousHash: string }>));
      expect(events.map((e) => e.eventHash)).toEqual(expect.arrayContaining([first.eventHash, second.eventHash]));
      const forwardedSecond = events.find((e) => e.eventHash === second.eventHash)!;
      expect(forwardedSecond.previousHash).toBe(first.eventHash);
      for (const r of received) expect(r.signature).toBe(signAuditPayload(r.body, "forward-secret-for-database-test"));
    });

    it("does not fail or corrupt the ledger when a sink is down", async () => {
      process.env.AUDIT_HMAC_SECRET = "ledger-secret-for-database-test";
      process.env.AUDIT_FORWARD_SECRET = "forward-secret-for-database-test";
      process.env.AUDIT_FORWARD_SINKS = JSON.stringify([{ name: "down", type: "https", url: "http://127.0.0.1:1/audit", timeoutMs: 300 }]);
      resetAuditForwarderForTests();
      const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
      const event = await appendOperationalAuditEvent({ action: "QUEUE_ITEM_CLAIM", module: "Queue", resource: "TriageQueueItem", recordReference: `${run}-down`, success: true });
      expect(event.eventHash).toMatch(/^[a-f0-9]{64}$/);
      expect((await verifyAuditEventChain()).valid).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      errors.mockRestore();
    });

    it("still rejects deleting or editing an audit event at the database", async () => {
      await expect(basePrisma.$executeRawUnsafe(`DELETE FROM "audit_events" WHERE "record_reference" = '${run}'`)).rejects.toThrow(/append-only/);
      await expect(basePrisma.$executeRawUnsafe(`UPDATE "audit_events" SET "action" = 'X' WHERE "record_reference" = '${run}'`)).rejects.toThrow(/append-only/);
    });
  });
});
