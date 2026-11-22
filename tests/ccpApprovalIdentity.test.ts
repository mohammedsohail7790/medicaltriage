import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { getEmployeeCcpSummary } from "../src/services/ccp.js";
import { resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

const PASSWORD = "TestAdminPassword!2026";
process.env.ADMIN_PASSWORD = PASSWORD;

// OI-37: the reviewer's role and identity on an outbound message approval come from the session, not the request.
describe("CCP message approval uses the session identity", () => {
  const app = createApp();
  beforeEach(() => {
    resetSecurityStoreForTests();
    resetRateLimitBucketsForTests();
  });

  async function login(username: string, simulateRole?: string) {
    const agent = request.agent(app);
    await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD, ...(simulateRole ? { simulateRole } : {}) }).expect(200);
    return agent;
  }

  async function newDraft(agent: ReturnType<typeof request.agent>) {
    const summary = await getEmployeeCcpSummary("IST-10002");
    if (!summary) throw new Error("The test employee has no communication thread.");
    const channel = summary.consent.channels.find((c) => c.status !== "disabled" && ["sms", "whatsapp", "email"].includes(c.channel))?.channel as "sms" | "whatsapp" | "email" | undefined;
    if (!channel) throw new Error("The test employee has no enabled channel.");
    const created = await agent.post("/api/v1/ccp/messages/draft").send({
      istStaffId: "IST-10002", threadId: summary.currentThread.id, channel, to: channel === "email" ? "employee@example.test" : "+97455500001", body: "Please call the clinic."
    });
    if (created.status !== 201) throw new Error(`Draft not created: ${created.status} ${JSON.stringify(created.body)}`);
    return created.body.draft.id as string;
  }

  it("refuses a service manager who claims to be a Remote Triage Nurse in the request", async () => {
    const nurse = await login("layla@irisstar.tech", "remote_triage_nurse");
    const draftId = await newDraft(nurse);
    const manager = await login("khalid@irisstar.tech", "triage_service_manager");
    const response = await manager.post(`/api/v1/ccp/messages/${draftId}/approve-send`).send({ reviewerId: "layla", reviewerRole: "Remote Triage Nurse" });
    expect([401, 403]).toContain(response.status);
    const drafts = await nurse.get("/api/v1/ccp/messages/drafts").expect(200);
    expect(drafts.body.drafts.find((d: { id: string }) => d.id === draftId).status).toBe("pending-nurse-review");
  });

  it("refuses a platform administrator who claims the nurse role", async () => {
    const nurse = await login("layla@irisstar.tech", "remote_triage_nurse");
    const draftId = await newDraft(nurse);
    const admin = await login("rishma@irisstar.tech");
    const response = await admin.post(`/api/v1/ccp/messages/${draftId}/approve-send`).send({ reviewerId: "x", reviewerRole: "Remote Triage Nurse" });
    expect([401, 403]).toContain(response.status);
  });

  it("refuses an unauthenticated caller", async () => {
    await request(app).post("/api/v1/ccp/messages/some-draft/approve-send").send({ reviewerId: "x", reviewerRole: "Remote Triage Nurse" }).expect(401);
  });

  it("lets the nurse approve with no reviewer fields, and records the nurse's own identity even if the request forges one", async () => {
    const nurse = await login("layla@irisstar.tech", "remote_triage_nurse");
    const session = await nurse.get("/api/v1/auth/session").expect(200);
    const nurseId = session.body.session?.user?.id ?? session.body.user?.id;
    expect(nurseId).toBeTruthy();
    const draftId = await newDraft(nurse);
    const response = await nurse.post(`/api/v1/ccp/messages/${draftId}/approve-send`).send({ reviewerId: "someone-else", reviewerRole: "Platform Administrator" });
    expect(response.status).toBe(200);
    expect(response.body.draft.approval.approvedById).toBe(nurseId);
    expect(response.body.draft.approval.approvedByRole).toBe("Remote Triage Nurse");
  });
});
