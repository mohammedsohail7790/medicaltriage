import { createHash } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { resetSecretProvider } from "../src/config/secrets.js";
import {
  captchaFailureThreshold,
  captchaProvider,
  captchaRequirement,
  issueSelfChallenge,
  resetCaptchaForTests,
  setCaptchaFetchForTests,
  validateCaptchaConfiguration,
  verifyCaptcha,
  type SelfChallenge
} from "../src/services/captcha.js";
import { listAuditEvents, resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
const app = createApp();

function solve(challenge: SelfChallenge): string {
  for (let n = 0; n <= challenge.maxnumber; n += 1) {
    if (createHash("sha256").update(`${challenge.salt}${n}`).digest("hex") === challenge.challenge) {
      return Buffer.from(JSON.stringify({ salt: challenge.salt, challenge: challenge.challenge, number: n, signature: challenge.signature })).toString("base64");
    }
  }
  throw new Error("unsolvable");
}

const login = (password: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  request(app).post("/api/v1/auth/login").set(headers).send({ username: "layla@irisstar.tech", password, simulateRole: "remote_triage_nurse", ...extra });

describe("NFR-020 CAPTCHA for specific sign-in situations", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    resetSecurityStoreForTests();
    resetRateLimitBucketsForTests();
    resetCaptchaForTests();
  });
  afterEach(() => {
    process.env = { ...originalEnv, ADMIN_PASSWORD: "TestAdminPassword!2026" };
    resetSecretProvider();
  });

  describe("when it is not configured", () => {
    it("changes nothing", async () => {
      expect(captchaProvider()).toBeUndefined();
      for (let i = 0; i < 4; i += 1) await login("wrong").expect(401);
      await login("Layla@2026").expect(200);
      const config = await request(app).get("/api/v1/auth/login-config").expect(200);
      expect(config.body.captcha).toBeNull();
    });
  });

  describe("after repeated failed attempts (self-hosted method)", () => {
    beforeEach(() => {
      process.env.CAPTCHA_PROVIDER = "self";
      process.env.CAPTCHA_SELF_DIFFICULTY = "2000";
      process.env.CAPTCHA_FAILURE_THRESHOLD = "3";
    });

    it("lets the first attempts through, then requires a challenge", async () => {
      for (let i = 0; i < 3; i += 1) await login("wrong").expect(401);
      const prompt = await login("Layla@2026").expect(403);
      expect(prompt.body).toMatchObject({ captchaRequired: true, reason: "failed-attempts", provider: "self" });
      expect(prompt.body.challenge).toMatchObject({ algorithm: "SHA-256", maxnumber: 2000 });
    });

    it("accepts a solved challenge, rejects a missing, wrong or reused one, and audits failures", async () => {
      for (let i = 0; i < 3; i += 1) await login("wrong").expect(401);
      const first = (await login("Layla@2026").expect(403)).body.challenge as SelfChallenge;

      await login("Layla@2026", { captchaToken: Buffer.from("{}").toString("base64") }).expect(403);
      expect(listAuditEvents().some((e) => e.action === "CAPTCHA_FAILED")).toBe(true);

      const solved = solve(first);
      await login("Layla@2026", { captchaToken: solved }).expect(200);
      // A used answer cannot be replayed.
      for (let i = 0; i < 3; i += 1) await login("wrong", { captchaToken: solve(issueSelfChallenge(2000)) }).expect(401);
      await login("Layla@2026", { captchaToken: solved }).expect(403);
    });

    it("rejects a challenge whose signature was altered or that has expired", async () => {
      const challenge = issueSelfChallenge(2000);
      const solved = JSON.parse(Buffer.from(solve(challenge), "base64").toString());
      expect(await verifyCaptcha(Buffer.from(JSON.stringify({ ...solved, signature: "0".repeat(64) })).toString("base64"), "1.1.1.1")).toBe("failed");
      const expired = issueSelfChallenge(2000);
      const expiredSalt = expired.salt.replace(/expires=\d+/, `expires=${Date.now() - 1000}`);
      expect(await verifyCaptcha(Buffer.from(JSON.stringify({ salt: expiredSalt, challenge: expired.challenge, number: 0, signature: expired.signature })).toString("base64"), "1.1.1.1")).toBe("failed");
    });

    it("serves fresh challenges to the sign-in page", async () => {
      const response = await request(app).get("/api/v1/auth/captcha/challenge").expect(200);
      expect(response.body.signature).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("from outside the approved networks", () => {
    beforeEach(() => {
      process.env.CAPTCHA_PROVIDER = "self";
      process.env.CAPTCHA_SELF_DIFFICULTY = "2000";
      process.env.CAPTCHA_APPROVED_NETWORKS = "198.51.100.0/24";
    });

    it("requires a challenge from the first attempt, and says so before it", async () => {
      const config = await request(app).get("/api/v1/auth/login-config").expect(200);
      expect(config.body.captcha).toMatchObject({ provider: "self", required: true, reason: "outside-approved-network" });
      const prompt = await login("Layla@2026").expect(403);
      expect(prompt.body.reason).toBe("outside-approved-network");
    });

    it("does not require one from an approved network until there are failures", () => {
      expect(captchaRequirement({ failedAttempts: 0, ipAddress: "198.51.100.20" })).toBeUndefined();
      expect(captchaRequirement({ failedAttempts: 3, ipAddress: "198.51.100.20" })).toBe("failed-attempts");
      expect(captchaRequirement({ failedAttempts: 0, ipAddress: "203.0.113.5" })).toBe("outside-approved-network");
    });
  });

  describe("third-party providers", () => {
    beforeEach(() => {
      process.env.CAPTCHA_PROVIDER = "turnstile";
      process.env.CAPTCHA_SITE_KEY = "site-key-123";
      process.env.CAPTCHA_SECRET = "captcha-secret-for-test";
      process.env.CAPTCHA_APPROVED_NETWORKS = "198.51.100.0/24";
    });

    it("sends the answer and secret to the provider and passes or fails on its verdict", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      setCaptchaFetchForTests(async (url, init) => {
        calls.push({ url, body: init.body });
        return { ok: true, json: async () => ({ success: init.body.includes("response=good-token") }) };
      });
      expect(await verifyCaptcha("good-token", "203.0.113.5")).toBe("passed");
      expect(await verifyCaptcha("bad-token", "203.0.113.5")).toBe("failed");
      expect(await verifyCaptcha(undefined, "203.0.113.5")).toBe("failed");
      expect(calls[0].url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
      expect(calls[0].body).toContain("secret=captcha-secret-for-test");
    });

    it("asks for the widget with the public site key", async () => {
      const prompt = await login("Layla@2026").expect(403);
      expect(prompt.body).toMatchObject({ captchaRequired: true, provider: "turnstile", siteKey: "site-key-123" });
      expect(prompt.body.challenge).toBeUndefined();
    });

    it("signs in once the provider approves the token", async () => {
      setCaptchaFetchForTests(async () => ({ ok: true, json: async () => ({ success: true }) }));
      await login("Layla@2026", { captchaToken: "token" }).expect(200);
    });

    it("refuses sign-in when the provider is unreachable, unless fail-open is set", async () => {
      setCaptchaFetchForTests(async () => {
        throw new Error("network down");
      });
      expect(await verifyCaptcha("token", "203.0.113.5")).toBe("unavailable");
      await login("Layla@2026", { captchaToken: "token" }).expect(403);
      process.env.CAPTCHA_FAIL_MODE = "open";
      await login("Layla@2026", { captchaToken: "token" }).expect(200);
    });

    it("lets the provider's origins into the page security policy only while it is configured", async () => {
      const { createApp: build } = await import("../src/app.js");
      const withProvider = await request(build()).get("/api/v1/runtime/environment");
      expect(withProvider.headers["content-security-policy"]).toContain("https://challenges.cloudflare.com");
      delete process.env.CAPTCHA_PROVIDER;
      const without = await request(build()).get("/api/v1/runtime/environment");
      expect(without.headers["content-security-policy"]).not.toContain("cloudflare");
    });
  });

  describe("configuration", () => {
    it("is validated at startup", () => {
      expect(() => validateCaptchaConfiguration({})).not.toThrow();
      expect(() => validateCaptchaConfiguration({ CAPTCHA_PROVIDER: "nonsense" })).toThrow(/must be/);
      expect(() => validateCaptchaConfiguration({ CAPTCHA_PROVIDER: "hcaptcha" })).toThrow(/CAPTCHA_SITE_KEY/);
      expect(() => validateCaptchaConfiguration({ CAPTCHA_PROVIDER: "custom", CAPTCHA_SITE_KEY: "k" })).toThrow(/CAPTCHA_VERIFY_URL/);
      expect(() => validateCaptchaConfiguration({ CAPTCHA_PROVIDER: "self", NODE_ENV: "production" })).toThrow(/CAPTCHA_SECRET/);
      expect(() => validateCaptchaConfiguration({ CAPTCHA_PROVIDER: "self", NODE_ENV: "production", CAPTCHA_SECRET: "s" })).not.toThrow();
      expect(() => validateCaptchaConfiguration({ CAPTCHA_PROVIDER: "self", CAPTCHA_FAILURE_THRESHOLD: "zero" })).toThrow(/positive/);
      expect(captchaFailureThreshold({})).toBe(3);
      expect(captchaFailureThreshold({ CAPTCHA_FAILURE_THRESHOLD: "7" })).toBe(7);
    });
  });
});
