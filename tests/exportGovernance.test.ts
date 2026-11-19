import { authenticator } from "otplib";
import request from "supertest";
import { createApp } from "../src/app.js";
import { validateExportDlpConfiguration } from "../src/config/exportConfig.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { resetExportGovernanceForTests, setExportDlpFetchForTests } from "../src/services/exportGovernance.js";
import { resetSecretProvider } from "../src/config/secrets.js";
import {
  confirmMfaEnrollment,
  enrollMfa,
  listAuditEvents,
  resetSecurityStoreForTests,
  upsertDirectoryUserFromHrms
} from "../src/services/securityAdmin.js";

const PASSWORD = "TestAdminPassword!2026";
process.env.ADMIN_PASSWORD = PASSWORD;
const app = createApp();
const ORG = "org_ist_tech";

async function adminAgent(username: string, userId: string) {
  const agent = request.agent(app);
  await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);
  const { secret } = enrollMfa(userId);
  confirmMfaEnrollment(userId, authenticator.generate(secret));
  await agent.post("/api/v1/admin/elevate").send({ code: authenticator.generate(secret) }).expect(200);
  return agent;
}

async function twoAdmins() {
  const first = await adminAgent("rishma@irisstar.tech", "usr_platform_admin_10001");
  const created = upsertDirectoryUserFromHrms({
    employeeId: "IST-10099",
    email: "second.admin@irisstar.tech",
    fullName: "Second Administrator",
    organizationCode: "IST_TECH",
    jobTitle: "Platform Administrator",
    roles: ["platform_super_administrator"]
  });
  const second = await adminAgent("second.admin@irisstar.tech", created.user.id);
  return { first, second };
}

const actions = () => listAuditEvents().map((event) => event.action);
const exportEvent = (action: string) => listAuditEvents().find((event) => event.action === action);

describe("M-021 export governance", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    resetSecurityStoreForTests();
    resetRateLimitBucketsForTests();
    resetExportGovernanceForTests();
  });
  afterEach(() => {
    process.env = { ...originalEnv, ADMIN_PASSWORD: PASSWORD };
    resetSecretProvider();
    setExportDlpFetchForTests(undefined);
  });

  it("refuses an administrator export that has no approval, and logs the refusal", async () => {
    const { first } = await twoAdmins();
    const response = await first.get(`/api/v1/admin/organizations/${ORG}/export`).expect(403);
    expect(response.body.code).toBe("EXPORT_APPROVAL_REQUIRED");
    expect(exportEvent("EXPORT_DENIED")?.success).toBe(false);
  });

  it("releases an export after a second administrator approves it, then refuses reuse", async () => {
    const { first, second } = await twoAdmins();
    const requested = await first.post(`/api/v1/admin/organizations/${ORG}/export-requests`).send({ reason: "Quarterly data portability request" }).expect(201);
    const id = requested.body.approval.id as string;

    await first.get(`/api/v1/admin/organizations/${ORG}/export?approvalId=${id}`).expect(403);
    await second.post(`/api/v1/admin/export-requests/${id}/decision`).send({ decision: "approve", comments: "Checked with the data owner" }).expect(200);

    const released = await first.get(`/api/v1/admin/organizations/${ORG}/export?approvalId=${id}`).expect(200);
    expect(released.headers["content-disposition"]).toMatch(/attachment; filename="ist-health-org-export-/);

    const reuse = await first.get(`/api/v1/admin/organizations/${ORG}/export?approvalId=${id}`).expect(403);
    expect(reuse.body.code).toBe("EXPORT_APPROVAL_USED");

    expect(actions()).toEqual(expect.arrayContaining(["EXPORT_REQUESTED", "EXPORT_APPROVAL_DECIDED", "EXPORT_COMPLETED", "EXPORT_DENIED"]));
    const completed = exportEvent("EXPORT_COMPLETED");
    expect(completed?.metadata).toMatchObject({ kind: "organization", approvalId: id, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(completed?.metadata?.approverId).toBeTruthy();
  });

  it("does not let an administrator approve their own request", async () => {
    const { first } = await twoAdmins();
    const requested = await first.post(`/api/v1/admin/organizations/${ORG}/export-requests`).send({ reason: "Self approval attempt here" }).expect(201);
    const denied = await first.post(`/api/v1/admin/export-requests/${requested.body.approval.id}/decision`).send({ decision: "approve" }).expect(403);
    expect(denied.body.code).toBe("EXPORT_SELF_APPROVAL");
  });

  it("does not release a rejected request, or one approved for a different organisation", async () => {
    const { first, second } = await twoAdmins();
    const rejected = await first.post(`/api/v1/admin/organizations/${ORG}/export-requests`).send({ reason: "Request that will be rejected" }).expect(201);
    await second.post(`/api/v1/admin/export-requests/${rejected.body.approval.id}/decision`).send({ decision: "reject" }).expect(200);
    await first.get(`/api/v1/admin/organizations/${ORG}/export?approvalId=${rejected.body.approval.id}`).expect(403);

    const approved = await first.post(`/api/v1/admin/organizations/${ORG}/export-requests`).send({ reason: "Approved for one organisation" }).expect(201);
    await second.post(`/api/v1/admin/export-requests/${approved.body.approval.id}/decision`).send({ decision: "approve" }).expect(200);
    await first.get(`/api/v1/admin/organizations/another_org/export?approvalId=${approved.body.approval.id}`).expect(403);
  });

  it("rejects an expired approval", async () => {
    process.env.EXPORT_APPROVAL_TTL_MINUTES = "0.0001";
    const { first, second } = await twoAdmins();
    const requested = await first.post(`/api/v1/admin/organizations/${ORG}/export-requests`).send({ reason: "Approval that will expire" }).expect(201);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const late = await second.post(`/api/v1/admin/export-requests/${requested.body.approval.id}/decision`).send({ decision: "approve" }).expect(410);
    expect(late.body.code).toBe("EXPORT_REQUEST_EXPIRED");
  });

  it("requires a stated reason for an export request", async () => {
    const { first } = await twoAdmins();
    await first.post(`/api/v1/admin/organizations/${ORG}/export-requests`).send({ reason: "short" }).expect(400);
  });

  it("logs a user's own export", async () => {
    const nurse = request.agent(app);
    await nurse.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
    await nurse.get("/api/v1/me/export").expect(200);
    const event = exportEvent("EXPORT_COMPLETED");
    expect(event?.metadata).toMatchObject({ kind: "self", sha256: expect.any(String), bytes: expect.any(Number) });
  });

  describe("disabling exports by configuration", () => {
    it("stops every export when EXPORTS_ENABLED=false", async () => {
      process.env.EXPORTS_ENABLED = "false";
      const nurse = request.agent(app);
      await nurse.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
      const blocked = await nurse.get("/api/v1/me/export").expect(403);
      expect(blocked.body.code).toBe("EXPORTS_DISABLED");
      const { first } = await twoAdmins();
      const adminBlocked = await first.post(`/api/v1/admin/organizations/${ORG}/export-requests`).send({ reason: "Export while disabled" }).expect(403);
      expect(adminBlocked.body.code).toBe("EXPORTS_DISABLED");
      expect(actions()).toContain("EXPORT_DENIED");
    });

    it("stops only the named kinds when EXPORTS_DISABLED_KINDS is set", async () => {
      process.env.EXPORTS_DISABLED_KINDS = "self";
      const nurse = request.agent(app);
      await nurse.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
      await nurse.get("/api/v1/me/export").expect(403);
      const { first } = await twoAdmins();
      await first.post(`/api/v1/admin/organizations/${ORG}/export-requests`).send({ reason: "Organisation exports stay on" }).expect(201);
    });
  });

  describe("DLP inspection", () => {
    async function approvedRequest() {
      const { first, second } = await twoAdmins();
      const requested = await first.post(`/api/v1/admin/organizations/${ORG}/export-requests`).send({ reason: "DLP inspection test run" }).expect(201);
      const id = requested.body.approval.id as string;
      await second.post(`/api/v1/admin/export-requests/${id}/decision`).send({ decision: "approve" }).expect(200);
      return { first, id };
    }

    beforeEach(() => {
      process.env.EXPORT_DLP_URL = "https://dlp.example/inspect";
      process.env.EXPORT_DLP_SECRET = "dlp-secret-for-test-run";
    });

    it("sends metadata only, signed, and releases when the tool allows", async () => {
      const calls: Array<{ body: string; headers: Record<string, string> }> = [];
      setExportDlpFetchForTests(async (_url, init) => {
        calls.push({ body: init.body, headers: init.headers });
        return { ok: true, status: 200, json: async () => ({ allow: true }) };
      });
      const { first, id } = await approvedRequest();
      await first.get(`/api/v1/admin/organizations/${ORG}/export?approvalId=${id}`).expect(200);
      expect(calls).toHaveLength(1);
      const sent = JSON.parse(calls[0].body);
      expect(sent).toMatchObject({ kind: "organization", resourceId: ORG, sha256: expect.any(String), recordCount: expect.any(Number) });
      expect(sent.queueItems).toBeUndefined();
      expect(calls[0].headers["x-dlp-signature"]).toMatch(/^[a-f0-9]{64}$/);
    });

    it("blocks the export when the tool says no, and keeps the approval unused", async () => {
      setExportDlpFetchForTests(async () => ({ ok: true, status: 200, json: async () => ({ allow: false }) }));
      const { first, id } = await approvedRequest();
      const blocked = await first.get(`/api/v1/admin/organizations/${ORG}/export?approvalId=${id}`).expect(403);
      expect(blocked.body.code).toBe("EXPORT_BLOCKED_BY_DLP");
      setExportDlpFetchForTests(async () => ({ ok: true, status: 200, json: async () => ({ allow: true }) }));
      await first.get(`/api/v1/admin/organizations/${ORG}/export?approvalId=${id}`).expect(200);
    });

    it("blocks when the tool is unreachable unless fail-open is configured", async () => {
      setExportDlpFetchForTests(async () => {
        throw new Error("connect ECONNREFUSED");
      });
      const { first, id } = await approvedRequest();
      const blocked = await first.get(`/api/v1/admin/organizations/${ORG}/export?approvalId=${id}`).expect(503);
      expect(blocked.body.code).toBe("EXPORT_DLP_UNAVAILABLE");
      process.env.EXPORT_DLP_FAIL_MODE = "open";
      await first.get(`/api/v1/admin/organizations/${ORG}/export?approvalId=${id}`).expect(200);
    });
  });

  it("validates DLP configuration at startup", () => {
    expect(() => validateExportDlpConfiguration({})).not.toThrow();
    expect(() => validateExportDlpConfiguration({ EXPORT_DLP_URL: "not a url" })).toThrow(/valid URL/);
    expect(() => validateExportDlpConfiguration({ EXPORT_DLP_URL: "http://dlp.example", NODE_ENV: "production" })).toThrow(/https/);
    expect(() => validateExportDlpConfiguration({ EXPORT_DLP_URL: "https://dlp.example", NODE_ENV: "production" })).toThrow(/EXPORT_DLP_SECRET/);
    expect(() => validateExportDlpConfiguration({ EXPORT_DLP_URL: "https://dlp.example", NODE_ENV: "production", EXPORT_DLP_SECRET: "x" })).not.toThrow();
  });
});
