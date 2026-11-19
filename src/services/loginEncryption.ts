import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { calculateJwkThumbprint, compactDecrypt, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { shouldPersistSessionsInDatabase } from "../config/runtime.js";
import { requireSecret } from "../config/secrets.js";
import { prisma } from "../db.js";

/**
 * Encrypted, replay-protected sign-in (NFR-146).
 *
 * On top of TLS, the browser encrypts the sign-in form (user name, password and the rest) to
 * a public key published by the server, as a JWE (ECDH-ES+A256KW, A256GCM). Inside the
 * encrypted payload sits a one-time nonce issued by the server and a timestamp; the server
 * accepts each nonce once, within a short window, so a captured request cannot be replayed.
 * The sign-in address can be moved per environment (LOGIN_PATH_SEGMENT) so its location is
 * not the well-known one.
 *
 *   LOGIN_ENCRYPTION_MODE   off (default) | optional (encrypted or plain) | required (encrypted only)
 *   LOGIN_ENCRYPTION_KEY    private key, an ECDH P-256 JWK as JSON (from the secret store);
 *                           LOGIN_ENCRYPTION_KEY_PREVIOUS keeps the old key during rotation
 *   LOGIN_PATH_SEGMENT      adds the sign-in route at /api/v1/auth/login-<segment>
 *   LOGIN_NONCE_TTL_SECONDS how long an issued nonce is valid (default 120)
 * There are no query parameters on sign-in; everything sensitive travels in the encrypted body.
 */

export type LoginEncryptionMode = "off" | "optional" | "required";

export function loginEncryptionMode(env: Record<string, string | undefined> = process.env): LoginEncryptionMode {
  const raw = (env.LOGIN_ENCRYPTION_MODE ?? "off").trim().toLowerCase();
  if (raw === "optional" || raw === "required") return raw;
  if (raw === "off" || raw === "") return "off";
  throw new Error("LOGIN_ENCRYPTION_MODE must be off, optional or required.");
}

export function loginPathSegment(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.LOGIN_PATH_SEGMENT?.trim();
  if (!raw) return undefined;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(raw)) throw new Error("LOGIN_PATH_SEGMENT must be 8 to 64 letters, digits, hyphens or underscores.");
  return raw;
}

export function validateLoginEncryptionConfiguration(env: Record<string, string | undefined> = process.env): void {
  const mode = loginEncryptionMode(env);
  loginPathSegment(env);
  if (mode !== "off" && env.NODE_ENV === "production" && !env.LOGIN_ENCRYPTION_KEY?.trim()) {
    throw new Error("LOGIN_ENCRYPTION_KEY is required when login encryption is on.");
  }
  for (const name of ["LOGIN_ENCRYPTION_KEY", "LOGIN_ENCRYPTION_KEY_PREVIOUS"]) {
    const value = env[name]?.trim();
    if (!value) continue;
    try {
      const jwk = JSON.parse(value) as JWK;
      if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d) throw new Error();
    } catch {
      throw new Error(`${name} must be an EC P-256 private key as JSON (JWK).`);
    }
  }
}

type LoadedKey = { kid: string; privateJwk: JWK; publicJwk: JWK };
let developmentKey: Promise<LoadedKey> | undefined;

async function loadKey(jwk: JWK): Promise<LoadedKey> {
  const { d: _d, ...publicJwk } = jwk;
  const kid = await calculateJwkThumbprint(publicJwk);
  return { kid, privateJwk: { ...jwk, alg: "ECDH-ES+A256KW", kid }, publicJwk: { ...publicJwk, alg: "ECDH-ES+A256KW", use: "enc", kid } };
}

async function keys(): Promise<LoadedKey[]> {
  const configured = [process.env.LOGIN_ENCRYPTION_KEY, process.env.LOGIN_ENCRYPTION_KEY_PREVIOUS].map((v) => v?.trim()).filter((v): v is string => Boolean(v));
  if (configured.length > 0) return Promise.all(configured.map((value) => loadKey(JSON.parse(value) as JWK)));
  if (process.env.NODE_ENV === "production") throw new Error("LOGIN_ENCRYPTION_KEY is not configured.");
  // Local development and tests: a key made for this process only.
  developmentKey ??= generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true }).then(async (pair) => loadKey(await exportJWK(pair.privateKey)));
  return [await developmentKey];
}

// ---- nonces ------------------------------------------------------------------------------------

function nonceTtlMs(): number {
  const seconds = Number(process.env.LOGIN_NONCE_TTL_SECONDS);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 120) * 1000;
}

function nonceMac(body: string): string {
  return createHmac("sha256", requireSecret("AUTH_JWT_SECRET")).update(`login-nonce:${body}`).digest("base64url");
}

export function issueLoginNonce(): string {
  const body = `${randomBytes(16).toString("base64url")}.${Date.now() + nonceTtlMs()}`;
  return `${body}.${nonceMac(body)}`;
}

const usedNonces = new Map<string, number>();
let lastCleanup = 0;

export class LoginEncryptionError extends Error {
  constructor(readonly code: "LOGIN_ENCRYPTION_REQUIRED" | "LOGIN_PAYLOAD_INVALID" | "LOGIN_REPLAYED", message: string) {
    super(message);
    this.name = "LoginEncryptionError";
  }
}

async function consumeNonce(nonce: string): Promise<void> {
  const [random, expiry, mac] = nonce.split(".");
  const body = `${random}.${expiry}`;
  const expected = Buffer.from(nonceMac(body));
  const given = Buffer.from(mac ?? "");
  if (!random || !expiry || expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new LoginEncryptionError("LOGIN_PAYLOAD_INVALID", "The sign-in request is not valid.");
  }
  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) throw new LoginEncryptionError("LOGIN_REPLAYED", "The sign-in request has expired. Try again.");

  if (shouldPersistSessionsInDatabase()) {
    try {
      await prisma.loginNonce.create({ data: { nonce: random, expiresAt: new Date(expiresAt) } });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") throw new LoginEncryptionError("LOGIN_REPLAYED", "This sign-in request was already used.");
      throw error;
    }
    if (Date.now() - lastCleanup > 60_000) {
      lastCleanup = Date.now();
      void prisma.loginNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined);
    }
    return;
  }
  const now = Date.now();
  for (const [key, until] of usedNonces) if (until < now) usedNonces.delete(key);
  if (usedNonces.has(random)) throw new LoginEncryptionError("LOGIN_REPLAYED", "This sign-in request was already used.");
  usedNonces.set(random, expiresAt);
}

export function resetLoginEncryptionForTests(): void {
  usedNonces.clear();
  developmentKey = undefined;
}

// ---- public interface ----------------------------------------------------------------------------

/** What the sign-in page needs to build an encrypted request, or undefined when the feature is off. */
export async function loginEncryptionContext() {
  const mode = loginEncryptionMode();
  if (mode === "off") return undefined;
  const [active] = await keys();
  const segment = loginPathSegment();
  return {
    mode,
    kid: active.kid,
    publicJwk: active.publicJwk,
    nonce: issueLoginNonce(),
    path: segment ? `/api/v1/auth/login-${segment}` : "/api/v1/auth/login",
    ttlSeconds: nonceTtlMs() / 1000
  };
}

const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;

/** Decrypts and checks an encrypted sign-in body. Returns the form the user filled in. */
export async function decryptLoginPayload(jwe: string): Promise<Record<string, unknown>> {
  let plaintext: string;
  try {
    const candidates = await keys();
    let decrypted: Uint8Array | undefined;
    for (const key of candidates) {
      try {
        decrypted = (await compactDecrypt(jwe, await importJWK(key.privateJwk, "ECDH-ES+A256KW"), { keyManagementAlgorithms: ["ECDH-ES+A256KW"], contentEncryptionAlgorithms: ["A256GCM"] })).plaintext;
        break;
      } catch {
        // try the next key (rotation)
      }
    }
    if (!decrypted) throw new Error("no key");
    plaintext = new TextDecoder().decode(decrypted);
  } catch {
    throw new LoginEncryptionError("LOGIN_PAYLOAD_INVALID", "The sign-in request is not valid.");
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(plaintext) as Record<string, unknown>;
  } catch {
    throw new LoginEncryptionError("LOGIN_PAYLOAD_INVALID", "The sign-in request is not valid.");
  }
  const { nonce, iat, ...form } = payload;
  if (typeof nonce !== "string" || typeof iat !== "number" || Math.abs(Date.now() - iat) > MAX_CLOCK_SKEW_MS) {
    throw new LoginEncryptionError("LOGIN_PAYLOAD_INVALID", "The sign-in request is not valid.");
  }
  await consumeNonce(nonce);
  return form;
}
