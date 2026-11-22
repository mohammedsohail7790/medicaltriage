// OI-49 handshake that needs a real PostgreSQL database. Skipped when DATABASE_URL is not set.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("cockpit completion returns the encounter that the clinical approval is keyed by", () => {
  const saved = { ...process.env };
  const run = `oi49-${Date.now()}`;
  let basePrisma: typeof import("../src/db.js").basePrisma;

  beforeAll(async () => {
    process.env.MOCK_MODE = "false";
    ({ basePrisma } = await import("../src/db.js"));
    await basePrisma.staffMember.create({ data: { istStaffId: `${run}-staff`, department: "Ops", jobTitle: "Tester" } });
  });
  afterAll(async () => {
    process.env = { ...saved };
    await basePrisma.$disconnect();
  });

  it("saves the encounter and gives back its id, the same one again on a retry", async () => {
    const { persistCompletedTriageNote } = await import("../src/services/persistence.js");
    const request = {
      queueItemId: `${run}-queue`,
      ist_staff_id: `${run}-staff`,
      istStaffId: `${run}-staff`,
      chief_complaint: "Ear pain",
      finalDispositionCode: "HMC_URGENT_REVIEW",
      routing_destination: "HMC urgent review pathway",
      customAviationTags: []
    } as never;
    const first = await persistCompletedTriageNote(request, "# note", "CLEARED");
    expect(first).toMatchObject({ persisted: true });
    const recordId = (first as { recordId?: string }).recordId;
    expect(recordId).toBeTruthy();
    // The approval route looks the encounter up by exactly this id.
    expect(await basePrisma.aviationTriageEncounter.findFirst({ where: { id: recordId } })).not.toBeNull();

    const again = await persistCompletedTriageNote(request, "# note", "CLEARED");
    expect((again as { recordId?: string }).recordId).toBe(recordId);
  });
});
