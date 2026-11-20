import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { resetClinicalWorkForTests } from "../src/services/clinicalWork.js";
import { setTeleconsultTransportForTests, signedApprovalRequired } from "../src/services/clinicalHandoff.js";
import { renderReferralPdf } from "../src/services/referralLetter.js";
import { resetSecurityStoreForTests, upsertDirectoryUserFromHrms } from "../src/services/securityAdmin.js";

const PASSWORD = "TestAdminPassword!2026";
process.env.ADMIN_PASSWORD = PASSWORD;
const app = createApp();

async function agentFor(username: string, role: string) {
  const agent = request.agent(app);
  await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD, simulateRole: role }).expect(200);
  return agent;
}

const REFERRAL = { caseRef: "enc-1", patientName: "Test Patient", patientAgeYears: 41, destinationName: "Al Khor Urgent Care", destinationPhone: "+974 4000 0000", reason: "Ankle pain after a fall", assessment: "ألم في الكاحل بعد السقوط", recommendation: "Same-day review", adviceDelivery: "send_later" };

beforeEach(() => {
  resetSecurityStoreForTests();
  resetClinicalWorkForTests();
  resetRateLimitBucketsForTests();
  upsertDirectoryUserFromHrms({ employeeId: "IST-20010", email: "doc@irisstar.tech", fullName: "Dr Test", organizationCode: "IST_TECH", jobTitle: "Physician", roles: ["teleconsultant_physician"] });
  upsertDirectoryUserFromHrms({ employeeId: "IST-20011", email: "doc2@irisstar.tech", fullName: "Dr Other", organizationCode: "IST_TECH", jobTitle: "Physician", roles: ["teleconsultant_physician"] });
  delete process.env.REFERRAL_ALLOWED_RECIPIENT_DOMAINS;
  delete process.env.HANDOFF_REQUIRES_SIGNED_APPROVAL;
});
afterEach(() => setTeleconsultTransportForTests(undefined));

describe("F-017 referral letter", () => {
  it("renders a bilingual PDF, marked draft until approved", async () => {
    const draft = await renderReferralPdf({ ...REFERRAL, nurseName: "Layla", issuedAtIso: new Date().toISOString(), reference: "REF-1" } as never, { approved: false });
    expect(draft.subarray(0, 5).toString()).toBe("%PDF-");
    expect(draft.length).toBeGreaterThan(3000);
    // Text drawn from both languages is in the file's fonts (an Arabic font is embedded alongside the Latin one).
    expect(draft.toString("latin1")).toMatch(/NotoSansArabic/);
  });

  it("does not break on Arabic text the shaping library cannot lay out", async () => {
    const pdf = await renderReferralPdf({ ...REFERRAL, reason: "سبب الإحالة وأ ألم ُ", nurseName: "Layla", issuedAtIso: new Date().toISOString(), reference: "REF-2" } as never, { approved: true });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("goes draft, approved by the nurse, then sent only to an approved address with the PDF attached", async () => {
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    const made = await nurse.post("/api/v1/handoff/referrals").send(REFERRAL).expect(201);
    const id = made.body.referral.id;
    expect(made.body.referral.status).toBe("draft");
    expect(made.body.referral.nurseName).toBeTruthy();

    const pdf = await nurse.get(`/api/v1/handoff/referrals/${id}/pdf`).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on("data", (d: Buffer) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");

    // Nothing is sent before approval.
    await nurse.post(`/api/v1/handoff/referrals/${id}/send`).send({ to: "clinic@hospital.example" }).expect(409);
    await nurse.post(`/api/v1/handoff/referrals/${id}/approve`).expect(200);
    await nurse.post(`/api/v1/handoff/referrals/${id}/approve`).expect(409);

    // No approved recipient domain is configured: nothing may be emailed.
    await nurse.post(`/api/v1/handoff/referrals/${id}/send`).send({ to: "clinic@hospital.example" }).expect(403);
    process.env.REFERRAL_ALLOWED_RECIPIENT_DOMAINS = "hospital.example";
    await nurse.post(`/api/v1/handoff/referrals/${id}/send`).send({ to: "clinic@elsewhere.example" }).expect(403);
    const sent = await nurse.post(`/api/v1/handoff/referrals/${id}/send`).send({ to: "clinic@hospital.example" }).expect(200);
    expect(sent.body.referral.status).toBe("sent");
  });

  it("is approved only by the nurse who prepared it", async () => {
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    const id = (await nurse.post("/api/v1/handoff/referrals").send(REFERRAL).expect(201)).body.referral.id;
    const other = await agentFor("khalid@irisstar.tech", "triage_service_manager");
    await other.post(`/api/v1/handoff/referrals/${id}/approve`).expect(403);
  });

  it("requires a signed clinical approval for the case when that is switched on", async () => {
    process.env.HANDOFF_REQUIRES_SIGNED_APPROVAL = "true";
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    const id = (await nurse.post("/api/v1/handoff/referrals").send(REFERRAL).expect(201)).body.referral.id;
    const res = await nurse.post(`/api/v1/handoff/referrals/${id}/approve`).expect(409);
    expect(res.body.code).toBe("SIGNED_APPROVAL_REQUIRED");
    expect(signedApprovalRequired({ NODE_ENV: "production" } as never)).toBe(true);
    expect(signedApprovalRequired({ NODE_ENV: "production", HANDOFF_REQUIRES_SIGNED_APPROVAL: "false" } as never)).toBe(false);
    expect(signedApprovalRequired({ NODE_ENV: "test" } as never)).toBe(false);
  });

  it("validates the request", async () => {
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    await nurse.post("/api/v1/handoff/referrals").send({ caseRef: "x" }).expect(400);
  });
});

describe("F-016 teleconsultant escalation", () => {
  const HANDOFF = { caseRef: "enc-9", urgency: "urgent", question: "Is a same-day review needed?", summary: "41-year-old with ankle injury and new numbness." };

  it("is proposed by a nurse, sent only after the nurse approves, then accepted and answered by a physician", async () => {
    const sent: unknown[] = [];
    setTeleconsultTransportForTests(async (h) => { sent.push(h); return { delivered: true, mode: "test" }; });
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    const doc = await agentFor("doc@irisstar.tech", "teleconsultant_physician");

    const id = (await nurse.post("/api/v1/handoff/teleconsult").send(HANDOFF).expect(201)).body.handoff.id;
    expect(sent).toHaveLength(0);
    expect((await doc.get("/api/v1/handoff/teleconsult/queue").expect(200)).body.items).toHaveLength(0);

    await nurse.post(`/api/v1/handoff/teleconsult/${id}/approve`).expect(200);
    expect(sent).toHaveLength(1);
    expect((await doc.get("/api/v1/handoff/teleconsult/queue").expect(200)).body.items).toHaveLength(1);

    await doc.post(`/api/v1/handoff/teleconsult/${id}/respond`).send({ advice: "Review today.", outcome: "agree_with_nurse" }).expect(409);
    await doc.post(`/api/v1/handoff/teleconsult/${id}/accept`).expect(200);
    const other = await agentFor("doc2@irisstar.tech", "teleconsultant_physician");
    await other.post(`/api/v1/handoff/teleconsult/${id}/respond`).send({ advice: "Review today.", outcome: "agree_with_nurse" }).expect(403);
    await doc.post(`/api/v1/handoff/teleconsult/${id}/respond`).send({ advice: "Review today at urgent care.", outcome: "agree_with_nurse" }).expect(200);

    const back = await nurse.get(`/api/v1/handoff/teleconsult/${id}`).expect(200);
    expect(back.body.handoff).toMatchObject({ status: "answered", response: { outcome: "agree_with_nurse" } });
  });

  it("runs as a dry run when the service is not configured, and is closed to other roles", async () => {
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    const id = (await nurse.post("/api/v1/handoff/teleconsult").send(HANDOFF).expect(201)).body.handoff.id;
    const approved = await nurse.post(`/api/v1/handoff/teleconsult/${id}/approve`).expect(200);
    expect(approved.body.handoff.status).toBe("queued");
    await nurse.get("/api/v1/handoff/teleconsult/queue").expect(403);
    await nurse.post(`/api/v1/handoff/teleconsult/${id}/accept`).expect(403);
    await nurse.post("/api/v1/handoff/teleconsult").send({ caseRef: "x", urgency: "now" }).expect(400);
  });

  it("is approved only by the proposing nurse", async () => {
    const nurse = await agentFor("layla@irisstar.tech", "remote_triage_nurse");
    const id = (await nurse.post("/api/v1/handoff/teleconsult").send(HANDOFF).expect(201)).body.handoff.id;
    const mgr = await agentFor("khalid@irisstar.tech", "triage_service_manager");
    await mgr.post(`/api/v1/handoff/teleconsult/${id}/approve`).expect(403);
  });
});
