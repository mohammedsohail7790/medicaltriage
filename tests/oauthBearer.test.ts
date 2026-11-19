import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { parseOAuthApiConfig, resetOAuthBearerForTests } from "../src/services/oauthBearer.js";
import { listAuditEvents, resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
const app = createApp();
const AUDIENCE = "aimltriage-api";

describe("AI-001 / NFR-028 OAuth bearer tokens for approved API clients", () => {
  const originalEnv = { ...process.env };
  let server: Server;
  let issuer = "";
  let privateKey: CryptoKey;
  let otherPrivateKey: CryptoKey;
  let jwk: JWK;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: "idp-key-1", use: "sig", alg: "RS256" };
    otherPrivateKey = (await generateKeyPair("RS256")).privateKey;
    server = createServer((req, res) => {
      if (req.url === "/.well-known/jwks.json") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
      } else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    resetSecurityStoreForTests();
    resetRateLimitBucketsForTests();
    process.env.OAUTH_API_ISSUER = issuer;
    process.env.OAUTH_API_AUDIENCE = AUDIENCE;
    process.env.OAUTH_API_CLIENTS = JSON.stringify([
      { clientId: "qr-reporting", role: "remote_triage_nurse" },
      { clientId: "qr-restricted", role: "remote_triage_nurse", allowedIps: ["198.51.100.0/24"] }
    ]);
    resetOAuthBearerForTests();
  });
  afterEach(() => {
    process.env = { ...originalEnv, ADMIN_PASSWORD: "TestAdminPassword!2026" };
    resetOAuthBearerForTests();
  });

  async function token(claims: Record<string, unknown> = {}, options: { key?: CryptoKey; alg?: string; exp?: string | number; iss?: string; aud?: string } = {}) {
    return new SignJWT({ client_id: "qr-reporting", scope: "api.read", ...claims })
      .setProtectedHeader({ alg: options.alg ?? "RS256", kid: "idp-key-1" })
      .setIssuer(options.iss ?? issuer)
      .setAudience(options.aud ?? AUDIENCE)
      .setSubject("service-account")
      .setIssuedAt()
      .setExpirationTime(options.exp ?? "5m")
      .sign(options.key ?? privateKey);
  }
  const call = (bearer: string) => request(app).get("/api/v1/queue").set("Authorization", `Bearer ${bearer}`);

  it("accepts a valid token from an approved client and applies that client's role permissions", async () => {
    await call(await token()).expect(200);
    expect(listAuditEvents().some((e) => e.action === "OAUTH_CLIENT_AUTHENTICATED" && e.userId === "oauth:qr-reporting")).toBe(true);
  });

  it("refuses an admin-only API to a client whose role does not allow it (role-based access)", async () => {
    const response = await request(app).get("/api/v1/admin/users").set("Authorization", `Bearer ${await token()}`);
    expect([401, 403]).toContain(response.status);
    expect(response.status).not.toBe(200);
  });

  it.each([
    ["a signature from a different key", () => token({}, { key: otherPrivateKey })],
    ["an expired token", () => token({}, { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ["the wrong audience", () => token({}, { aud: "some-other-api" })],
    ["the wrong issuer", () => token({}, { iss: "https://evil.example" })]
  ])("rejects %s with 401 and a Bearer challenge", async (_name, make) => {
    const response = await call(await make()).expect(401);
    expect(response.headers["www-authenticate"]).toMatch(/invalid_token/);
    expect(response.body.code).toBe("INVALID_TOKEN");
  });

  it("rejects a client that is not on the approved list", async () => {
    const response = await call(await token({ client_id: "unknown-app" })).expect(403);
    expect(response.body.code).toBe("CLIENT_NOT_APPROVED");
    expect(listAuditEvents().some((e) => e.action === "OAUTH_CLIENT_REJECTED" && e.userId === "oauth:unknown-app")).toBe(true);
  });

  it("restricts a client to its approved network", async () => {
    const response = await call(await token({ client_id: "qr-restricted" })).expect(403);
    expect(response.body.code).toBe("NETWORK_NOT_PERMITTED");
  });

  it("requires the configured scope", async () => {
    process.env.OAUTH_API_REQUIRED_SCOPE = "triage.api";
    resetOAuthBearerForTests();
    await call(await token({ scope: "api.read" })).expect(403);
    await call(await token({ scope: "api.read triage.api" })).expect(200);
  });

  it("ignores the algorithm confusion trick: an HS256 token is never checked against the provider's keys", async () => {
    const forged = await new SignJWT({ client_id: "qr-reporting", sid: "x" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("public-key-material"));
    await call(forged).expect(401);
  });

  it("does not interfere with the application's own session tokens", async () => {
    const agent = request.agent(app);
    const login = await agent.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
    await request(app).get("/api/v1/queue").set("Authorization", `Bearer ${login.body.accessToken}`).expect(200);
  });

  it("is off unless issuer and audience are both configured", async () => {
    delete process.env.OAUTH_API_ISSUER;
    resetOAuthBearerForTests();
    await call(await token()).expect(401);
  });

  describe("configuration", () => {
    it("rejects malformed client lists, unknown roles and privileged roles", () => {
      const base = { OAUTH_API_ISSUER: "https://idp.example", OAUTH_API_AUDIENCE: "a" };
      expect(parseOAuthApiConfig({})).toBeUndefined();
      expect(() => parseOAuthApiConfig({ ...base, OAUTH_API_CLIENTS: "nope" })).toThrow(/valid JSON/);
      expect(() => parseOAuthApiConfig({ ...base, OAUTH_API_CLIENTS: "{}" })).toThrow(/array/);
      expect(() => parseOAuthApiConfig({ ...base, OAUTH_API_CLIENTS: '[{"clientId":"a"}]' })).toThrow(/clientId and role/);
      expect(() => parseOAuthApiConfig({ ...base, OAUTH_API_CLIENTS: '[{"clientId":"a","role":"no_such_role"}]' })).toThrow(/unknown role/);
      expect(() => parseOAuthApiConfig({ ...base, OAUTH_API_CLIENTS: '[{"clientId":"a","role":"platform_super_administrator"}]' })).toThrow(/privileged/);
      expect(() => parseOAuthApiConfig({ ...base, OAUTH_API_CLIENTS: '[{"clientId":"a","role":"remote_triage_nurse"},{"clientId":"a","role":"remote_triage_nurse"}]' })).toThrow(/twice/);
      expect(parseOAuthApiConfig({ ...base, OAUTH_API_CLIENTS: '[{"clientId":"a","role":"remote_triage_nurse"}]' })?.jwksUri).toBe("https://idp.example/.well-known/jwks.json");
    });
  });
});
