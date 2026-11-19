import { createHmac } from "node:crypto";
import { assertRuntimeConfiguration } from "../src/config/runtime.js";
import {
  SecretConfigurationError,
  missingProductionSecrets,
  requireSecret,
  resetSecretProvider,
  secretVersions,
  setSecretProvider
} from "../src/config/secrets.js";
import { sessionFromTokenString } from "../src/middleware/auth.js";
import { decryptMfaSecret, encryptMfaSecret } from "../src/services/mfaCrypto.js";

describe("M-039 secret handling", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSecretProvider();
  });

  it("fails closed in production when a secret is missing and names only the variable", () => {
    process.env.NODE_ENV = "production";
    delete process.env.AUTH_JWT_SECRET;
    expect(() => requireSecret("AUTH_JWT_SECRET")).toThrow(SecretConfigurationError);
    expect(() => requireSecret("AUTH_JWT_SECRET")).toThrow(/AUTH_JWT_SECRET is required/);
  });

  it("rejects placeholder values in production", () => {
    process.env.NODE_ENV = "production";
    process.env.AUTH_JWT_SECRET = "mock-dev-only-ist-triage-jwt-secret";
    expect(() => requireSecret("AUTH_JWT_SECRET")).toThrow(/placeholder/);
  });

  it("never falls back to a known constant outside production", () => {
    process.env.NODE_ENV = "test";
    delete process.env.AUTH_JWT_SECRET;
    const first = requireSecret("AUTH_JWT_SECRET");
    expect(first).not.toMatch(/mock-dev-only/);
    expect(first).toHaveLength(64);
    expect(requireSecret("AUTH_JWT_SECRET")).toBe(first);
  });

  it("reports missing production secrets before the service starts", () => {
    process.env.NODE_ENV = "production";
    delete process.env.AUTH_JWT_SECRET;
    delete process.env.MFA_ENCRYPTION_KEY;
    expect(missingProductionSecrets()).toEqual(["AUTH_JWT_SECRET", "MFA_ENCRYPTION_KEY"]);
    expect(() => assertRuntimeConfiguration()).toThrow(/AUTH_JWT_SECRET/);
  });

  it("reads from an installed provider such as a vault adapter", () => {
    setSecretProvider({ get: (name) => (name === "MFA_ENCRYPTION_KEY" ? "vault-supplied-key-0123456789" : undefined) });
    expect(requireSecret("MFA_ENCRYPTION_KEY")).toBe("vault-supplied-key-0123456789");
  });

  it("lists previous secrets after the current one for rotation", () => {
    process.env.MFA_ENCRYPTION_KEY = "current-key";
    process.env.MFA_ENCRYPTION_KEY_PREVIOUS = "older-key, oldest-key, current-key";
    expect(secretVersions("MFA_ENCRYPTION_KEY")).toEqual(["current-key", "older-key", "oldest-key"]);
  });

  it("still decrypts MFA secrets written under the previous key after rotation", () => {
    process.env.MFA_ENCRYPTION_KEY = "key-before-rotation";
    const stored = encryptMfaSecret("TOTPSECRET123");
    process.env.MFA_ENCRYPTION_KEY = "key-after-rotation";
    expect(() => decryptMfaSecret(stored)).toThrow();
    process.env.MFA_ENCRYPTION_KEY_PREVIOUS = "key-before-rotation";
    expect(decryptMfaSecret(stored)).toBe("TOTPSECRET123");
    expect(decryptMfaSecret(encryptMfaSecret("NEW"))).toBe("NEW");
  });

  it("does not accept a token signed with the old built-in constant", async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET = "a-real-secret-for-this-test-run";
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = part({ alg: "HS256", typ: "JWT" });
    const payload = part({ sub: "u", sid: "s", exp: Math.floor(Date.now() / 1000) + 600 });
    const forged = `${header}.${payload}.${createHmac("sha256", "mock-dev-only-ist-triage-jwt-secret").update(`${header}.${payload}`).digest("base64url")}`;
    await expect(sessionFromTokenString(forged)).resolves.toBeUndefined();
  });
});
