import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { requireSecret, secretVersions } from "../config/secrets.js";
import { GcpKmsKeyProvider } from "./gcpKmsKeyProvider.js";

/**
 * Key management for field-level encryption (M-019, M-020).
 *
 * Data is encrypted with a fresh random data key per value. The data key is then
 * wrapped by a key-encryption key (KEK) held by a KeyProvider. The provider is the
 * only place that touches KEK material, so moving to the Qatar Airways vault or a
 * cloud KMS means installing a different provider; nothing else changes.
 *
 * The default provider derives KEKs from FIELD_ENCRYPTION_KEY (a secret injected from
 * Secret Manager) and supports rotation through FIELD_ENCRYPTION_KEY_PREVIOUS.
 */

export interface KeyProvider {
  /** Identifier of the key used for new wraps. Must not contain ":". */
  activeKeyId(): Promise<string> | string;
  /** Wraps a 32-byte data key. Returns an opaque base64url string. */
  wrapKey(dataKey: Buffer): Promise<{ keyId: string; wrapped: string }>;
  /** Unwraps a data key that was wrapped under keyId. */
  unwrapKey(keyId: string, wrapped: string): Promise<Buffer>;
}

const SECRET_NAME = "FIELD_ENCRYPTION_KEY";
const kekCache = new Map<string, Buffer>();

function kekFor(secret: string): Buffer {
  let kek = kekCache.get(secret);
  if (!kek) {
    kek = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("ist-triage-field-kek-v1"), Buffer.from("field-encryption"), 32));
    kekCache.set(secret, kek);
  }
  return kek;
}

function keyIdFor(secret: string): string {
  return `local-${createHash("sha256").update(secret).digest("hex").slice(0, 12)}`;
}

export class LocalKeyProvider implements KeyProvider {
  activeKeyId(): string {
    return keyIdFor(requireSecret(SECRET_NAME));
  }

  async wrapKey(dataKey: Buffer): Promise<{ keyId: string; wrapped: string }> {
    const secret = requireSecret(SECRET_NAME);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", kekFor(secret), iv);
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return { keyId: keyIdFor(secret), wrapped: Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url") };
  }

  async unwrapKey(keyId: string, wrapped: string): Promise<Buffer> {
    const secret = secretVersions(SECRET_NAME).find((candidate) => keyIdFor(candidate) === keyId);
    if (!secret) throw new Error(`No field-encryption key is configured for key id ${keyId}.`);
    const raw = Buffer.from(wrapped, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", kekFor(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  }
}

let provider: KeyProvider | undefined;

/**
 * Chooses the provider from FIELD_ENCRYPTION_PROVIDER: "local" (the default, keys from Secret Manager) or
 * "gcp-kms" (Google Cloud KMS). An unknown value is an error, so a typo cannot silently fall back to local keys.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): KeyProvider {
  const kind = (env.FIELD_ENCRYPTION_PROVIDER ?? "local").trim().toLowerCase();
  if (kind === "local" || kind === "") return new LocalKeyProvider();
  if (kind === "gcp-kms") return GcpKmsKeyProvider.fromEnv(env);
  throw new Error(`FIELD_ENCRYPTION_PROVIDER "${kind}" is not supported. Use "local" or "gcp-kms".`);
}

export function getKeyProvider(): KeyProvider {
  provider ??= providerFromEnv();
  return provider;
}

/** Installs a provider such as a Qatar Airways vault or cloud KMS adapter. */
export function setKeyProvider(next: KeyProvider): void {
  provider = next;
}

export function resetKeyProvider(): void {
  provider = undefined;
  kekCache.clear();
}
