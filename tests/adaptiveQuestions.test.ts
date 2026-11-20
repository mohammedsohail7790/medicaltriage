import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { contentPackageReady, listClinicalProtocols } from "../src/services/clinicalContent.js";
import { resetClinicalWorkForTests } from "../src/services/clinicalWork.js";
import { resetSecurityStoreForTests, upsertDirectoryUserFromHrms } from "../src/services/securityAdmin.js";

const PASSWORD = "TestAdminPassword!2026";
process.env.ADMIN_PASSWORD = PASSWORD;
const app = createApp();

async function agentFor(username: string, role: string) {
  const agent = request.agent(app);
  await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD, simulateRole: role }).expect(200);
  return agent;
}

let protocolId: string;
let q: string[];
beforeAll(async () => {
  await contentPackageReady;
  const protocol = listClinicalProtocols().find((p) => p.questions.length >= 3)!;
  protocolId = protocol.id;
  q = [...protocol.questions].sort((a, b) => a.acuityOrder - b.acuityOrder).map((x) => x.id);
});
beforeEach(() => {
  resetSecurityStoreForTests();
  resetClinicalWorkForTests();
  resetRateLimitBucketsForTests();
  upsertDirectoryUserFromHrms({ employeeId: "IST-30001", email: "clinlead@irisstar.tech", fullName: "Clinical Lead", organizationCode: "IST_TECH", jobTitle: "Clinical lead", roles: ["platform_super_administrator"] });
});

const url = (suffix: string) => `/api/v1/protocols/${encodeURIComponent(protocolId)}/${suffix}`;

describe("F-007 adaptive question layer", () => {
  it("follows the protocol's own order when no branch is signed off, with the reasoning", async () => {
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    const first = (await nurse.get(url("next-question")).expect(200)).body;
    expect(first.question.id).toBe(q[0]);
    expect(first.reasoning).toMatch(/protocol's own order/);
    const second = (await nurse.get(url("next-question")).query({ answers: `${q[0]}:no` }).expect(200)).body;
    expect(second.question.id).toBe(q[1]);
    await nurse.get(url("next-question")).query({ answers: "bad" }).expect(400);
    await nurse.get("/api/v1/protocols/nope/next-question").expect(404);
  });

  it("uses a branch only after a different person signs it off, and then asks a different next question", async () => {
    const author = await agentFor("rishma@irisstar.tech", "platform_super_administrator");
    const signer = await agentFor("clinlead@irisstar.tech", "platform_super_administrator");
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");

    const draft = await author.post(url("branch-rules")).send({ fromQuestionId: q[0], answer: "yes", nextQuestionId: q[2], reasoning: "A yes here makes the third question the more urgent one." }).expect(201);
    const id = draft.body.rule.id;
    // Drafts are not used.
    expect((await nurse.get(url("next-question")).query({ answers: `${q[0]}:yes` }).expect(200)).body.question.id).toBe(q[1]);
    await author.post(`/api/v1/protocols/branch-rules/${id}/sign-off`).expect(403);
    await signer.post(`/api/v1/protocols/branch-rules/${id}/sign-off`).expect(200);

    const yes = (await nurse.get(url("next-question")).query({ answers: `${q[0]}:yes` }).expect(200)).body;
    const no = (await nurse.get(url("next-question")).query({ answers: `${q[0]}:no` }).expect(200)).body;
    expect(yes.question.id).toBe(q[2]);
    expect(yes.reasoning).toMatch(/signed-off branch/);
    expect(no.question.id).toBe(q[1]);
    expect(yes.viaRuleId).toBe(id);

    await author.delete(`/api/v1/protocols/branch-rules/${id}`).expect(200);
    expect((await nurse.get(url("next-question")).query({ answers: `${q[0]}:yes` }).expect(200)).body.question.id).toBe(q[1]);
  });

  it("never drops a question: once everything is asked the protocol is done", async () => {
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    const all = q.map((id) => `${id}:no`).join(",");
    expect((await nurse.get(url("next-question")).query({ answers: all }).expect(200)).body.done).toBe(true);
  });

  it("rejects bad rules and limits who can write them", async () => {
    const author = await agentFor("rishma@irisstar.tech", "platform_super_administrator");
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    await author.post(url("branch-rules")).send({ fromQuestionId: q[0], answer: "yes", nextQuestionId: "nope", reasoning: "Unknown target question." }).expect(400);
    await author.post(url("branch-rules")).send({ fromQuestionId: q[0], answer: "yes", nextQuestionId: q[0], reasoning: "Loops to itself here." }).expect(400);
    await author.post(url("branch-rules")).send({ fromQuestionId: q[0], answer: "yes", nextQuestionId: q[1], reasoning: "Fine reason given." }).expect(201);
    await author.post(url("branch-rules")).send({ fromQuestionId: q[0], answer: "yes", nextQuestionId: q[2], reasoning: "Duplicate of the above." }).expect(409);
    await nurse.post(url("branch-rules")).send({ fromQuestionId: q[1], answer: "no", nextQuestionId: q[2], reasoning: "A nurse may not write rules." }).expect(403);
    await nurse.get(url("branch-rules")).expect(403);
  });
});
