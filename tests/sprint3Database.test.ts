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
      process.env.AUDIT_HMAC_SECRET = "ledger-secret-for-sprint3-test";
      process.env.FIELD_ENCRYPTION_KEY = "sprint3-field-key-0123456789abcdef";
    });
    afterEach(() => {
      process.env = { ...oldEnv };
    });

    it("passes on healthy data and records a passing event", async () => {
      const { runIntegrityChecks } = await import("../src/services/integrityChecks.js");
      // (The ledger check is exercised below: other suites sign events with their own secrets in this shared test database.)
      const report = await runIntegrityChecks({ only: ["soft-delete", "completed-cases"] });
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
});
