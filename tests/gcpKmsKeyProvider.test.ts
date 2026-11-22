import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { decryptText, encryptText } from "../src/services/fieldEncryption.js";
import {
  FIELD_KEY_AAD,
  GcpKmsConfigurationError,
  GcpKmsKeyProvider,
  GcpKmsOperationError,
  kmsKeyId,
  type KmsClientLike
} from "../src/services/gcpKmsKeyProvider.js";
import { LocalKeyProvider, providerFromEnv, resetKeyProvider, setKeyProvider } from "../src/services/keyProvider.js";

const KEY_A = "projects/qr-tenant/locations/me-central1/keyRings/aimltriage/cryptoKeys/field-wrap";
const KEY_B = "projects/qr-tenant/locations/me-central1/keyRings/aimltriage/cryptoKeys/field-wrap-2";

/** A stand-in for Cloud KMS: one AES-256-GCM key per crypto key name, additional authenticated data enforced. */
function fakeKms() {
  const keys = new Map<string, Buffer>();
  const calls: Array<{ op: string; name: string; aad?: string }> = [];
  const keyFor = (name: string) => {
    if (!keys.has(name)) keys.set(name, randomBytes(32));
    return keys.get(name) as Buffer;
  };
  const client: KmsClientLike & { failNext?: Error } = {
    async encrypt({ name, plaintext, additionalAuthenticatedData }) {
      if (client.failNext) { const e = client.failNext; client.failNext = undefined; throw e; }
      calls.push({ op: "encrypt", name, aad: additionalAuthenticatedData?.toString() });
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keyFor(name), iv);
      if (additionalAuthenticatedData) cipher.setAAD(additionalAuthenticatedData);
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return [{ ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]) }];
    },
    async decrypt({ name, ciphertext, additionalAuthenticatedData }) {
      if (client.failNext) { const e = client.failNext; client.failNext = undefined; throw e; }
      calls.push({ op: "decrypt", name, aad: additionalAuthenticatedData?.toString() });
      const decipher = createDecipheriv("aes-256-gcm", keyFor(name), ciphertext.subarray(0, 12));
      decipher.setAuthTag(ciphertext.subarray(12, 28));
      if (additionalAuthenticatedData) decipher.setAAD(additionalAuthenticatedData);
      return [{ plaintext: Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]) }];
    }
  };
  return { client, calls };
}

describe("Google Cloud KMS key provider (M-019, M-020, AI-012)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetKeyProvider();
  });

  it("wraps data keys in KMS so the application holds no key-encryption material", async () => {
    const { client, calls } = fakeKms();
    delete process.env.FIELD_ENCRYPTION_KEY;
    setKeyProvider(new GcpKmsKeyProvider({ keyName: KEY_A, client }));
    const stored = await encryptText("patient narrative", "TriageQueueItem.summary");
    expect(stored.split(":")[2]).toBe(kmsKeyId(KEY_A));
    expect(stored).not.toContain("patient narrative");
    expect(await decryptText(stored, "TriageQueueItem.summary")).toBe("patient narrative");
    expect(calls.map((c) => c.op)).toEqual(["encrypt", "decrypt"]);
    expect(calls.every((c) => c.name === KEY_A && c.aad === FIELD_KEY_AAD)).toBe(true);
  });

  it("unwraps data written under a previous key after a move to a new key", async () => {
    const { client } = fakeKms();
    const before = new GcpKmsKeyProvider({ keyName: KEY_A, client });
    const wrapped = await before.wrapKey(Buffer.alloc(32, 7));
    const after = new GcpKmsKeyProvider({ keyName: KEY_B, previousKeyNames: [KEY_A], client });
    expect(after.activeKeyId()).toBe(kmsKeyId(KEY_B));
    expect((await after.unwrapKey(wrapped.keyId, wrapped.wrapped)).equals(Buffer.alloc(32, 7))).toBe(true);
    const withoutPrevious = new GcpKmsKeyProvider({ keyName: KEY_B, client });
    await expect(withoutPrevious.unwrapKey(wrapped.keyId, wrapped.wrapped)).rejects.toThrow(GcpKmsOperationError);
  });

  it("fails when KMS refuses and never falls back to a local key", async () => {
    const { client } = fakeKms();
    process.env.FIELD_ENCRYPTION_KEY = "a-local-key-that-must-not-be-used-here";
    setKeyProvider(new GcpKmsKeyProvider({ keyName: KEY_A, client }));
    (client as { failNext?: Error }).failNext = new Error("PERMISSION_DENIED: caller lacks cloudkms.cryptoKeyVersions.useToEncrypt");
    await expect(encryptText("secret", "X.y")).rejects.toThrow(/Cloud KMS could not wrap/);
    const stored = await encryptText("secret", "X.y");
    (client as { failNext?: Error }).failNext = new Error("UNAVAILABLE");
    // fieldEncryption deliberately hides the cause when a value cannot be decrypted.
    await expect(decryptText(stored, "X.y")).rejects.toThrow(/Could not decrypt X\.y/);
  });

  it("treats a wrapped key as bound to its purpose: a different AAD cannot unwrap it", async () => {
    const { client } = fakeKms();
    const provider = new GcpKmsKeyProvider({ keyName: KEY_A, client });
    const wrapped = await provider.wrapKey(Buffer.alloc(32, 1));
    await expect(client.decrypt({ name: KEY_A, ciphertext: Buffer.from(wrapped.wrapped, "base64url"), additionalAuthenticatedData: Buffer.from("other") })).rejects.toThrow();
  });

  it("accepts base64 text from the client as well as bytes", async () => {
    const { client } = fakeKms();
    const asText: KmsClientLike = {
      async encrypt(req) { const [r] = await client.encrypt(req); return [{ ciphertext: Buffer.from(r.ciphertext as Buffer).toString("base64") }]; },
      async decrypt(req) { const [r] = await client.decrypt(req); return [{ plaintext: Buffer.from(r.plaintext as Buffer).toString("base64") }]; }
    };
    const provider = new GcpKmsKeyProvider({ keyName: KEY_A, client: asText });
    const wrapped = await provider.wrapKey(Buffer.alloc(32, 9));
    expect((await provider.unwrapKey(wrapped.keyId, wrapped.wrapped)).equals(Buffer.alloc(32, 9))).toBe(true);
  });

  describe("configuration", () => {
    it("rejects a key version, because rotation happens inside the crypto key", () => {
      expect(() => new GcpKmsKeyProvider({ keyName: `${KEY_A}/cryptoKeyVersions/1` })).toThrow(GcpKmsConfigurationError);
    });

    it("rejects a key outside the approved data regions", () => {
      process.env.APPROVED_DATA_REGIONS = "me-central1";
      expect(() => new GcpKmsKeyProvider({ keyName: KEY_A.replace("me-central1", "asia-south1") })).toThrow(/not an approved data region/);
      expect(() => new GcpKmsKeyProvider({ keyName: KEY_A })).not.toThrow();
    });

    it("keeps the local provider as the default", () => {
      delete process.env.FIELD_ENCRYPTION_PROVIDER;
      expect(providerFromEnv()).toBeInstanceOf(LocalKeyProvider);
    });

    it("builds the KMS provider from the environment, including previous keys", () => {
      const env = { FIELD_ENCRYPTION_PROVIDER: "gcp-kms", FIELD_ENCRYPTION_KMS_KEY: KEY_B, FIELD_ENCRYPTION_KMS_KEY_PREVIOUS: ` ${KEY_A} ` };
      const provider = providerFromEnv(env);
      expect(provider).toBeInstanceOf(GcpKmsKeyProvider);
      expect(provider.activeKeyId()).toBe(kmsKeyId(KEY_B));
    });

    it("requires the key name and refuses an unknown provider name instead of using local keys", () => {
      expect(() => providerFromEnv({ FIELD_ENCRYPTION_PROVIDER: "gcp-kms" })).toThrow(/FIELD_ENCRYPTION_KMS_KEY is required/);
      expect(() => providerFromEnv({ FIELD_ENCRYPTION_PROVIDER: "gcp-kmz" })).toThrow(/not supported/);
    });
  });
});
