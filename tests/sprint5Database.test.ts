// Sprint 5 paths that need PostgreSQL: clinical work items are stored encrypted and survive across reads.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

process.env.PLATFORM_DB_PERSISTENCE = "true";
process.env.AUDIT_HMAC_SECRET ??= "ci-only-audit-hmac-secret-not-for-production";
process.env.FIELD_ENCRYPTION_ENABLED = "true";
process.env.FIELD_ENCRYPTION_KEY = "sprint5-field-key-0123456789abcdef";

describeDb("Sprint 5 database-backed behaviour", () => {
  let basePrisma: typeof import("../src/db.js").basePrisma;
  let work: typeof import("../src/services/clinicalWork.js");
  let rules: typeof import("../src/services/adaptiveQuestions.js");
  let policy: typeof import("../src/services/initialAssessment.js");

  beforeAll(async () => {
    ({ basePrisma } = await import("../src/db.js"));
    work = await import("../src/services/clinicalWork.js");
    rules = await import("../src/services/adaptiveQuestions.js");
    policy = await import("../src/services/initialAssessment.js");
    await basePrisma.clinicalWorkItem.deleteMany({});
  });
  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  const session = { user: { id: "usr_reporter", organizationId: "org1" }, activeRole: "remote_triage_nurse" } as never;

  it("stores an incident's narrative encrypted at rest and reads it back decrypted", async () => {
    const item = await work.reportIncident({ type: "incident", severity: "high", caseRef: "case-1", description: "Distinctive narrative text 7f3a91" }, session);
    const raw = await basePrisma.$queryRawUnsafe<Array<{ payload: unknown }>>(`SELECT payload FROM clinical_work_items WHERE id = '${item.id}'`);
    expect(JSON.stringify(raw[0].payload)).not.toContain("7f3a91");
    const back = await work.getItem(item.id, "incident");
    expect(back?.payload.description).toBe("Distinctive narrative text 7f3a91");
    expect((await work.listItems({ kind: "incident", status: "reported" })).some((i) => i.id === item.id)).toBe(true);
  });

  it("moves an incident through review and closing, and refuses the reporter closing it", async () => {
    const item = await work.reportIncident({ type: "near_miss", severity: "low", description: "A near miss for the test run." }, session);
    const reviewer = { user: { id: "usr_cso", organizationId: "org1" }, activeRole: "clinical_safety_officer" } as never;
    await expect(work.closeIncident(item.id, { outcome: "Closing my own", correctiveActions: [], shareLearning: false }, session)).rejects.toMatchObject({ code: "INCIDENT_SELF_CLOSE" });
    await work.takeIncidentForReview(item.id, reviewer);
    const closed = await work.closeIncident(item.id, { outcome: "Reviewed and closed", correctiveActions: ["Brief team"], shareLearning: true }, reviewer);
    expect(closed.status).toBe("closed");
  });

  it("keeps the Initial Assessment policy and a branch rule across reads", async () => {
    policy.resetInitialAssessmentPolicyForTests();
    expect(await policy.initialAssessmentRequired(0)).toBe(true);
    await policy.setInitialAssessmentPolicy({ required: false, reason: "Test of the stored setting" }, "usr_admin");
    policy.resetInitialAssessmentPolicyForTests();
    expect(await policy.initialAssessmentRequired(0)).toBe(false);
    await policy.setInitialAssessmentPolicy({ required: true }, "usr_admin");
    policy.resetInitialAssessmentPolicyForTests();
    expect(await policy.initialAssessmentRequired(0)).toBe(true);
    expect(typeof rules.listRules).toBe("function");
  });
});
