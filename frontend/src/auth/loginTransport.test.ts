/**
 * @jest-environment node
 */
import { compactDecrypt, exportJWK, generateKeyPair, importJWK } from "jose";
import { buildLoginRequest } from "./loginTransport";

describe("sign-in transport (NFR-146)", () => {
  it("sends the plain form when the server publishes no key", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ loginEncryption: null }) }));
    const request = await buildLoginRequest("", { username: "a@b.c", password: "pw" });
    expect(request.url).toBe("/api/v1/auth/login");
    expect(JSON.parse(request.body)).toEqual({ username: "a@b.c", password: "pw" });
  });

  it("falls back to the plain form if the key cannot be fetched", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => {
      throw new Error("offline");
    });
    expect((await buildLoginRequest("", { username: "u" })).url).toBe("/api/v1/auth/login");
  });

  it("encrypts the form with the published key, adds nonce and time, and uses the published address", async () => {
    const pair = await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
    const publicJwk = { ...(await exportJWK(pair.publicKey)), alg: "ECDH-ES+A256KW", use: "enc", kid: "k1" };
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ loginEncryption: { kid: "k1", publicJwk, nonce: "nonce-123", path: "/api/v1/auth/login-abcdef12" } })
    }));
    const before = Date.now();
    const request = await buildLoginRequest("https://api.example", { username: "layla@irisstar.tech", password: "Secret-Password-1" });
    expect(request.url).toBe("https://api.example/api/v1/auth/login-abcdef12");
    expect(request.body).not.toContain("Secret-Password-1");
    expect(request.body).not.toContain("layla");

    const { encrypted } = JSON.parse(request.body);
    const { plaintext } = await compactDecrypt(encrypted, pair.privateKey);
    const opened = JSON.parse(new TextDecoder().decode(plaintext));
    expect(opened).toMatchObject({ username: "layla@irisstar.tech", password: "Secret-Password-1", nonce: "nonce-123" });
    expect(opened.iat).toBeGreaterThanOrEqual(before);
    void importJWK;
  });
});
