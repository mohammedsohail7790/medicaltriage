import { CompactEncrypt, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { resetSecretProvider } from "../src/config/secrets.js";
import { resetLoginEncryptionForTests, validateLoginEncryptionConfiguration } from "../src/services/loginEncryption.js";
import { listAuditEvents, resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
const FORM = { username: "layla@irisstar.tech", password: "Layla@2026", simulateRole: "remote_triage_nurse" };

type Context = { kid: string; publicJwk: JWK; nonce: string; path: string };

async function privateKeyJwk(): Promise<JWK> {
  return exportJWK((await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true })).privateKey);
}

async function seal(context: Pick<Context, "kid" | "publicJwk" | "nonce">, form: Record<string, unknown> = FORM, overrides: { iat?: number; nonce?: string } = {}) {
  const payload = JSON.stringify({ ...form, nonce: overrides.nonce ?? context.nonce, iat: overrides.iat ?? Date.now() });
  return new CompactEncrypt(new TextEncoder().encode(payload))
    .setProtectedHeader({ alg: "ECDH-ES+A256KW", enc: "A256GCM", kid: context.kid })
    .encrypt(await importJWK(context.publicJwk, "ECDH-ES+A256KW"));
}

describe("NFR-146 encrypted, replay-protected sign-in", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    resetSecurityStoreForTests();
    resetRateLimitBucketsForTests();
    resetLoginEncryptionForTests();
  });
  afterEach(() => {
    process.env = { ...originalEnv, ADMIN_PASSWORD: "TestAdminPassword!2026" };
    resetSecretProvider();
  });

  async function context(app: ReturnType<typeof createApp>): Promise<Context> {
    const response = await request(app).get("/api/v1/auth/login-config").expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    return response.body.loginEncryption as Context;
  }

  it("is off by default and leaves sign-in as it was", async () => {
    const app = createApp();
    const response = await request(app).get("/api/v1/auth/login-config").expect(200);
    expect(response.body.loginEncryption).toBeNull();
    await request(app).post("/api/v1/auth/login").send(FORM).expect(200);
  });

  describe("optional mode", () => {
    beforeEach(() => {
      process.env.LOGIN_ENCRYPTION_MODE = "optional";
    });

    it("signs in with an encrypted body, and the credentials are not readable in it", async () => {
      const app = createApp();
      const ctx = await context(app);
      const encrypted = await seal(ctx);
      expect(encrypted).not.toContain("Layla");
      expect(Buffer.from(encrypted.split(".")[3], "base64url").toString("latin1")).not.toContain("Layla@2026");
      const response = await request(app).post(ctx.path).send({ encrypted }).expect(200);
      expect(response.body.authenticated).toBe(true);
    });

    it("still accepts the plain form", async () => {
      await request(createApp()).post("/api/v1/auth/login").send(FORM).expect(200);
    });

    it("refuses a replay of the same captured request, and reuse of the same nonce", async () => {
      const app = createApp();
      const ctx = await context(app);
      const encrypted = await seal(ctx);
      await request(app).post(ctx.path).send({ encrypted }).expect(200);
      const replay = await request(app).post(ctx.path).send({ encrypted }).expect(409);
      expect(replay.body.code).toBe("LOGIN_REPLAYED");
      const reuse = await request(app).post(ctx.path).send({ encrypted: await seal(ctx, { ...FORM, password: "other" }) }).expect(409);
      expect(reuse.body.code).toBe("LOGIN_REPLAYED");
    });

    it("refuses an expired nonce, a stale timestamp, a forged nonce and tampered or foreign ciphertext", async () => {
      const app = createApp();
      process.env.LOGIN_NONCE_TTL_SECONDS = "0.02";
      const short = await context(app);
      await new Promise((resolve) => setTimeout(resolve, 60));
      await request(app).post(short.path).send({ encrypted: await seal(short) }).expect(409);

      delete process.env.LOGIN_NONCE_TTL_SECONDS;
      const ctx = await context(app);
      const stale = await request(app).post(ctx.path).send({ encrypted: await seal(ctx, FORM, { iat: Date.now() - 10 * 60 * 1000 }) }).expect(400);
      expect(stale.body.code).toBe("LOGIN_PAYLOAD_INVALID");

      const forged = await context(app);
      await request(app).post(forged.path).send({ encrypted: await seal(forged, FORM, { nonce: "AAAA.9999999999999.forged" }) }).expect(400);

      const good = await context(app);
      const sealed = await seal(good);
      const parts = sealed.split(".");
      parts[3] = Buffer.from("tampered").toString("base64url");
      await request(app).post(good.path).send({ encrypted: parts.join(".") }).expect(400);

      const foreign = await context(app);
      const otherKey = await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
      const toWrongKey = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({ ...FORM, nonce: foreign.nonce, iat: Date.now() })))
        .setProtectedHeader({ alg: "ECDH-ES+A256KW", enc: "A256GCM" })
        .encrypt(otherKey.publicKey);
      await request(app).post(foreign.path).send({ encrypted: toWrongKey }).expect(400);
      expect(listAuditEvents().some((e) => e.action === "LOGIN_PAYLOAD_REJECTED")).toBe(true);
    });

    it("applies the usual failure handling to an encrypted attempt", async () => {
      const app = createApp();
      const ctx = await context(app);
      await request(app).post(ctx.path).send({ encrypted: await seal(ctx, { ...FORM, password: "wrong" }) }).expect(401);
    });
  });

  describe("required mode and a moved sign-in address", () => {
    beforeEach(() => {
      process.env.LOGIN_ENCRYPTION_MODE = "required";
      process.env.LOGIN_PATH_SEGMENT = "k7Qm2xV9pLd4Rt8a";
    });

    it("publishes the moved address, refuses the plain form there, and does not serve the well-known address", async () => {
      const app = createApp();
      const ctx = await context(app);
      expect(ctx.path).toBe("/api/v1/auth/login-k7Qm2xV9pLd4Rt8a");
      const plain = await request(app).post(ctx.path).send(FORM).expect(400);
      expect(plain.body.code).toBe("LOGIN_ENCRYPTION_REQUIRED");
      await request(app).post("/api/v1/auth/login").send(FORM).expect(404);
      await request(app).post(ctx.path).send({ encrypted: await seal(ctx) }).expect(200);
    });

    it("keeps the well-known address in optional mode alongside the moved one", async () => {
      process.env.LOGIN_ENCRYPTION_MODE = "optional";
      const app = createApp();
      await request(app).post("/api/v1/auth/login").send(FORM).expect(200);
    });
  });

  it("accepts a request sealed to the previous key during rotation", async () => {
    const oldKey = await privateKeyJwk();
    const newKey = await privateKeyJwk();
    process.env.LOGIN_ENCRYPTION_MODE = "optional";
    process.env.LOGIN_ENCRYPTION_KEY = JSON.stringify(oldKey);
    const app = createApp();
    const before = await context(app);
    const sealedToOld = await seal(before);

    process.env.LOGIN_ENCRYPTION_KEY = JSON.stringify(newKey);
    process.env.LOGIN_ENCRYPTION_KEY_PREVIOUS = JSON.stringify(oldKey);
    const after = await context(app);
    expect(after.kid).not.toBe(before.kid);
    const oldNonceStillValid = await request(app).post(after.path).send({ encrypted: sealedToOld }).expect(200);
    expect(oldNonceStillValid.body.authenticated).toBe(true);
    await request(app).post(after.path).send({ encrypted: await seal(after) }).expect(200);
  });

  it("validates configuration at startup", async () => {
    const key = JSON.stringify(await privateKeyJwk());
    expect(() => validateLoginEncryptionConfiguration({})).not.toThrow();
    expect(() => validateLoginEncryptionConfiguration({ LOGIN_ENCRYPTION_MODE: "sometimes" })).toThrow(/off, optional or required/);
    expect(() => validateLoginEncryptionConfiguration({ LOGIN_PATH_SEGMENT: "short" })).toThrow(/8 to 64/);
    expect(() => validateLoginEncryptionConfiguration({ LOGIN_ENCRYPTION_MODE: "required", NODE_ENV: "production" })).toThrow(/LOGIN_ENCRYPTION_KEY is required/);
    expect(() => validateLoginEncryptionConfiguration({ LOGIN_ENCRYPTION_MODE: "required", NODE_ENV: "production", LOGIN_ENCRYPTION_KEY: key })).not.toThrow();
    expect(() => validateLoginEncryptionConfiguration({ LOGIN_ENCRYPTION_MODE: "optional", LOGIN_ENCRYPTION_KEY: '{"kty":"oct"}' })).toThrow(/EC P-256/);
  });
});
