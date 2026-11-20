import { authenticator } from "otplib";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { RULE_DEFINITIONS, listRules, resetRulesCacheForTests, rule, ruleHistory, setRule } from "../src/services/businessRules.js";
import { resetClinicalWorkForTests } from "../src/services/clinicalWork.js";
import { computePriority } from "../src/services/queueOrchestration.js";
import { confirmMfaEnrollment, enrollMfa, resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";

beforeEach(() => {
  resetClinicalWorkForTests();
  resetRulesCacheForTests();
});

const base = { safetyFloorActive: false, calculatedSeverity: undefined, slaDeadlineIso: new Date(Date.now() + 10.5 * 60_000).toISOString(), patientType: "Dependent" as const, jobTitle: "Pilot", customAviationTags: [] as string[] };

describe("NFR-144 configurable business rules", () => {
  it("starts with the former constants as defaults", () => {
    expect(rule("queue.priority.emergency")).toBe(10_000);
    expect(rule("queue.lock_minutes")).toBe(5);
    expect(() => rule("nope")).toThrow(/Unknown rule/);
    expect(computePriority({ ...base })).toBe(1_500 - 10 * 25 + 600 + 350);
  });

  it("changes queue ranking as soon as a rule is edited, with no deployment", async () => {
    const before = computePriority({ ...base });
    await setRule("queue.priority.dependent", 5_000, "usr_admin", "Dependants are the priority this quarter");
    expect(rule("queue.priority.dependent")).toBe(5_000);
    expect(computePriority({ ...base })).toBe(before + 4_400);
    await setRule("queue.priority.dependent", 600, "usr_admin", "Back to the default");
    expect(computePriority({ ...base })).toBe(before);
  });

  it("validates type, range and that a reason is given", async () => {
    await expect(setRule("queue.lock_minutes", "ten", "u", "Because I said so")).rejects.toMatchObject({ code: "RULE_VALUE_INVALID" });
    await expect(setRule("queue.lock_minutes", 2.5, "u", "Because I said so")).rejects.toMatchObject({ code: "RULE_VALUE_INVALID" });
    await expect(setRule("queue.lock_minutes", 999, "u", "Because I said so")).rejects.toMatchObject({ code: "RULE_VALUE_RANGE" });
    await expect(setRule("queue.lock_minutes", 10, "u", "")).rejects.toMatchObject({ code: "RULE_REASON_REQUIRED" });
    await expect(setRule("nope", 1, "u", "Because I said so")).rejects.toMatchObject({ code: "RULE_UNKNOWN" });
  });

  it("versions every change with who and why, and lists the current values", async () => {
    await setRule("queue.lock_minutes", 8, "usr_a", "Longer calls on night shift");
    await setRule("queue.lock_minutes", 6, "usr_b", "Eight was too long");
    const history = await ruleHistory("queue.lock_minutes");
    expect(history.map((h) => [h.version, h.previous, h.value, h.by])).toEqual(expect.arrayContaining([[1, 5, 8, "usr_a"], [2, 8, 6, "usr_b"]]));
    const view = (await listRules()).find((r) => r.key === "queue.lock_minutes")!;
    expect(view).toMatchObject({ value: 6, version: 2, isDefault: false, default: 5 });
    expect(RULE_DEFINITIONS.every((d) => d.default >= d.min && d.default <= d.max)).toBe(true);
  });

  describe("through the admin API", () => {
    const app = createApp();
    beforeEach(() => { resetSecurityStoreForTests(); resetRateLimitBucketsForTests(); });
    async function elevated() {
      const agent = request.agent(app);
      await agent.post("/api/v1/auth/login").send({ username: "rishma@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);
      const { secret } = enrollMfa("usr_platform_admin_10001");
      confirmMfaEnrollment("usr_platform_admin_10001", authenticator.generate(secret));
      await agent.post("/api/v1/admin/elevate").send({ code: authenticator.generate(secret) }).expect(200);
      return agent;
    }

    it("lists, changes (audited, elevated) and shows history", async () => {
      const a = await elevated();
      const list = (await a.get("/api/v1/admin/ops/rules").expect(200)).body;
      expect(list.rules.length).toBe(RULE_DEFINITIONS.length);
      expect(list.note).toMatch(/clinical safety floors/i);
      await a.put("/api/v1/admin/ops/rules/queue.lock_minutes").send({ value: 9 }).expect(400);
      await a.put("/api/v1/admin/ops/rules/queue.lock_minutes").send({ value: 9, reason: "Pilot with night shift" }).expect(200);
      expect((await a.get("/api/v1/admin/ops/rules/queue.lock_minutes/history").expect(200)).body.history[0]).toMatchObject({ value: 9, previous: 5 });
      await a.post("/api/v1/admin/de-elevate").expect(200);
      await a.put("/api/v1/admin/ops/rules/queue.lock_minutes").send({ value: 3, reason: "No elevation here" }).expect(403);
    });
  });
});
