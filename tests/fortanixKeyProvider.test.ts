import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { decryptText, encryptText } from "../src/services/fieldEncryption.js";
import {
  FORTANIX_AAD,
  FortanixConfigurationError,
  FortanixKeyProvider,
  FortanixOperationError,
  fortanixKeyId,
  validateFortanixEndpoint,
  type FortanixPost
} from "../src/services/fortanixKeyProvider.js";
import { providerFromEnv, resetKeyProvider, setKeyProvider } from "../src/services/keyProvider.js";
import { missingProductionSecrets } from "../src/config/secrets.js";

// M-019, M-020, AI-012: the Fortanix vault provider, tested against a stand-in vault that follows Fortanix's public
// documentation (app sign-in with a Basic API key, bearer token, /crypto/v1/encrypt and /crypto/v1/decrypt with AES-GCM).
// Not run against a real tenant.

const KID_A = randomUUID();
const KID_B = randomUUID();
const API_KEY = Buffer.from("app-id:app-secret").toString("base64");

function fakeVault() {
  const keys = new Map<string, Buffer>();
  const calls: Array<{ path: string; auth: string; body: Record<string, unknown> }> = [];
  const state = { token: "token-1", issued: 0, expireNext: false, refuseCrypto: 0, authStatus: 200, expiresIn: 600 };
  const keyFor = (kid: string) => {
    if (!keys.has(kid)) keys.set(kid, randomBytes(32));
    return keys.get(kid) as Buffer;
  };
  const post: FortanixPost = async (path, body, headers) => {
    const b = body as Record<string, any>;
    calls.push({ path, auth: headers.authorization ?? "", body: b });
    if (path === "/sys/v1/session/auth") {
      if (state.authStatus !== 200) return { status: state.authStatus, json: {} };
      if (headers.authorization !== `Basic ${API_KEY}`) return { status: 401, json: {} };
      state.issued += 1;
      state.token = `token-${state.issued}`;
      return { status: 200, json: { token_type: "Bearer", expires_in: state.expiresIn, access_token: state.token, entity_id: randomUUID() } };
    }
    if (headers.authorization !== `Bearer ${state.token}` || state.expireNext) {
      state.expireNext = false;
      return { status: 401, json: {} };
    }
    if (state.refuseCrypto > 0) {
      state.refuseCrypto -= 1;
      return { status: 403, json: { message: "no" } };
    }
    const kid = b.key.kid ?? `name:${b.key.name}`;
    if (b.alg !== "AES" || b.mode !== "GCM" || b.tag_len !== 128) return { status: 400, json: {} };
    if (path === "/crypto/v1/encrypt") {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keyFor(kid), iv);
      cipher.setAAD(Buffer.from(b.ad, "base64"));
      const body2 = Buffer.concat([cipher.update(Buffer.from(b.plain, "base64")), cipher.final()]);
      return { status: 200, json: { cipher: body2.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") } };
    }
    if (path === "/crypto/v1/decrypt") {
      try {
        const decipher = createDecipheriv("aes-256-gcm", keyFor(kid), Buffer.from(b.iv, "base64"));
        decipher.setAuthTag(Buffer.from(b.tag, "base64"));
        decipher.setAAD(Buffer.from(b.ad, "base64"));
        return { status: 200, json: { plain: Buffer.concat([decipher.update(Buffer.from(b.cipher, "base64")), decipher.final()]).toString("base64") } };
      } catch {
        return { status: 400, json: {} };
      }
    }
    return { status: 404, json: {} };
  };
  return { post, calls, state };
}

const make = (vault = fakeVault(), extra: Record<string, unknown> = {}) => ({
  vault,
  provider: new FortanixKeyProvider({ endpoint: "https://dsm.qr.example", key: { kid: KID_A }, post: vault.post, apiKey: () => API_KEY, ...extra }, { NODE_ENV: "production" })
});

describe("Fortanix key provider", () => {
  it("wraps and unwraps a data key through the vault, and the key itself never reaches the application", async () => {
    const { provider, vault } = make();
    const dataKey = randomBytes(32);
    const { keyId, wrapped } = await provider.wrapKey(dataKey);
    expect(keyId).toBe(fortanixKeyId(KID_A));
    expect(keyId).not.toContain(":");
    expect(wrapped).not.toContain(dataKey.toString("base64"));
    expect((await provider.unwrapKey(keyId, wrapped)).equals(dataKey)).toBe(true);
    const encrypt = vault.calls.find((c) => c.path === "/crypto/v1/encrypt")!;
    expect(encrypt.body).toMatchObject({ key: { kid: KID_A }, alg: "AES", mode: "GCM", tag_len: 128 });
    expect(Buffer.from(encrypt.body.ad as string, "base64").toString()).toBe(FORTANIX_AAD);
  });

  it("signs in with the Basic API key, then uses the bearer token, and reuses the token", async () => {
    const { provider, vault } = make();
    await provider.wrapKey(randomBytes(32));
    await provider.wrapKey(randomBytes(32));
    const auth = vault.calls.filter((c) => c.path === "/sys/v1/session/auth");
    expect(auth).toHaveLength(1);
    expect(auth[0].auth).toBe(`Basic ${API_KEY}`);
    expect(vault.calls.filter((c) => c.path === "/crypto/v1/encrypt").every((c) => c.auth === "Bearer token-1")).toBe(true);
  });

  it("refreshes the token at half its lifetime", async () => {
    let now = 1_000_000;
    const { provider, vault } = make(fakeVault(), { now: () => now });
    await provider.wrapKey(randomBytes(32));
    now += 200_000;
    await provider.wrapKey(randomBytes(32));
    expect(vault.calls.filter((c) => c.path === "/sys/v1/session/auth")).toHaveLength(1);
    now += 150_000;
    await provider.wrapKey(randomBytes(32));
    expect(vault.calls.filter((c) => c.path === "/sys/v1/session/auth")).toHaveLength(2);
  });

  it("signs in again once when the vault says the token has expired, and does not loop", async () => {
    const { provider, vault } = make();
    await provider.wrapKey(randomBytes(32));
    vault.state.expireNext = true;
    await expect(provider.wrapKey(randomBytes(32))).resolves.toBeDefined();
    expect(vault.calls.filter((c) => c.path === "/sys/v1/session/auth")).toHaveLength(2);
    const failing = make();
    failing.vault.state.authStatus = 401;
    await expect(failing.provider.wrapKey(randomBytes(32))).rejects.toBeInstanceOf(FortanixOperationError);
  });

  it("fails, never falling back to a local key, when the vault refuses or is down", async () => {
    const { provider, vault } = make();
    const wrapped = await provider.wrapKey(randomBytes(32));
    vault.state.refuseCrypto = 1;
    await expect(provider.unwrapKey(wrapped.keyId, wrapped.wrapped)).rejects.toThrow(/refused/);
    const down = new FortanixKeyProvider({ endpoint: "https://dsm.qr.example", key: { kid: KID_A }, apiKey: () => API_KEY, post: async () => { throw new Error("connection reset"); } }, { NODE_ENV: "production" });
    await expect(down.wrapKey(randomBytes(32))).rejects.toMatchObject({ name: "FortanixOperationError", causeMessage: "connection reset" });
  });

  it("refuses a wrapped key that was altered, or wrapped under additional data it does not match", async () => {
    const { provider } = make();
    const { keyId, wrapped } = await provider.wrapKey(randomBytes(32));
    const parts = JSON.parse(Buffer.from(wrapped, "base64url").toString());
    parts.c = Buffer.from(randomBytes(32)).toString("base64");
    await expect(provider.unwrapKey(keyId, Buffer.from(JSON.stringify(parts)).toString("base64url"))).rejects.toBeInstanceOf(FortanixOperationError);
    await expect(provider.unwrapKey(keyId, Buffer.from("not json").toString("base64url"))).rejects.toBeInstanceOf(FortanixOperationError);
    await expect(provider.unwrapKey("fortanix-unknown", wrapped)).rejects.toThrow(/No Fortanix key is configured/);
  });

  it("still opens data wrapped under an older key after a key change", async () => {
    const vault = fakeVault();
    const old = make(vault).provider;
    const dataKey = randomBytes(32);
    const wrapped = await old.wrapKey(dataKey);
    const next = new FortanixKeyProvider({ endpoint: "https://dsm.qr.example", key: { kid: KID_B }, previousKeyIds: [KID_A], post: vault.post, apiKey: () => API_KEY }, { NODE_ENV: "production" });
    expect(next.activeKeyId()).not.toBe(wrapped.keyId);
    expect((await next.unwrapKey(wrapped.keyId, wrapped.wrapped)).equals(dataKey)).toBe(true);
    expect((await next.wrapKey(dataKey)).keyId).toBe(fortanixKeyId(KID_B));
  });

  it("can reference the key by name", async () => {
    const vault = fakeVault();
    const provider = new FortanixKeyProvider({ endpoint: "https://dsm.qr.example", key: { name: "aimltriage-field-kek" }, post: vault.post, apiKey: () => API_KEY }, { NODE_ENV: "production" });
    const { keyId, wrapped } = await provider.wrapKey(randomBytes(32));
    expect(vault.calls.find((c) => c.path === "/crypto/v1/encrypt")!.body.key).toEqual({ name: "aimltriage-field-kek" });
    await expect(provider.unwrapKey(keyId, wrapped)).resolves.toHaveLength(32);
  });

  it("encrypts and decrypts real field values through the vault", async () => {
    const { provider } = make();
    setKeyProvider(provider);
    try {
      const sealed = await encryptText("Patient reports chest pain", "TriageQueueItem.reasonNarrative");
      expect(sealed).not.toContain("chest pain");
      expect(await decryptText(sealed, "TriageQueueItem.reasonNarrative")).toBe("Patient reports chest pain");
    } finally {
      resetKeyProvider();
    }
  });
});

describe("Fortanix configuration", () => {
  it("accepts only https addresses (plain http only for localhost outside production), with no credentials or query", () => {
    expect(validateFortanixEndpoint("https://dsm.qr.example/", {})).toBe("https://dsm.qr.example");
    expect(() => validateFortanixEndpoint("http://dsm.qr.example", {})).toThrow(/https/);
    expect(() => validateFortanixEndpoint("http://localhost:9000", { NODE_ENV: "production" })).toThrow(/https/);
    expect(validateFortanixEndpoint("http://localhost:9000", {})).toBe("http://localhost:9000");
    expect(() => validateFortanixEndpoint("https://u:p@dsm.qr.example", {})).toThrow(FortanixConfigurationError);
    expect(() => validateFortanixEndpoint("https://dsm.qr.example/?x=1", {})).toThrow(FortanixConfigurationError);
    expect(() => validateFortanixEndpoint("nope", {})).toThrow(/valid URL/);
  });

  it("needs an address and a key, and the key must be a UUID", () => {
    expect(() => FortanixKeyProvider.fromEnv({ FIELD_ENCRYPTION_PROVIDER: "fortanix" })).toThrow(/FORTANIX_ENDPOINT/);
    expect(() => FortanixKeyProvider.fromEnv({ FORTANIX_ENDPOINT: "https://dsm.qr.example" })).toThrow(/FORTANIX_KEY_ID/);
    expect(() => FortanixKeyProvider.fromEnv({ FORTANIX_ENDPOINT: "https://dsm.qr.example", FORTANIX_KEY_ID: "not-a-uuid" })).toThrow(/UUID/);
    expect(() => FortanixKeyProvider.fromEnv({ FORTANIX_ENDPOINT: "https://dsm.qr.example", FORTANIX_KEY_ID: KID_A, FORTANIX_KEY_ID_PREVIOUS: "x" })).toThrow(/UUID/);
    expect(FortanixKeyProvider.fromEnv({ FORTANIX_ENDPOINT: "https://dsm.qr.example", FORTANIX_KEY_ID: KID_A, FORTANIX_KEY_ID_PREVIOUS: `${KID_B}` }).activeKeyId()).toBe(fortanixKeyId(KID_A));
  });

  it("is chosen by FIELD_ENCRYPTION_PROVIDER=fortanix, and a typo is still an error", () => {
    const env = { FIELD_ENCRYPTION_PROVIDER: "fortanix", FORTANIX_ENDPOINT: "https://dsm.qr.example", FORTANIX_KEY_ID: KID_A } as NodeJS.ProcessEnv;
    expect(providerFromEnv(env)).toBeInstanceOf(FortanixKeyProvider);
    expect(() => providerFromEnv({ FIELD_ENCRYPTION_PROVIDER: "fortanx" } as NodeJS.ProcessEnv)).toThrow(/fortanix/);
  });

  it("reports what production still needs, and no longer asks for a local field key", () => {
    const keep = { ...process.env };
    try {
      process.env.FIELD_ENCRYPTION_PROVIDER = "fortanix";
      delete process.env.FORTANIX_ENDPOINT;
      delete process.env.FORTANIX_KEY_ID;
      delete process.env.FORTANIX_KEY_NAME;
      delete process.env.FORTANIX_API_KEY;
      const missing = missingProductionSecrets();
      expect(missing).toEqual(expect.arrayContaining(["FORTANIX_ENDPOINT", "FORTANIX_KEY_ID", "FORTANIX_API_KEY"]));
      expect(missing).not.toContain("FIELD_ENCRYPTION_KEY");
    } finally {
      process.env = keep;
    }
  });
});
