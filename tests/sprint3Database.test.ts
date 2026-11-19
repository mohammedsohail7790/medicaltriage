import { Prisma } from "@prisma/client";

// Sprint 3 paths that need a real PostgreSQL database. Skipped when DATABASE_URL is not set;
// CI migrates an isolated test database first.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("Sprint 3 database-backed behaviour", () => {
  let basePrisma: typeof import("../src/db.js").basePrisma;
  let tx: typeof import("../src/services/dbTransaction.js");
  const run = `s3-${Date.now()}`;

  beforeAll(async () => {
    ({ basePrisma } = await import("../src/db.js"));
    tx = await import("../src/services/dbTransaction.js");
  });
  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  describe("NFR-060 transaction boundaries", () => {
    it("rolls back every write of a unit of work when a later one fails", async () => {
      const staffId = `${run}-rollback`;
      await expect(
        tx.runInTransaction(async (t) => {
          await t.staffMember.create({ data: { istStaffId: staffId, department: "Ops", jobTitle: "Tester" } });
          await t.staffMember.create({ data: { istStaffId: staffId, department: "Ops", jobTitle: "Duplicate" } }); // unique violation
        })
      ).rejects.toThrow();
      expect(await basePrisma.staffMember.count({ where: { istStaffId: staffId } })).toBe(0);
    });

    it("writes an encounter and its safety audit log together, or neither", async () => {
      const staff = await basePrisma.staffMember.create({ data: { istStaffId: `${run}-enc`, department: "Ops", jobTitle: "Tester" } });
      const goodBase = {
        staffMember: { connect: { id: staff.id } },
        initialAcuityScore: 2,
        finalDispositionCode: "HMC_EMERGENCY_DEPARTMENT" as const,
        nurseId: "nurse-1",
        completedAt: new Date()
      };
      const both = await basePrisma.aviationTriageEncounter.create({
        data: {
          ...goodBase,
          safetyLog: { create: { originalAiRecommendation: "NONE", rulesEngineSeverity: "URGENT", overrideStatusFlag: "REVIEW_REQUIRED", explainabilityTrace: [] } }
        },
        include: { safetyLog: true }
      }).catch((error: Error) => error);
      // The enum values are the schema's own; fall back to reading them if these names differ.
      if (both instanceof Error) throw both;
      expect(both.safetyLog).not.toBeNull();

      const before = await basePrisma.aviationTriageEncounter.count({ where: { staffMemberId: staff.id } });
      await expect(
        basePrisma.aviationTriageEncounter.create({
          data: { ...goodBase, safetyLog: { create: { originalAiRecommendation: "NONE", rulesEngineSeverity: "NOT_A_SEVERITY" as never, overrideStatusFlag: "REVIEW_REQUIRED", explainabilityTrace: [] } } }
        })
      ).rejects.toThrow();
      expect(await basePrisma.aviationTriageEncounter.count({ where: { staffMemberId: staff.id } })).toBe(before);
    });

    it("does not lose updates when many requests extend the same trace at once", async () => {
      const staff = await basePrisma.staffMember.create({ data: { istStaffId: `${run}-trace`, department: "Ops", jobTitle: "Tester" } });
      const encounter = await basePrisma.aviationTriageEncounter.create({
        data: { staffMember: { connect: { id: staff.id } }, initialAcuityScore: 2, finalDispositionCode: "HMC_EMERGENCY_DEPARTMENT", nurseId: "n", completedAt: new Date() }
      });
      await basePrisma.safetyAuditDeviationLog.create({
        data: { encounterId: encounter.id, originalAiRecommendation: "NONE", rulesEngineSeverity: "URGENT", overrideStatusFlag: "REVIEW_REQUIRED", explainabilityTrace: [] }
      });
      const append = (n: number) =>
        tx.runInTransaction(
          async (t) => {
            const row = await t.safetyAuditDeviationLog.findUniqueOrThrow({ where: { encounterId: encounter.id } });
            const trace = Array.isArray(row.explainabilityTrace) ? row.explainabilityTrace : [];
            await t.safetyAuditDeviationLog.update({ where: { encounterId: encounter.id }, data: { explainabilityTrace: [...trace, { n }] as Prisma.InputJsonValue } });
          },
          { serializable: true, attempts: 12 }
        );
      await Promise.all(Array.from({ length: 8 }, (_, n) => append(n)));
      const row = await basePrisma.safetyAuditDeviationLog.findUniqueOrThrow({ where: { encounterId: encounter.id } });
      expect((row.explainabilityTrace as Array<{ n: number }>).map((e) => e.n).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    }, 30000);
  });

  describe("NFR-059 integrity checks", () => {
    const oldEnv = { ...process.env };
    beforeEach(() => {
      process.env.AUDIT_EVENT_DB_PERSISTENCE = "true";
      process.env.AUDIT_HMAC_SECRET ??= "ci-only-audit-hmac-secret-not-for-production";
      process.env.FIELD_ENCRYPTION_KEY = "sprint3-field-key-0123456789abcdef";
    });
    afterEach(() => {
      process.env = { ...oldEnv };
    });

    it("passes on healthy data and records a passing event", async () => {
      const { runIntegrityChecks } = await import("../src/services/integrityChecks.js");
      const report = await runIntegrityChecks({ only: ["audit-ledger", "soft-delete", "completed-cases"] });
      expect(report.checks.find((c) => c.name === "audit-ledger")?.checked).toBeGreaterThan(0);
      expect(report.ok).toBe(true);
      expect((await basePrisma.auditEvent.findFirst({ where: { action: "INTEGRITY_CHECK_PASSED", recordReference: report.id } }))).not.toBeNull();
    });

    it("flags a completed case with no encounter, a deletion with no user, and a value that cannot be decrypted, and raises a critical alert", async () => {
      const { runIntegrityChecks } = await import("../src/services/integrityChecks.js");
      const { withFieldEncryption } = await import("../src/services/fieldEncryption.js");
      const orphan = await basePrisma.triageQueueItem.create({ data: { istStaffId: `${run}-orphan`, slaDeadline: new Date(), status: "COMPLETED" } });
      const noActor = await basePrisma.triageQueueItem.create({ data: { istStaffId: `${run}-noactor`, slaDeadline: new Date(), deletedAt: new Date() } });
      const corrupt = await withFieldEncryption(basePrisma).triageQueueItem.create({ data: { istStaffId: `${run}-corrupt`, slaDeadline: new Date(), summary: "private note" } });
      const stored = (await basePrisma.triageQueueItem.findUniqueOrThrow({ where: { id: corrupt.id } })).summary as string;
      const parts = stored.split(":");
      parts[6] = Buffer.from("damaged").toString("base64url");
      await basePrisma.triageQueueItem.update({ where: { id: corrupt.id }, data: { summary: parts.join(":") } });

      const report = await runIntegrityChecks({ only: ["completed-cases", "soft-delete", "encrypted-fields"] });
      expect(report.ok).toBe(false);
      const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
      expect(byName["completed-cases"].problems.map((p) => p.reference)).toContain(`TriageQueueItem:${orphan.id}`);
      expect(byName["soft-delete"].problems.map((p) => p.reference)).toContain(`TriageQueueItem:${noActor.id}`);
      expect(byName["encrypted-fields"].problems.map((p) => p.reference)).toContain(`TriageQueueItem.summary:${corrupt.id}`);
      expect(JSON.stringify(report)).not.toContain("private note");
      const alert = await basePrisma.auditEvent.findFirst({ where: { action: "INTEGRITY_CHECK_FAILED", recordReference: report.id } });
      expect(alert?.riskLevel).toBe("critical");
      for (const id of [orphan.id, noActor.id, corrupt.id]) await basePrisma.triageQueueItem.delete({ where: { id } });
    });

    it("repairs an expired lock that was left behind, and leaves a fresh lock alone", async () => {
      const { runIntegrityChecks } = await import("../src/services/integrityChecks.js");
      const stale = await basePrisma.triageQueueItem.create({ data: { istStaffId: `${run}-stale`, slaDeadline: new Date(), lockedBy: "nurse-x", lockExpiresAt: new Date(Date.now() - 3 * 3600_000) } });
      const fresh = await basePrisma.triageQueueItem.create({ data: { istStaffId: `${run}-fresh`, slaDeadline: new Date(), lockedBy: "nurse-y", lockExpiresAt: new Date(Date.now() + 300_000) } });
      const report = await runIntegrityChecks({ only: ["stale-locks"] });
      expect(report.checks[0].repaired).toBeGreaterThanOrEqual(1);
      expect((await basePrisma.triageQueueItem.findUniqueOrThrow({ where: { id: stale.id } })).lockedBy).toBeNull();
      expect((await basePrisma.triageQueueItem.findUniqueOrThrow({ where: { id: fresh.id } })).lockedBy).toBe("nurse-y");
      for (const id of [stale.id, fresh.id]) await basePrisma.triageQueueItem.delete({ where: { id } });
    });

    it("detects a broken audit chain", async () => {
      const { runIntegrityChecks } = await import("../src/services/integrityChecks.js");
      const { appendOperationalAuditEvent } = await import("../src/services/auditLedger.js");
      await appendOperationalAuditEvent({ action: "INTEGRITY_TEST", module: "Test", resource: "Test", success: true });
      // Simulate tampering by checking a ledger verified with the wrong key.
      process.env.AUDIT_HMAC_SECRET = "a-different-secret-so-the-chain-fails";
      const report = await runIntegrityChecks({ only: ["audit-ledger"] });
      expect(report.ok).toBe(false);
      expect(report.checks[0].problems[0].detail).toMatch(/audit chain/i);
    });
  });

  describe("NFR-013 / 055 / 056 / 057 retention, archive and soft delete", () => {
    const oldEnv = { ...process.env };
    const age = (table: string, column: string, id: string, days: number, idColumn = "id") =>
      basePrisma.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = now() - ($1 || ' days')::interval WHERE "${idColumn}" = $2`, String(days), id);
    const policy = (code: string, days: number, extra: Record<string, unknown> = {}) =>
      basePrisma.retentionPolicy.upsert({
        where: { code },
        create: { code, name: code, entityName: code, retentionPeriod: { days, decisionReference: `DEC-${code}` }, legalBasis: "Approved by the data owner", deletionMode: "archive_then_delete", status: "active", ...extra },
        update: { retentionPeriod: { days, decisionReference: `DEC-${code}` }, legalBasis: "Approved by the data owner", status: "active", ...extra }
      });
    beforeEach(() => {
      process.env.AUDIT_EVENT_DB_PERSISTENCE = "true";
      process.env.AUDIT_HMAC_SECRET ??= "ci-only-audit-hmac-secret-not-for-production";
      process.env.FIELD_ENCRYPTION_KEY = "sprint3-field-key-0123456789abcdef";
    });
    afterEach(() => {
      process.env = { ...oldEnv };
    });

    it("purges nothing without an approved policy: a run skips the data type and says why", async () => {
      const { runRetention } = await import("../src/services/retentionEngine.js");
      await basePrisma.retentionPolicy.deleteMany({ where: { code: "LOGIN_NONCE" } });
      const old = await basePrisma.loginNonce.create({ data: { nonce: `${run}-nonce-a`, expiresAt: new Date(Date.now() - 400 * 86400000) } });
      const [dry] = await runRetention({ execute: false, codes: ["LOGIN_NONCE"] });
      expect(dry).toMatchObject({ approved: false, eligible: 0, deleted: 0 });
      const [none] = await runRetention({ execute: true, codes: ["LOGIN_NONCE"] });
      expect(none).toMatchObject({ approved: false, deleted: 0 });
      expect(none.note).toMatch(/Skipped/);
      await basePrisma.retentionPolicy.create({ data: { code: "LOGIN_NONCE", name: "n", entityName: "LoginNonce", retentionPeriod: { days: 30 }, deletionMode: "hard_delete", status: "active" } });
      const [noDecision] = await runRetention({ execute: true, codes: ["LOGIN_NONCE"] });
      expect(noDecision).toMatchObject({ approved: false, deleted: 0 }); // no decision reference or legal basis
      await expect(runRetention({ execute: true, codes: ["LOGIN_NONCE"], daysOverride: 5 })).rejects.toThrow(/rejects --retention-days/);
      await basePrisma.retentionPolicy.delete({ where: { code: "LOGIN_NONCE" } });
      expect(await basePrisma.loginNonce.count({ where: { nonce: old.nonce } })).toBe(1);
    });

    it("purges each data type under its own policy and leaves the others alone", async () => {
      const { runRetention } = await import("../src/services/retentionEngine.js");
      await basePrisma.loginNonce.create({ data: { nonce: `${run}-nonce-b`, expiresAt: new Date(Date.now() - 400 * 86400000) } });
      const session = await basePrisma.userSession.create({ data: { userId: `${run}-u`, sessionHash: `${run}-hash`, sessionPayload: {}, authMethod: "local", expiresAt: new Date(Date.now() - 400 * 86400000) } });
      await policy("USER_SESSION_EXPIRED", 30, { deletionMode: "hard_delete" });
      await basePrisma.retentionPolicy.deleteMany({ where: { code: "LOGIN_NONCE" } });
      const results = await runRetention({ execute: true, codes: ["USER_SESSION_EXPIRED", "LOGIN_NONCE"] });
      expect(results.find((r) => r.code === "USER_SESSION_EXPIRED")).toMatchObject({ approved: true, archived: 0 });
      expect(await basePrisma.userSession.count({ where: { id: session.id } })).toBe(0);
      expect(await basePrisma.loginNonce.count({ where: { nonce: `${run}-nonce-b` } })).toBe(1);
      expect(await basePrisma.auditEvent.findFirst({ where: { action: "RETENTION_PURGE_EXECUTED", recordReference: "USER_SESSION_EXPIRED" } })).not.toBeNull();
    });

    it("archives before deleting, keeps ciphertext in the archive, and spares a case under legal hold", async () => {
      const { runRetention } = await import("../src/services/retentionEngine.js");
      const { withFieldEncryption, isEncryptedValue } = await import("../src/services/fieldEncryption.js");
      const encrypted = withFieldEncryption(basePrisma);
      const mk = (tag: string) => encrypted.triageQueueItem.create({ data: { istStaffId: `${run}-${tag}`, slaDeadline: new Date(), status: "COMPLETED", summary: `note ${tag}` } });
      const purged = await mk("purge");
      const held = await mk("held");
      for (const row of [purged, held]) await age("triage_queue_items", "updated_at", row.id, 400);
      await basePrisma.legalHold.create({ data: { holdCode: `${run}-hold`, resourceType: "TriageQueueItem", resourceId: held.id, reason: "test hold" } });
      await policy("TRIAGE_QUEUE_ITEM_COMPLETED", 365);

      const [result] = await runRetention({ execute: true, codes: ["TRIAGE_QUEUE_ITEM_COMPLETED"] });
      expect(result.excludedByLegalHold).toBeGreaterThanOrEqual(1);
      expect(await basePrisma.triageQueueItem.count({ where: { id: purged.id } })).toBe(0);
      expect(await basePrisma.triageQueueItem.count({ where: { id: held.id } })).toBe(1);
      const archived = await basePrisma.archivedRecord.findFirstOrThrow({ where: { recordId: purged.id } });
      expect(archived).toMatchObject({ entityName: "TriageQueueItem", policyCode: "TRIAGE_QUEUE_ITEM_COMPLETED", handedOffAt: null });
      expect(isEncryptedValue((archived.payload as { summary: string }).summary)).toBe(true);
      await basePrisma.triageQueueItem.delete({ where: { id: held.id } });
    });

    it("hands archived content to the designated system decrypted, signed, and keeps only a hash", async () => {
      const { handOffArchive, setArchiveHandoffFetchForTests } = await import("../src/services/archiveHandoff.js");
      const { signAuditPayload } = await import("../src/services/auditForwarding.js");
      const { createHash } = await import("node:crypto");
      const { withFieldEncryption } = await import("../src/services/fieldEncryption.js");
      process.env.ARCHIVE_HANDOFF_URL = "https://archive.qr.example/ingest";
      process.env.ARCHIVE_HANDOFF_SECRET = "handoff-secret-for-test";
      await basePrisma.archivedRecord.deleteMany({ where: { handedOffAt: null } });
      const row = await withFieldEncryption(basePrisma).triageQueueItem.create({ data: { istStaffId: `${run}-handoff`, slaDeadline: new Date(), summary: "confidential clinical note" } });
      const raw = await basePrisma.triageQueueItem.findUniqueOrThrow({ where: { id: row.id } });
      const archived = await basePrisma.archivedRecord.create({ data: { entityName: "TriageQueueItem", recordId: row.id, policyCode: "TRIAGE_QUEUE_ITEM_COMPLETED", payload: JSON.parse(JSON.stringify(raw)) } });
      await basePrisma.triageQueueItem.delete({ where: { id: row.id } });

      const sent: Array<{ body: string; signature: string }> = [];
      setArchiveHandoffFetchForTests(async (_url, init) => {
        sent.push({ body: init.body, signature: init.headers["x-archive-signature"] });
        return { ok: true, status: 200, json: async () => ({ reference: "QR-ARCH-001" }) };
      });
      const result = await handOffArchive();
      expect(result).toMatchObject({ handedOff: 1, failed: 0, localContentRemoved: 1 });
      expect(sent[0].signature).toBe(signAuditPayload(sent[0].body, "handoff-secret-for-test"));
      const record = JSON.parse(sent[0].body).records[0];
      expect(record.payload.summary).toBe("confidential clinical note");
      const after = await basePrisma.archivedRecord.findUniqueOrThrow({ where: { id: archived.id } });
      expect(after.handoffReference).toBe("QR-ARCH-001");
      expect(after.handedOffAt).not.toBeNull();
      expect(JSON.stringify(after.payload)).not.toContain("confidential");
      expect((after.payload as { payloadSha256: string }).payloadSha256).toBe(createHash("sha256").update(JSON.stringify(record.payload)).digest("hex"));
      setArchiveHandoffFetchForTests(undefined);
    });

    it("keeps a record that could not be handed off, alerts, and reports nothing to do when no system is configured", async () => {
      const { handOffArchive, setArchiveHandoffFetchForTests } = await import("../src/services/archiveHandoff.js");
      await basePrisma.archivedRecord.deleteMany({ where: { handedOffAt: null } });
      const kept = await basePrisma.archivedRecord.create({ data: { entityName: "Dependent", recordId: `${run}-dep`, policyCode: "DEPENDENT_DELETED", payload: { fullName: "kept locally" } } });
      delete process.env.ARCHIVE_HANDOFF_URL;
      expect((await handOffArchive()).skipped).toMatch(/ARCHIVE_HANDOFF_URL/);
      process.env.ARCHIVE_HANDOFF_URL = "https://archive.qr.example/ingest";
      process.env.ARCHIVE_HANDOFF_SECRET = "handoff-secret-for-test";
      setArchiveHandoffFetchForTests(async () => ({ ok: false, status: 503, json: async () => ({}) }));
      const result = await handOffArchive();
      expect(result.failed).toBe(1);
      const row = await basePrisma.archivedRecord.findUniqueOrThrow({ where: { id: kept.id } });
      expect(row.handedOffAt).toBeNull();
      expect(JSON.stringify(row.payload)).toContain("kept locally");
      expect(await basePrisma.auditEvent.findFirst({ where: { action: "ARCHIVE_HANDOFF_FAILED" } })).not.toBeNull();
      // The integrity check complains once a record has waited too long.
      await age("archived_records", "archived_at", kept.id, 10);
      const { runIntegrityChecks } = await import("../src/services/integrityChecks.js");
      const report = await runIntegrityChecks({ only: ["archive-handoff"] });
      expect(report.checks[0].problems.map((p) => p.reference)).toContain(`ArchivedRecord:${kept.id}`);
      setArchiveHandoffFetchForTests(undefined);
    });

    it("soft-deletes dependents, hides them, records who deleted them, restores them, and purges them only under a policy", async () => {
      const { prisma } = await import("../src/db.js");
      const { runWithActor, restoreSoftDeleted } = await import("../src/services/softDelete.js");
      const { runRetention } = await import("../src/services/retentionEngine.js");
      const staff = await basePrisma.staffMember.create({ data: { istStaffId: `${run}-soft`, department: "Ops", jobTitle: "Tester" } });
      const dep = await prisma.dependent.create({ data: { staffMemberId: staff.id, fullName: "To Delete", relationshipType: "CHILD", age: 5, biologicalSex: "MALE" } });
      await runWithActor("usr_admin_x", async () => {
        await prisma.dependent.delete({ where: { id: dep.id } });
      });
      expect(await prisma.dependent.findUnique({ where: { id: dep.id } })).toBeNull();
      expect(await prisma.dependent.count({ where: { staffMemberId: staff.id } })).toBe(0);
      const stored = await basePrisma.dependent.findUniqueOrThrow({ where: { id: dep.id } });
      expect(stored).toMatchObject({ deletedBy: "usr_admin_x" });
      expect(stored.deletedAt).not.toBeNull();
      expect((await prisma.dependent.findMany({ where: { staffMemberId: staff.id, deletedAt: { not: null } } })).length).toBe(1);

      expect(await restoreSoftDeleted(basePrisma, "Dependent", dep.id)).toBe(true);
      expect(await prisma.dependent.count({ where: { staffMemberId: staff.id } })).toBe(1);

      await prisma.dependent.deleteMany({ where: { staffMemberId: staff.id } });
      await age("dependents", "deleted_at", dep.id, 400);
      await basePrisma.retentionPolicy.deleteMany({ where: { code: "DEPENDENT_DELETED" } });
      const [dry] = await runRetention({ execute: false, codes: ["DEPENDENT_DELETED"] });
      expect(dry.eligible).toBe(0);
      await policy("DEPENDENT_DELETED", 365);
      const [done] = await runRetention({ execute: true, codes: ["DEPENDENT_DELETED"] });
      expect(done.deleted).toBeGreaterThanOrEqual(1);
      expect(await basePrisma.dependent.count({ where: { id: dep.id } })).toBe(0);
      expect(await basePrisma.archivedRecord.count({ where: { recordId: dep.id, policyCode: "DEPENDENT_DELETED" } })).toBe(1);
    });

    it("never offers audit events to retention", async () => {
      const { RETENTION_TARGETS } = await import("../src/services/retentionEngine.js");
      expect(RETENTION_TARGETS.map((t) => t.model)).not.toContain("AuditEvent");
      expect(RETENTION_TARGETS.find((t) => t.model === "AviationTriageEncounter")?.requiresArchive).toBe(true);
    });
  });

  describe("NFR-057 retention policy administration", () => {
    it("lists the data types, validates changes, requires elevation and audits before and after", async () => {
      process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
      process.env.AUDIT_EVENT_DB_PERSISTENCE = "true";
      process.env.AUDIT_HMAC_SECRET ??= "ci-only-audit-hmac-secret-not-for-production";
      const request = (await import("supertest")).default;
      const { authenticator } = await import("otplib");
      const { confirmMfaEnrollment, enrollMfa } = await import("../src/services/securityAdmin.js");
      const app = (await import("../src/app.js")).createApp();
      const admin = request.agent(app);
      await admin.post("/api/v1/auth/login").send({ username: "rishma@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);

      const list = await admin.get("/api/v1/admin/retention-policies").expect(200);
      expect(list.body.policies.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining(["TRIAGE_QUEUE_ITEM_COMPLETED", "USER_SESSION_EXPIRED", "AVIATION_TRIAGE_ENCOUNTER"]));
      expect(list.body.neverPurged).toContain("AuditEvent");
      const body = { days: 90, legalBasis: "Approved by the data owner", decisionReference: "CR-2026-114", status: "active", deletionMode: "hard_delete" };
      await admin.put("/api/v1/admin/retention-policies/EXPORT_APPROVAL").send(body).expect(403); // not elevated

      const { secret } = enrollMfa("usr_platform_admin_10001");
      confirmMfaEnrollment("usr_platform_admin_10001", authenticator.generate(secret));
      await admin.post("/api/v1/admin/elevate").send({ code: authenticator.generate(secret) }).expect(200);
      await admin.put("/api/v1/admin/retention-policies/NOT_A_TYPE").send(body).expect(404);
      await admin.put("/api/v1/admin/retention-policies/EXPORT_APPROVAL").send({ ...body, days: 0 }).expect(400);
      await admin.put("/api/v1/admin/retention-policies/AVIATION_TRIAGE_ENCOUNTER").send({ ...body, deletionMode: "hard_delete" }).expect(400);
      await admin.put("/api/v1/admin/retention-policies/EXPORT_APPROVAL").send({ ...body, deletionMode: "archive_then_delete" }).expect(400);

      await admin.put("/api/v1/admin/retention-policies/EXPORT_APPROVAL").send(body).expect(200);
      await admin.put("/api/v1/admin/retention-policies/EXPORT_APPROVAL").send({ ...body, days: 120, schedule: "0 3 * * 0" }).expect(200);
      const events = await basePrisma.auditEvent.findMany({ where: { action: "RETENTION_POLICY_UPDATED", resource: "RetentionPolicy:EXPORT_APPROVAL" }, orderBy: { sequenceNumber: "desc" }, take: 1 });
      expect((events[0].metadata as { change: { fields: string[]; before: { days: number }; after: { days: number } } }).change).toMatchObject({ fields: expect.arrayContaining(["days", "schedule"]), before: { days: 90 }, after: { days: 120 } });
      await basePrisma.retentionPolicy.delete({ where: { code: "EXPORT_APPROVAL" } });
    });
  });

  describe("NFR-169 / NFR-050 extraction", () => {
    const oldEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...oldEnv };
    });

    async function twoAdmins() {
      process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
      process.env.AUDIT_EVENT_DB_PERSISTENCE = "true";
      process.env.AUDIT_HMAC_SECRET ??= "ci-only-audit-hmac-secret-not-for-production";
      const request = (await import("supertest")).default;
      const { authenticator } = await import("otplib");
      const sec = await import("../src/services/securityAdmin.js");
      sec.resetSecurityStoreForTests(); // earlier tests enrolled the administrator in MFA
      (await import("../src/middleware/rateLimit.js")).resetRateLimitBucketsForTests();
      const app = (await import("../src/app.js")).createApp();
      const login = async (username: string, userId: string) => {
        const a = request.agent(app);
        await a.post("/api/v1/auth/login").send({ username, password: process.env.ADMIN_PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);
        const { secret } = sec.enrollMfa(userId);
        sec.confirmMfaEnrollment(userId, authenticator.generate(secret));
        await a.post("/api/v1/admin/elevate").send({ code: authenticator.generate(secret) }).expect(200);
        return a;
      };
      const first = await login("rishma@irisstar.tech", "usr_platform_admin_10001");
      const created = sec.upsertDirectoryUserFromHrms({ employeeId: `S3-${run}`, email: `${run}.approver@irisstar.tech`, fullName: "Extract Approver", organizationCode: "IST_TECH", jobTitle: "Administrator", roles: ["platform_super_administrator"] });
      const second = await login(`${run}.approver@irisstar.tech`, created.user.id);
      const approved = async (dataset: string) => {
        const requested = await first.post(`/api/v1/admin/extract/${dataset}/requests`).send({ reason: "Quarterly portability extraction" }).expect(201);
        const id = requested.body.approval.id as string;
        await second.post(`/api/v1/admin/export-requests/${id}/decision`).send({ decision: "approve" }).expect(200);
        return id;
      };
      return { first, second, approved };
    }

    it("takes a dataset in pages, then only what changed, with the position kept per consumer", async () => {
      const { first, approved } = await twoAdmins();
      const tag = `${run}-ext`;
      const mk = (n: number) => basePrisma.staffMember.create({ data: { istStaffId: `${tag}-${n}`, department: "Ops", jobTitle: "Tester" } });
      const rows = [await mk(1), await mk(2), await mk(3)];
      const id = await approved("staff");

      await first.get("/api/v1/admin/extract/staff").expect(403); // no approval
      const everything = await first.get(`/api/v1/admin/extract/staff?approvalId=${id}&limit=10000`).expect(200);
      const ours = (everything.body.rows as Array<{ istStaffId: string }>).filter((r) => r.istStaffId.startsWith(tag));
      expect(ours).toHaveLength(3);
      const atEnd = everything.body.nextToken as string;

      // Page by page from the start of our rows: the token never skips or repeats a row.
      const seen: string[] = [];
      let token: string | undefined;
      for (let guard = 0; guard < 500; guard += 1) {
        const page = await first.get(`/api/v1/admin/extract/staff?approvalId=${id}&limit=2${token ? `&since=${token}` : ""}`).expect(200);
        seen.push(...(page.body.rows as Array<{ id: string }>).map((r) => r.id));
        token = page.body.nextToken;
        if (!page.body.hasMore) break;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(rows.every((r) => seen.includes(r.id))).toBe(true);

      // Incremental: nothing new, then one change and one new row.
      const none = await first.get(`/api/v1/admin/extract/staff?approvalId=${id}&since=${atEnd}`).expect(200);
      expect(none.body.rows).toHaveLength(0);
      await basePrisma.staffMember.update({ where: { id: rows[0].id }, data: { jobTitle: "Changed" } });
      const added = await mk(4);
      const changes = await first.get(`/api/v1/admin/extract/staff?approvalId=${id}&since=${atEnd}`).expect(200);
      expect((changes.body.rows as Array<{ id: string; jobTitle: string }>).map((r) => r.id).sort()).toEqual([rows[0].id, added.id].sort());
      expect(changes.body.rows.find((r: { id: string }) => r.id === rows[0].id).jobTitle).toBe("Changed");

      // The position is stored per consumer, and only moves when the consumer confirms.
      await first.get(`/api/v1/admin/extract/staff?approvalId=${id}&consumer=bi-team&since=${atEnd}`).expect(200);
      await first.post("/api/v1/admin/extract/staff/ack").send({ consumer: "bi-team", token: atEnd }).expect(204);
      const resumed = await first.get(`/api/v1/admin/extract/staff?approvalId=${id}&consumer=bi-team`).expect(200);
      expect(resumed.body.rows.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([rows[0].id, added.id]));
      expect(resumed.body.rows.length).toBe(2);
      const stored = await basePrisma.extractionCursor.findUniqueOrThrow({ where: { consumer_dataset: { consumer: "bi-team", dataset: "staff" } } });
      expect(stored.token).toBe(atEnd);
      await first.post("/api/v1/admin/extract/staff/ack").send({ consumer: "bi-team", token: "garbage" }).expect(400);
    }, 60000);

    it("exports CSV and Parquet, never exports credentials, and shows deletions", async () => {
      const { first, approved } = await twoAdmins();
      const { prisma } = await import("../src/db.js");
      const { runWithActor } = await import("../src/services/softDelete.js");
      const { parquetReadObjects } = await import("hyparquet");
      const staff = await basePrisma.staffMember.create({ data: { istStaffId: `${run}-del`, department: "Ops", jobTitle: "Tester" } });
      const dep = await prisma.dependent.create({ data: { staffMemberId: staff.id, fullName: "Gone Child", relationshipType: "CHILD", age: 4, biologicalSex: "FEMALE" } });
      await runWithActor("usr_x", async () => {
        await prisma.dependent.delete({ where: { id: dep.id } });
      });
      const depId = await approved("dependents");
      const json = await first.get(`/api/v1/admin/extract/dependents?approvalId=${depId}&limit=10000`).expect(200);
      const row = json.body.rows.find((r: { id: string }) => r.id === dep.id);
      expect(row).toMatchObject({ fullName: "Gone Child", deletedBy: "usr_x" });
      expect(row.deletedAt).toBeTruthy();

      const csv = await first.get(`/api/v1/admin/extract/dependents?approvalId=${depId}&format=csv&limit=10000`).expect(200);
      expect(csv.headers["content-type"]).toMatch(/text\/csv/);
      expect(csv.text.split("\n")[0]).toContain("fullName");
      expect(csv.text).toContain("Gone Child");

      const pq = await first.get(`/api/v1/admin/extract/dependents?approvalId=${depId}&format=parquet&limit=10000`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      const bytes = pq.body as Buffer;
      const parsed = (await parquetReadObjects({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })) as Array<{ id: string; fullName: string }>;
      expect(parsed.find((r) => r.id === dep.id)?.fullName).toBe("Gone Child");

      const usersId = await approved("users");
      const users = await first.get(`/api/v1/admin/extract/users?approvalId=${usersId}&limit=10000`).expect(200);
      for (const user of users.body.rows) {
        expect(Object.keys(user).some((k) => /passwordHash|ciphertext|secret/i.test(k))).toBe(false);
      }
      const events = await basePrisma.auditEvent.findMany({ where: { action: "EXPORT_COMPLETED", resource: { contains: "Export:dataset" } }, orderBy: { sequenceNumber: "desc" }, take: 3 });
      expect(events.length).toBeGreaterThan(0);
      expect((events[0].metadata as { sha256?: string }).sha256).toMatch(/^[a-f0-9]{64}$/);
    }, 60000);

    it("exposes the audit ledger and the purged-record list as datasets, and honours the disable switch", async () => {
      const { first, approved } = await twoAdmins();
      const auditId = await approved("audit-events");
      const audit = await first.get(`/api/v1/admin/extract/audit-events?approvalId=${auditId}&limit=50`).expect(200);
      expect(audit.body.rows.length).toBeGreaterThan(0);
      expect(audit.body.rows[0]).toHaveProperty("eventHash");
      process.env.EXPORTS_DISABLED_KINDS = "dataset";
      const blocked = await first.get(`/api/v1/admin/extract/audit-events?approvalId=${auditId}`).expect(403);
      expect(blocked.body.code).toBe("EXPORTS_DISABLED");
    }, 60000);
  });
});
