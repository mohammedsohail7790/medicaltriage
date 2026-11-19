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
});
