import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
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
beforeEach(() => {
  resetSecurityStoreForTests();
  resetClinicalWorkForTests();
  resetRateLimitBucketsForTests();
  upsertDirectoryUserFromHrms({ employeeId: "IST-30002", email: "clinlead2@irisstar.tech", fullName: "Clinical Lead 2", organizationCode: "IST_TECH", jobTitle: "Clinical lead", roles: ["platform_super_administrator"] });
});

describe("F-005 clinician-editable note templates", () => {
  const body = { name: "Ankle injury plan", section: "plan", language: "en", body: "Refer {{patient}} to {{destination}} for review today." };

  it("offers nurses only approved templates, approved by someone other than the author, and fills the placeholders", async () => {
    const author = await agentFor("rishma@irisstar.tech", "platform_super_administrator");
    const approver = await agentFor("clinlead2@irisstar.tech", "platform_super_administrator");
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    const id = (await author.post("/api/v1/note-templates").send(body).expect(201)).body.template.id;
    expect((await nurse.get("/api/v1/note-templates").expect(200)).body.templates).toHaveLength(0);
    await author.post(`/api/v1/note-templates/${id}/approve`).expect(403);
    await approver.post(`/api/v1/note-templates/${id}/approve`).expect(200);
    expect((await nurse.get("/api/v1/note-templates").query({ section: "plan" }).expect(200)).body.templates).toHaveLength(1);
    const out = (await nurse.post(`/api/v1/note-templates/${id}/render`).send({ patient: "the patient", destination: "Al Khor clinic" }).expect(200)).body;
    expect(out.text).toBe("Refer the patient to Al Khor clinic for review today.");
    expect((await nurse.post(`/api/v1/note-templates/${id}/render`).send({ patient: "x" }).expect(200)).body.missing).toEqual(["destination"]);
  });

  it("returns an edited template to draft so its new wording needs a new approval", async () => {
    const author = await agentFor("rishma@irisstar.tech", "platform_super_administrator");
    const approver = await agentFor("clinlead2@irisstar.tech", "platform_super_administrator");
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    const id = (await author.post("/api/v1/note-templates").send(body).expect(201)).body.template.id;
    await approver.post(`/api/v1/note-templates/${id}/approve`).expect(200);
    const edited = (await author.put(`/api/v1/note-templates/${id}`).send({ ...body, body: "Advise {{patient}} to rest and review at {{destination}}." }).expect(200)).body.template;
    expect(edited).toMatchObject({ status: "draft", version: 2 });
    expect((await nurse.get("/api/v1/note-templates").expect(200)).body.templates).toHaveLength(0);
    await nurse.post(`/api/v1/note-templates/${id}/render`).send({}).expect(404);
  });

  it("rejects unknown placeholders and bars nurses from writing templates", async () => {
    const author = await agentFor("rishma@irisstar.tech", "platform_super_administrator");
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    await author.post("/api/v1/note-templates").send({ ...body, body: "Hello {{ssn}} there" }).expect(400);
    await nurse.post("/api/v1/note-templates").send(body).expect(403);
    await nurse.get("/api/v1/note-templates/all").expect(403);
  });
});
