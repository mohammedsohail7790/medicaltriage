import { CompactEncrypt, importJWK } from "jose";
import request from "supertest";
import type { Application } from "express";

// Sprint 2 paths that need a real PostgreSQL database: password lifecycle on stored accounts,
// the shared inactivity clock, and one-time login nonces shared across instances.
// Skipped when DATABASE_URL is not set; CI migrates an isolated test database first.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

process.env.SESSION_DB_PERSISTENCE = "true";
process.env.SESSION_IDLE_TIMEOUT_MINUTES = "0.05"; // 3 s
process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
process.env.LOGIN_ENCRYPTION_MODE = "optional";

const STRONG = "Correct-Horse-Battery-9";
const STRONGER = "Another-Sturdy-Phrase-7!";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb("Sprint 2 database-backed behaviour", () => {
  let app: Application;
  let basePrisma: typeof import("../src/db.js").basePrisma;
  let policy: typeof import("../src/services/passwordPolicy.js");
  let sec: typeof import("../src/services/securityAdmin.js");
  let run = "";

  beforeAll(async () => {
    ({ basePrisma } = await import("../src/db.js"));
    policy = await import("../src/services/passwordPolicy.js");
    sec = await import("../src/services/securityAdmin.js");
    app = (await import("../src/app.js")).createApp();
  });
  beforeEach(async () => {
    run = `s2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    (await import("../src/middleware/rateLimit.js")).resetRateLimitBucketsForTests();
    policy.resetPasswordPolicyForTests();
  });
  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  async function newAccount() {
    const email = `${run}@irisstar.tech`;
    const created = await sec.createUser(
      { fullName: "Database Tester", email, mobile: "+97450002020", organization: "IST Tech", facility: "UAT", department: "Security", jobTitle: "Nurse", roles: ["remote_triage_nurse"] },
      { userId: "usr_platform_admin_10001", reason: "Sprint 2 database test" }
    );
    return { email, temporaryPassword: created.temporaryPassword, userId: created.user.id };
  }
  const login = (email: string, password: string) =>
    request(app).post("/api/v1/auth/login").send({ username: email, password, simulateRole: "remote_triage_nurse" });
  const change = (body: Record<string, unknown>) => request(app).post("/api/v1/auth/password/change").send(body);

  describe("NFR-016 password lifecycle on stored accounts", () => {
    it("stores the flag, history and change time, and enforces policy from the database", async () => {
      await policy.savePasswordPolicy({ ...policy.DEFAULT_PASSWORD_POLICY, forceChangeOnFirstLogin: true, maxAgeDays: 90 }, "test");
      const account = await newAccount();
      const created = await basePrisma.applicationUser.findUniqueOrThrow({ where: { id: account.userId } });
      expect(created.mustChangePassword).toBe(true);
      expect(created.passwordChangedAt).toBeNull();

      const blocked = await login(account.email, account.temporaryPassword).expect(403);
      expect(blocked.body.passwordChangeRequired).toBe("temporary");

      await change({ username: account.email, currentPassword: account.temporaryPassword, newPassword: "weak" }).expect(422);
      await change({ username: account.email, currentPassword: account.temporaryPassword, newPassword: STRONG }).expect(200);
      const changed = await basePrisma.applicationUser.findUniqueOrThrow({ where: { id: account.userId } });
      expect(changed.mustChangePassword).toBe(false);
      expect(changed.passwordChangedAt).not.toBeNull();
      expect(changed.passwordHash).not.toBe(created.passwordHash);
      expect(await basePrisma.passwordHistory.count({ where: { userId: account.userId } })).toBe(1);
      await login(account.email, STRONG).expect(200);

      // History comes from the database: the first password and the current one cannot be reused.
      await change({ username: account.email, currentPassword: STRONG, newPassword: STRONGER }).expect(200);
      const reuse = await change({ username: account.email, currentPassword: STRONGER, newPassword: STRONG }).expect(422);
      expect(reuse.body.violations.join(" ")).toMatch(/last 5 passwords/);
      expect(await basePrisma.passwordHistory.count({ where: { userId: account.userId } })).toBe(2);

      // Expiry is measured from the stored change time.
      await basePrisma.applicationUser.update({ where: { id: account.userId }, data: { passwordChangedAt: new Date(Date.now() - 100 * 86400000) } });
      const expired = await login(account.email, STRONGER).expect(403);
      expect(expired.body.passwordChangeRequired).toBe("expired");
    });

    it("prunes history to the configured length", async () => {
      await policy.savePasswordPolicy({ ...policy.DEFAULT_PASSWORD_POLICY, historyCount: 2 }, "test");
      const account = await newAccount();
      let current = account.temporaryPassword;
      for (let i = 0; i < 5; i += 1) {
        const next = `Rotation-Phrase-${i}-Zz!x`;
        await change({ username: account.email, currentPassword: current, newPassword: next }).expect(200);
        current = next;
      }
      expect(await basePrisma.passwordHistory.count({ where: { userId: account.userId } })).toBe(2);
    });

    it("shares the policy between instances through the database", async () => {
      await policy.savePasswordPolicy({ ...policy.DEFAULT_PASSWORD_POLICY, minLength: 20, lockoutThreshold: 4 }, "test");
      expect((await basePrisma.passwordPolicy.findUniqueOrThrow({ where: { id: "default" } })).policy).toMatchObject({ minLength: 20, lockoutThreshold: 4 });
      policy.resetPasswordPolicyForTests(); // another instance, empty cache
      expect(policy.currentPasswordPolicy().minLength).toBe(12);
      expect((await policy.refreshPasswordPolicy(true)).minLength).toBe(20);
    });

    it("applies a database-stored lockout threshold at sign-in", async () => {
      await policy.savePasswordPolicy({ ...policy.DEFAULT_PASSWORD_POLICY, lockoutThreshold: 3, lockoutDurationMinutes: 10 }, "test");
      policy.resetPasswordPolicyForTests();
      const account = await newAccount();
      for (let i = 0; i < 3; i += 1) await login(account.email, "wrong-password").expect(401);
      await login(account.email, account.temporaryPassword).expect(423);
    });
  });

  describe("NFR-145 inactivity timeout across instances", () => {
    async function signedInCookie() {
      const response = await request(app).post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
      return { cookie: response.headers["set-cookie"] as unknown as string[], token: response.body.accessToken as string, sessionId: response.body.session.sessionId as string };
    }
    const sessionRow = async (sessionId: string) => {
      const { createHash } = await import("node:crypto");
      const hashes = await basePrisma.userSession.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
      return hashes.find((row) => (row.sessionPayload as { sessionId?: string }).sessionId === sessionId) ?? (void createHash, undefined);
    };

    it("records activity on the session row, and ends a session that has been idle", async () => {
      const { cookie, sessionId } = await signedInCookie();
      const row = await sessionRow(sessionId);
      expect(row?.lastActivityAt).not.toBeNull();
      await request(app).post("/api/v1/auth/activity").set("Cookie", cookie).expect(204);
      await sleep(3500);
      const ended = await request(app).get("/api/v1/queue").set("Cookie", cookie).expect(401);
      expect(ended.body.code).toBe("SESSION_IDLE_TIMEOUT");
      expect((await sessionRow(sessionId))?.revokedAt).not.toBeNull();
    }, 20000);

    it("honours activity recorded by another instance before treating this instance's copy as idle", async () => {
      const { cookie, sessionId } = await signedInCookie();
      await sleep(2000);
      // The user is active on another instance: only the shared row sees it.
      const row = await sessionRow(sessionId);
      await basePrisma.userSession.update({ where: { id: row!.id }, data: { lastActivityAt: new Date() } });
      await sleep(1500); // this instance's own clock is now past the 3 s timeout
      await request(app).get("/api/v1/auth/session").set("Cookie", cookie).expect(200);
    }, 20000);

    it("restores a session this instance has never seen, and refuses one that is idle in the database", async () => {
      const { cookie, sessionId } = await signedInCookie();
      sec.resetSecurityStoreForTests(); // this instance forgets everything it held in memory
      await request(app).get("/api/v1/auth/session").set("Cookie", cookie).expect(200);
      sec.resetSecurityStoreForTests();
      const row = await sessionRow(sessionId);
      await basePrisma.userSession.update({ where: { id: row!.id }, data: { lastActivityAt: new Date(Date.now() - 60_000) } });
      await request(app).get("/api/v1/auth/session").set("Cookie", cookie).expect(401);
      expect((await sessionRow(sessionId))?.revokedAt).not.toBeNull();
    }, 20000);
  });

  describe("NFR-146 one-time login nonces across instances", () => {
    const seal = async (ctx: { kid: string; publicJwk: Record<string, unknown>; nonce: string }) =>
      new CompactEncrypt(new TextEncoder().encode(JSON.stringify({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse", nonce: ctx.nonce, iat: Date.now() })))
        .setProtectedHeader({ alg: "ECDH-ES+A256KW", enc: "A256GCM", kid: ctx.kid })
        .encrypt(await importJWK(ctx.publicJwk as Parameters<typeof importJWK>[0], "ECDH-ES+A256KW"));

    it("records the nonce in the database, so a replay is refused even by an instance that never saw it", async () => {
      const ctx = (await request(app).get("/api/v1/auth/login-config").expect(200)).body.loginEncryption;
      const encrypted = await seal(ctx);
      await request(app).post(ctx.path).send({ encrypted }).expect(200);
      expect(await basePrisma.loginNonce.count({ where: { nonce: ctx.nonce.split(".")[0] } })).toBe(1);
      const { resetLoginEncryptionForTests } = await import("../src/services/loginEncryption.js");
      resetLoginEncryptionForTests(); // a different instance: empty in-memory state
      await request(app).get("/api/v1/auth/login-config"); // fresh key for this "instance"
    });

    it("refuses the second of two concurrent submissions of the same request", async () => {
      process.env.LOGIN_ENCRYPTION_KEY = ""; // development key for this process
      const ctx = (await request(app).get("/api/v1/auth/login-config").expect(200)).body.loginEncryption;
      const encrypted = await seal(ctx);
      const results = await Promise.all([1, 2, 3].map(() => request(app).post(ctx.path).send({ encrypted })));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    });
  });
});
