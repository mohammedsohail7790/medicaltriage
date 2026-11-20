import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { WorkError, createItem, drawRandom, resetClinicalWorkForTests, submitQaReview } from "../src/services/clinicalWork.js";
import * as queue from "../src/services/queueOrchestration.js";
import { compileBilingualSoapSbarMarkdown } from "../src/services/triageNoteCompiler.js";
import { resetSecurityStoreForTests, upsertDirectoryUserFromHrms } from "../src/services/securityAdmin.js";
import { TriageCompleteRequestSchema } from "../src/types/triage.js";

const PASSWORD = "TestAdminPassword!2026";
process.env.ADMIN_PASSWORD = PASSWORD;
const app = createApp();

async function agentFor(username: string, role: string) {
  const agent = request.agent(app);
  await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD, simulateRole: role }).expect(200);
  return agent;
}

function addUser(employeeId: string, email: string, role: string) {
  upsertDirectoryUserFromHrms({ employeeId, email, fullName: `Test ${role}`, organizationCode: "IST_TECH", jobTitle: role, roles: [role] });
}

const COMPLETE = {
  chief_complaint: "Ankle pain after a fall", final_disposition_code: "HMC_URGENT_CARE", routing_destination: "Urgent care", nurse_id: "someone-else",
  ist_staff_id: "IST-10001"
};

beforeEach(() => {
  resetSecurityStoreForTests();
  resetClinicalWorkForTests();
  resetRateLimitBucketsForTests();
  queue.resetQueueStoreForTests();
  addUser("IST-20001", "cso@irisstar.tech", "clinical_safety_officer");
  addUser("IST-20002", "qa@irisstar.tech", "qa_reviewer");
  addUser("IST-20003", "qa2@irisstar.tech", "qa_reviewer");
});
afterEach(() => jest.restoreAllMocks());

describe("F-015 the nurse handling the case", () => {
  it("takes the nurse from the signed-in session, not from the request", async () => {
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    const res = await nurse.post("/api/v1/triage/complete").send(COMPLETE).expect(200);
    expect(res.body.notePayload).not.toContain("someone-else");
    expect(res.body.notePayload).toMatch(/nurse .+ \(.+\)/);
  });
});

describe("F-004 / F-011 care advice delivery and F-018 destination", () => {
  it("records whether advice was given now or sent later, in both languages, and names the destination", () => {
    const parsed = TriageCompleteRequestSchema.parse({ ...COMPLETE, advice_delivery: "send_later", destination_contact: { name: "Al Khor clinic", phone: "+974 4000 0000", hours: "07:00-22:00" } });
    const note = compileBilingualSoapSbarMarkdown(parsed);
    expect(note).toContain("Care advice: to be sent later");
    expect(note).toContain("ستُرسل لاحقاً");
    expect(note).toContain("Destination: Al Khor clinic; phone +974 4000 0000; hours 07:00-22:00");
    expect(compileBilingualSoapSbarMarkdown(TriageCompleteRequestSchema.parse(COMPLETE))).toContain("Care advice: not recorded");
  });

  it("rejects an unknown advice choice", () => {
    expect(TriageCompleteRequestSchema.safeParse({ ...COMPLETE, advice_delivery: "whenever" }).success).toBe(false);
  });
});

describe("F-021 incident and near-miss reporting", () => {
  it("lets a nurse report, a safety officer review and close, and bars self-closing", async () => {
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    const cso = await agentFor("cso@irisstar.tech", "clinical_safety_officer");
    const made = await nurse.post("/api/v1/safety/incidents").send({ type: "near_miss", severity: "moderate", caseRef: "case-10002", description: "Wrong protocol suggested; caught before advice was given." }).expect(201);
    const id = made.body.incident.id;
    await nurse.get("/api/v1/safety/incidents").expect(403);
    expect((await cso.get("/api/v1/safety/incidents").expect(200)).body.incidents).toHaveLength(1);
    await cso.post(`/api/v1/safety/incidents/${id}/review`).expect(200);
    await cso.post(`/api/v1/safety/incidents/${id}/close`).send({ outcome: "Protocol ranking reviewed", correctiveActions: ["Brief the team"] }).expect(200);
    await cso.post(`/api/v1/safety/incidents/${id}/close`).send({ outcome: "again again" }).expect(409);
  });

  it("does not let the reporter close their own report", async () => {
    const cso = await agentFor("cso@irisstar.tech", "clinical_safety_officer");
    const made = await cso.post("/api/v1/safety/incidents").send({ type: "incident", severity: "high", description: "A delay in escalation occurred." }).expect(201);
    await cso.post(`/api/v1/safety/incidents/${made.body.incident.id}/close`).send({ outcome: "Closing my own" }).expect(403);
  });

  it("validates the report", async () => {
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    await nurse.post("/api/v1/safety/incidents").send({ type: "incident", severity: "huge", description: "short" }).expect(400);
  });
});

describe("F-020 randomised call review sampling", () => {
  const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `case-${i}`, assignedNurseId: i === 0 ? "usr_qa_self" : "nurse-1", completedAtIso: new Date(Date.UTC(2026, 7, 1 + i)).toISOString(), severity: "URGENT", dispositionCode: "HMC_URGENT_CARE", department: "Cabin crew" }));

  it("draws without replacement and never twice for the same call", () => {
    const pool = Array.from({ length: 20 }, (_, i) => i);
    const picked = drawRandom(pool, 8);
    expect(new Set(picked).size).toBe(8);
    expect(drawRandom(pool, 50)).toHaveLength(20);
    // The draw really depends on the random source.
    expect(drawRandom(pool, 3, () => 0)).toEqual([0, 1, 2]);
  });

  it("samples eligible completed calls, records the selection, and hides identity from the reviewer", async () => {
    jest.spyOn(queue, "listCompletedCallsForReview").mockResolvedValue(calls(10));
    const cso = await agentFor("cso@irisstar.tech", "clinical_safety_officer");
    const first = await cso.post("/api/v1/safety/qa/samples").send({ count: 4 }).expect(201);
    expect(first.body.eligible).toBe(10);
    expect(first.body.selected).toHaveLength(4);
    for (const item of first.body.selected) expect(Object.keys(item)).not.toEqual(expect.arrayContaining(["handlingNurseId", "istStaffId", "patientName"]));
    // Already-sampled calls are not drawn again.
    const second = await cso.post("/api/v1/safety/qa/samples").send({ percent: 100 }).expect(201);
    expect(second.body.eligible).toBe(6);
    const overlap = second.body.selected.filter((s: { caseRef: string }) => first.body.selected.some((f: { caseRef: string }) => f.caseRef === s.caseRef));
    expect(overlap).toHaveLength(0);
    await cso.post("/api/v1/safety/qa/samples").send({}).expect(400);
  });

  it("lets a reviewer review a sampled call once, and never their own", async () => {
    jest.spyOn(queue, "listCompletedCallsForReview").mockResolvedValue(calls(3));
    const cso = await agentFor("cso@irisstar.tech", "clinical_safety_officer");
    const sample = await cso.post("/api/v1/safety/qa/samples").send({ count: 3 }).expect(201);
    const qa = await agentFor("qa@irisstar.tech", "qa_reviewer");
    const queueNow = (await qa.get("/api/v1/safety/qa/queue").expect(200)).body.items;
    expect(queueNow).toHaveLength(3);
    const id = sample.body.selected[0].id;
    await qa.post(`/api/v1/safety/qa/${id}/review`).send({ score: 4, findings: "Clear questions, advice recorded.", followUp: "coaching" }).expect(200);
    await qa.post(`/api/v1/safety/qa/${id}/review`).send({ score: 4, findings: "Again again" }).expect(409);
    await qa.post(`/api/v1/safety/qa/${id}/review`).send({ score: 9, findings: "x" }).expect(400);
  });

  it("refuses a review by the nurse who handled the call", async () => {
    const own = await createItem({ kind: "qa_review", status: "pending", caseRef: "c1", createdBy: "x", payload: { handlingNurseId: "usr_reviewer" } });
    const session = { user: { id: "usr_reviewer" } } as never;
    await expect(submitQaReview(own.id, { score: 3, findings: "My own call", followUp: "none" }, session)).rejects.toMatchObject({ code: "QA_SELF_REVIEW" });
    await expect(submitQaReview(own.id, { score: 3, findings: "My own call", followUp: "none" }, session)).rejects.toBeInstanceOf(WorkError);
  });

  it("refuses sampling to a nurse", async () => {
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    await nurse.post("/api/v1/safety/qa/samples").send({ count: 1 }).expect(403);
    await nurse.get("/api/v1/safety/qa/queue").expect(403);
  });
});

describe("F-023 / F-019 safety dashboard", () => {
  it("is for the safety officer role only, and says so rather than showing sample figures without a database", async () => {
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    await nurse.get("/api/v1/safety/dashboard").expect(403);
    const cso = await agentFor("cso@irisstar.tech", "clinical_safety_officer");
    const res = await cso.get("/api/v1/safety/dashboard").expect(200);
    expect(res.body.live).toBe(false);
    expect(res.body.kpis).toBeUndefined();
  });
});
