import { authenticator } from "otplib";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import {
  DEFAULT_PASSWORD_POLICY,
  isPasswordExpired,
  passwordViolations,
  PasswordPolicySchema,
  resetPasswordPolicyForTests,
  savePasswordPolicy
} from "../src/services/passwordPolicy.js";
import { confirmMfaEnrollment, createUser, enrollMfa, listAuditEvents, resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
const app = createApp();
const STRONG = "Correct-Horse-Battery-9";
const STRONGER = "Another-Sturdy-Phrase-7!";

async function newAccount(name: string) {
  const email = `${name}@irisstar.tech`;
  const created = await createUser(
    { fullName: "Policy Tester", email, mobile: "+97450002016", organization: "IST Tech", facility: "UAT", department: "Security", jobTitle: "Nurse", roles: ["remote_triage_nurse"] },
    { userId: "usr_platform_admin_10001", reason: "NFR-016 test" }
  );
  return { email, temporaryPassword: created.temporaryPassword, userId: created.user.id };
}
const login = (email: string, password: string) => request(app).post("/api/v1/auth/login").send({ username: email, password, simulateRole: "remote_triage_nurse" });
const change = (body: Record<string, unknown>) => request(app).post("/api/v1/auth/password/change").send(body);

describe("NFR-016 administrator-configurable password policy", () => {
  beforeEach(() => {
    resetSecurityStoreForTests();
    resetRateLimitBucketsForTests();
    resetPasswordPolicyForTests();
  });
  afterEach(() => jest.useRealTimers());

  describe("rules", () => {
    it("enforces length and each complexity class", () => {
      const policy = DEFAULT_PASSWORD_POLICY;
      expect(passwordViolations("short", policy)).toEqual(expect.arrayContaining([expect.stringMatching(/at least 12/)]));
      expect(passwordViolations("alllowercaseletters1!", policy)).toEqual(["Include an uppercase letter."]);
      expect(passwordViolations("ALLUPPERCASELETTERS1!", policy)).toEqual(["Include a lowercase letter."]);
      expect(passwordViolations("NoDigitsInThisOne!!", policy)).toEqual(["Include a digit."]);
      expect(passwordViolations("NoSymbolsInThisOne11", policy)).toEqual(["Include a symbol."]);
      expect(passwordViolations(STRONG, policy)).toEqual([]);
    });

    it("lets an administrator relax or tighten each rule", () => {
      const relaxed = { ...DEFAULT_PASSWORD_POLICY, minLength: 8, requireSymbol: false, requireUppercase: false };
      expect(passwordViolations("lowercase1", relaxed)).toEqual([]);
      expect(passwordViolations("Abcdefg1!", { ...DEFAULT_PASSWORD_POLICY, minLength: 20 })).toEqual([expect.stringMatching(/at least 20/)]);
    });

    it("refuses passwords that contain the user's name or user name", () => {
      expect(passwordViolations("Jordan-Smith-2026!", DEFAULT_PASSWORD_POLICY, { email: "jordan@irisstar.tech", fullName: "Jordan Smith" })).toEqual(["Do not include your name or user name."]);
    });

    it("computes expiry, and never expires when the period is 0", () => {
      const now = Date.now();
      const ninetyDays = { ...DEFAULT_PASSWORD_POLICY, maxAgeDays: 90 };
      expect(isPasswordExpired(new Date(now - 91 * 86400000), ninetyDays, now)).toBe(true);
      expect(isPasswordExpired(new Date(now - 89 * 86400000), ninetyDays, now)).toBe(false);
      expect(isPasswordExpired(new Date(now - 900 * 86400000), DEFAULT_PASSWORD_POLICY, now)).toBe(false);
    });

    it("bounds every setting", () => {
      expect(PasswordPolicySchema.safeParse({ ...DEFAULT_PASSWORD_POLICY, minLength: 4 }).success).toBe(false);
      expect(PasswordPolicySchema.safeParse({ ...DEFAULT_PASSWORD_POLICY, lockoutThreshold: 1 }).success).toBe(false);
      expect(PasswordPolicySchema.safeParse({ ...DEFAULT_PASSWORD_POLICY, historyCount: 99 }).success).toBe(false);
      expect(PasswordPolicySchema.safeParse(DEFAULT_PASSWORD_POLICY).success).toBe(true);
    });
  });

  describe("sign-in and change", () => {
    beforeEach(async () => {
      await savePasswordPolicy({ ...DEFAULT_PASSWORD_POLICY, forceChangeOnFirstLogin: true }, "test");
    });

    it("leaves sign-in unchanged until an administrator turns the controls on", async () => {
      await savePasswordPolicy({ ...DEFAULT_PASSWORD_POLICY }, "test");
      const account = await newAccount("defaults.user");
      await login(account.email, account.temporaryPassword).expect(200);
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"], now: Date.now() + 1000 * 86400000 });
      await login(account.email, account.temporaryPassword).expect(200);
    });

    it("requires a temporary password to be changed before a session is issued", async () => {
      const account = await newAccount("temp.user");
      const blocked = await login(account.email, account.temporaryPassword).expect(403);
      expect(blocked.body).toMatchObject({ passwordChangeRequired: "temporary" });
      expect(blocked.headers["set-cookie"]).toBeUndefined();
    });

    it("explains every failed rule, then accepts a compliant password and signs in with it", async () => {
      const account = await newAccount("change.user");
      const weak = await change({ username: account.email, currentPassword: account.temporaryPassword, newPassword: "weak" }).expect(422);
      expect(weak.body.code).toBe("PASSWORD_POLICY");
      expect(weak.body.violations.length).toBeGreaterThanOrEqual(3);

      await change({ username: account.email, currentPassword: account.temporaryPassword, newPassword: STRONG }).expect(200);
      await login(account.email, account.temporaryPassword).expect(401);
      await login(account.email, STRONG).expect(200);
      expect(listAuditEvents().some((e) => e.action === "PASSWORD_CHANGED" && e.userId === account.userId)).toBe(true);
    });

    it("never records a password or hash in the audit trail", async () => {
      const account = await newAccount("audit.user");
      await change({ username: account.email, currentPassword: account.temporaryPassword, newPassword: STRONG }).expect(200);
      const event = listAuditEvents().find((e) => e.action === "PASSWORD_CHANGED" && e.userId === account.userId);
      expect(JSON.stringify(event)).not.toContain(STRONG);
      expect(JSON.stringify(event)).not.toContain(account.temporaryPassword);
    });

    it("refuses a wrong current password and the same password again", async () => {
      const account = await newAccount("wrong.current");
      await change({ username: account.email, currentPassword: "not-the-password", newPassword: STRONG }).expect(401);
      await change({ username: account.email, currentPassword: account.temporaryPassword, newPassword: account.temporaryPassword }).expect(422);
    });

    it("refuses reuse of recent passwords, and allows it when the history setting is 0", async () => {
      const account = await newAccount("history.user");
      await change({ username: account.email, currentPassword: account.temporaryPassword, newPassword: STRONG }).expect(200);
      await change({ username: account.email, currentPassword: STRONG, newPassword: STRONGER }).expect(200);
      const reuse = await change({ username: account.email, currentPassword: STRONGER, newPassword: STRONG }).expect(422);
      expect(reuse.body.violations.join(" ")).toMatch(/last 5 passwords/);

      await savePasswordPolicy({ ...DEFAULT_PASSWORD_POLICY, historyCount: 0 }, "test");
      await change({ username: account.email, currentPassword: STRONGER, newPassword: STRONG }).expect(200);
    });

    it("expires a password after the configured number of days", async () => {
      const account = await newAccount("expiry.user");
      await change({ username: account.email, currentPassword: account.temporaryPassword, newPassword: STRONG }).expect(200);
      await savePasswordPolicy({ ...DEFAULT_PASSWORD_POLICY, maxAgeDays: 90, forceChangeOnFirstLogin: true }, "test");
      await login(account.email, STRONG).expect(200);
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"], now: Date.now() + 91 * 86400000 });
      const expired = await login(account.email, STRONG).expect(403);
      expect(expired.body.passwordChangeRequired).toBe("expired");
      jest.useRealTimers();
      await savePasswordPolicy({ ...DEFAULT_PASSWORD_POLICY, maxAgeDays: 0, forceChangeOnFirstLogin: true }, "test");
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"], now: Date.now() + 400 * 86400000 });
      await login(account.email, STRONG).expect(200);
    });

    it("does not force a change when the policy turns that off", async () => {
      await savePasswordPolicy({ ...DEFAULT_PASSWORD_POLICY, forceChangeOnFirstLogin: false }, "test");
      const account = await newAccount("no.force");
      await login(account.email, account.temporaryPassword).expect(200);
    });

    it("keeps the signed-in session and ends the user's other sessions after a change", async () => {
      await savePasswordPolicy({ ...DEFAULT_PASSWORD_POLICY, forceChangeOnFirstLogin: false }, "test");
      const account = await newAccount("sessions.user");
      const first = request.agent(app);
      const second = request.agent(app);
      await first.post("/api/v1/auth/login").send({ username: account.email, password: account.temporaryPassword, simulateRole: "remote_triage_nurse" }).expect(200);
      await second.post("/api/v1/auth/login").send({ username: account.email, password: account.temporaryPassword, simulateRole: "remote_triage_nurse" }).expect(200);
      await first.post("/api/v1/auth/password/change").send({ currentPassword: account.temporaryPassword, newPassword: STRONG }).expect(200);
      await first.get("/api/v1/auth/session").expect(200);
      await second.get("/api/v1/auth/session").expect(401);
    });

    it("does not offer a password change to accounts that sign in elsewhere", async () => {
      const response = await change({ username: "layla@irisstar.tech", currentPassword: "Layla@2026", newPassword: STRONG }).expect(403);
      expect(response.body.code).toBe("PASSWORD_CHANGE_NOT_ALLOWED");
    });

    it("publishes the policy so the form can show it, without lockout settings", async () => {
      const response = await request(app).get("/api/v1/auth/password/policy").expect(200);
      expect(response.body).toMatchObject({ minLength: 12, requireSymbol: true, historyCount: 5, maxAgeDays: 0 });
      expect(response.body.lockoutThreshold).toBeUndefined();
    });
  });

  describe("lockout", () => {
    it("locks after the configured number of failures and unlocks when the period ends", async () => {
      await savePasswordPolicy({ ...DEFAULT_PASSWORD_POLICY, lockoutThreshold: 3, lockoutDurationMinutes: 10, forceChangeOnFirstLogin: false }, "test");
      const account = await newAccount("lock.user");
      for (let i = 0; i < 3; i += 1) await login(account.email, "wrong-password").expect(401);
      const locked = await login(account.email, account.temporaryPassword).expect(423);
      expect(locked.body.message).toMatch(/locked/i);

      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"], now: Date.now() + 11 * 60 * 1000 });
      resetRateLimitBucketsForTests();
      await login(account.email, account.temporaryPassword).expect(200);
    });

    it("keeps the earlier default of 5 failures", async () => {
      const account = await newAccount("lock.default");
      for (let i = 0; i < 4; i += 1) await login(account.email, "wrong-password").expect(401);
      await login(account.email, "wrong-password").expect(401);
      await login(account.email, "wrong-password").expect(423);
    });
  });

  describe("administration", () => {
    async function adminAgent() {
      const agent = request.agent(app);
      await agent.post("/api/v1/auth/login").send({ username: "rishma@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);
      const { secret } = enrollMfa("usr_platform_admin_10001");
      confirmMfaEnrollment("usr_platform_admin_10001", authenticator.generate(secret));
      await agent.post("/api/v1/admin/elevate").send({ code: authenticator.generate(secret) }).expect(200);
      return agent;
    }

    it("lets an elevated administrator read and change the policy, auditing before and after", async () => {
      const admin = await adminAgent();
      const before = await admin.get("/api/v1/admin/password-policy").expect(200);
      expect(before.body.policy.minLength).toBe(12);
      const updated = await admin.put("/api/v1/admin/password-policy").send({ minLength: 16, maxAgeDays: 60, requireSymbol: false }).expect(200);
      expect(updated.body.policy).toMatchObject({ minLength: 16, maxAgeDays: 60, requireSymbol: false, historyCount: 5 });
      const event = listAuditEvents().find((e) => e.action === "PASSWORD_POLICY_UPDATED");
      expect(event?.metadata).toMatchObject({ change: { fields: expect.arrayContaining(["minLength", "maxAgeDays", "requireSymbol"]), before: { minLength: 12 }, after: { minLength: 16 } } });
      // The new rule applies at once.
      const account = await newAccount("after.update");
      const short = await change({ username: account.email, currentPassword: account.temporaryPassword, newPassword: "Shorter-Pass-1" }).expect(422);
      expect(short.body.violations.join(" ")).toMatch(/at least 16/);
    });

    it("rejects out-of-range settings and requires elevation to change anything", async () => {
      const admin = await adminAgent();
      await admin.put("/api/v1/admin/password-policy").send({ minLength: 3 }).expect(400);
      await admin.post("/api/v1/admin/de-elevate").expect(200);
      await admin.put("/api/v1/admin/password-policy").send({ minLength: 14 }).expect(403);
    });
  });
});
