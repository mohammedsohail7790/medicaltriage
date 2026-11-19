import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { requireSecret, secretVersions } from "../config/secrets.js";

// The governed-account key is its own secret when set, otherwise it shares the MFA key.
function rootSecretName(): string {
  return process.env.GOVERNED_ACCOUNT_ENCRYPTION_KEY?.trim() ? "GOVERNED_ACCOUNT_ENCRYPTION_KEY" : "MFA_ENCRYPTION_KEY";
}

function keyFor(secret: string): Buffer {
  return scryptSync(secret, "ist-triage-governed-account-encryption-v1", 32);
}

function encryptionKey(): Buffer {
  return keyFor(requireSecret(rootSecretName()));
}

function blindIndexKey(): Buffer {
  // The blind index must stay stable, so it follows the current key only.
  return scryptSync(requireSecret(rootSecretName()), "ist-triage-governed-account-index-v1", 32);
}

export function encryptGovernedIdentifier(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(".");
}

export function decryptGovernedIdentifier(ciphertext: string): string {
  const [iv, tag, encrypted] = ciphertext.split(".").map((part) => Buffer.from(part, "base64"));
  if (!iv || !tag || !encrypted) throw new Error("Invalid governed identifier ciphertext.");
  let lastError: unknown;
  for (const secret of secretVersions(rootSecretName())) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Governed identifier could not be decrypted.");
}

export function governedEmailBlindIndex(email: string): string {
  return createHmac("sha256", blindIndexKey()).update(email.trim().toLowerCase()).digest("hex");
}

export function hashGovernedPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyGovernedPassword(password: string, encoded: string): boolean {
  const [version, salt, expectedHex] = encoded.split(":");
  if (version !== "scrypt-v1" || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
