import { createHash } from "node:crypto";
import { callExternal } from "../integration/externalClient.js";
import { requireSecret } from "../config/secrets.js";
import type { KeyProvider } from "./keyProvider.js";

/**
 * Fortanix Data Security Manager key provider for field-level encryption (M-019, M-020, AI-012).
 *
 * The key-encryption key stays in the customer's Fortanix vault. Each data key is encrypted and decrypted by a call to
 * the vault, so the application holds no key-encryption material. Set:
 *
 *   FIELD_ENCRYPTION_PROVIDER=fortanix
 *   FORTANIX_ENDPOINT=https://<the vault's DSM address>       (https only; plain http is allowed only for localhost outside production)
 *   FORTANIX_API_KEY=<app API key>                             (a secret, from Secret Manager)
 *   FORTANIX_KEY_ID=<UUID of the AES key>                      (or FORTANIX_KEY_NAME)
 *   FORTANIX_KEY_ID_PREVIOUS=<comma-separated older key UUIDs, optional, so a key change needs no re-wrap>
 *
 * Built to Fortanix's public documentation: app authentication (POST /sys/v1/session/auth with a Basic API key, bearer
 * token in access_token), and POST /crypto/v1/encrypt and /crypto/v1/decrypt with AES-GCM. It wraps the data key with
 * encrypt and decrypt, so it does not depend on the vault's wrap and unwrap calls. The app in the vault needs the
 * Encrypt and Decrypt operations on the key, and the key must be an enabled AES key.
 *
 * NOT confirmed against a real tenant, because none has been available: the JSON names tag, tag_len and ad on the wire,
 * the unit of expires_in (assumed to be seconds, and the token is refreshed at half that time and again on a 401), and
 * the error body (any non-2xx answer is an error here). Run tests/fortanixKeyProvider.test.ts, then a smoke test against the
 * Qatar Airways tenant, before relying on it.
 *
 * Nothing here ever falls back to a local key: if the vault cannot be reached or refuses a call, the operation fails.
 */

export const FORTANIX_AAD = "ist-triage-field-data-key-v1";

export class FortanixConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FortanixConfigurationError";
  }
}

export class FortanixOperationError extends Error {
  constructor(message: string, readonly causeMessage?: string) {
    super(message);
    this.name = "FortanixOperationError";
  }
}

/** One HTTPS call to the vault. Tests supply a fake. */
export type FortanixPost = (path: string, body: unknown, headers: Record<string, string>) => Promise<{ status: number; json: unknown }>;

export type FortanixOptions = {
  endpoint: string;
  /** The key, as a UUID (kid) or a name. */
  key: { kid: string } | { name: string };
  previousKeyIds?: string[];
  apiKey?: () => string;
  post?: FortanixPost;
  now?: () => number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_BITS = 128;

export function fortanixKeyId(reference: string): string {
  return `fortanix-${createHash("sha256").update(reference).digest("hex").slice(0, 12)}`;
}

export function validateFortanixEndpoint(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new FortanixConfigurationError("FORTANIX_ENDPOINT is not a valid URL.");
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname) && env.NODE_ENV !== "production";
  if (url.protocol !== "https:" && !local) throw new FortanixConfigurationError("FORTANIX_ENDPOINT must use https.");
  if (url.search || url.hash || url.username || url.password) throw new FortanixConfigurationError("FORTANIX_ENDPOINT must be a plain address without a query, fragment or credentials.");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64");

function field(json: unknown, name: string): string {
  const value = (json as Record<string, unknown> | null)?.[name];
  if (typeof value !== "string" || value.length === 0) throw new FortanixOperationError(`The vault's answer had no ${name}.`);
  return value;
}

export class FortanixKeyProvider implements KeyProvider {
  private readonly endpoint: string;
  private readonly active: { kid: string } | { name: string };
  private readonly previous: string[];
  private readonly post: FortanixPost;
  private readonly apiKey: () => string;
  private readonly now: () => number;
  private token: { value: string; refreshAt: number } | undefined;

  constructor(options: FortanixOptions, env: NodeJS.ProcessEnv = process.env) {
    this.endpoint = validateFortanixEndpoint(options.endpoint, env);
    if ("kid" in options.key && !UUID.test(options.key.kid)) throw new FortanixConfigurationError("FORTANIX_KEY_ID must be the key's UUID.");
    if ("name" in options.key && !options.key.name.trim()) throw new FortanixConfigurationError("FORTANIX_KEY_NAME is empty.");
    this.active = options.key;
    this.previous = options.previousKeyIds ?? [];
    for (const id of this.previous) if (!UUID.test(id)) throw new FortanixConfigurationError("FORTANIX_KEY_ID_PREVIOUS must be a list of key UUIDs.");
    this.apiKey = options.apiKey ?? (() => requireSecret("FORTANIX_API_KEY"));
    this.now = options.now ?? Date.now;
    this.post = options.post ?? ((path, body, headers) => this.send(path, body, headers));
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, extra: Partial<FortanixOptions> = {}): FortanixKeyProvider {
    const endpoint = env.FORTANIX_ENDPOINT?.trim();
    if (!endpoint) throw new FortanixConfigurationError("FORTANIX_ENDPOINT is required when FIELD_ENCRYPTION_PROVIDER=fortanix.");
    const kid = env.FORTANIX_KEY_ID?.trim();
    const name = env.FORTANIX_KEY_NAME?.trim();
    if (!kid && !name) throw new FortanixConfigurationError("FORTANIX_KEY_ID (or FORTANIX_KEY_NAME) is required when FIELD_ENCRYPTION_PROVIDER=fortanix.");
    const previousKeyIds = (env.FORTANIX_KEY_ID_PREVIOUS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
    return new FortanixKeyProvider({ endpoint, key: kid ? { kid } : { name: name! }, previousKeyIds, ...extra }, env);
  }

  private async send(path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: unknown }> {
    const response = await callExternal("fortanix", `${this.endpoint}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, { attempts: 2, logPayload: { path } });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  }

  private async bearer(force = false): Promise<string> {
    if (!force && this.token && this.now() < this.token.refreshAt) return this.token.value;
    const result = await this.post("/sys/v1/session/auth", {}, { authorization: `Basic ${this.apiKey()}` });
    if (result.status < 200 || result.status >= 300) throw new FortanixOperationError(`The vault refused to sign the application in (HTTP ${result.status}).`);
    const value = field(result.json, "access_token");
    const expiresIn = Number((result.json as { expires_in?: unknown }).expires_in);
    // expires_in is assumed to be seconds. Refresh at half the lifetime, and never keep a token for more than 5 minutes.
    const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min((expiresIn * 1000) / 2, 300_000) : 60_000;
    this.token = { value, refreshAt: this.now() + lifetimeMs };
    return value;
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.bearer(attempt === 1);
      const result = await this.post(path, body, { authorization: `Bearer ${token}` });
      if (result.status === 401 && attempt === 0) {
        this.token = undefined;
        continue;
      }
      if (result.status < 200 || result.status >= 300) throw new FortanixOperationError(`The vault refused the request (HTTP ${result.status}).`);
      return result.json;
    }
    throw new FortanixOperationError("The vault would not accept the application's session.");
  }

  private reference(key: { kid: string } | { name: string }): string {
    return "kid" in key ? key.kid : `name:${key.name}`;
  }

  activeKeyId(): string {
    return fortanixKeyId(this.reference(this.active));
  }

  async wrapKey(dataKey: Buffer): Promise<{ keyId: string; wrapped: string }> {
    try {
      const json = await this.call("/crypto/v1/encrypt", { key: this.active, alg: "AES", mode: "GCM", plain: b64(dataKey), tag_len: TAG_BITS, ad: b64(FORTANIX_AAD) });
      const wrapped = Buffer.from(JSON.stringify({ c: field(json, "cipher"), i: field(json, "iv"), t: field(json, "tag") })).toString("base64url");
      return { keyId: this.activeKeyId(), wrapped };
    } catch (error) {
      if (error instanceof FortanixOperationError) throw error;
      throw new FortanixOperationError("The vault could not wrap the data key.", error instanceof Error ? error.message : String(error));
    }
  }

  async unwrapKey(keyId: string, wrapped: string): Promise<Buffer> {
    const candidates: Array<{ kid: string } | { name: string }> = [this.active, ...this.previous.map((kid) => ({ kid }))];
    const key = candidates.find((candidate) => fortanixKeyId(this.reference(candidate)) === keyId);
    if (!key) throw new FortanixOperationError(`No Fortanix key is configured for key id ${keyId}.`);
    try {
      const parts = JSON.parse(Buffer.from(wrapped, "base64url").toString("utf8")) as { c?: string; i?: string; t?: string };
      if (!parts.c || !parts.i || !parts.t) throw new FortanixOperationError("The wrapped key is not in the expected form.");
      const json = await this.call("/crypto/v1/decrypt", { key, alg: "AES", mode: "GCM", cipher: parts.c, iv: parts.i, tag: parts.t, tag_len: TAG_BITS, ad: b64(FORTANIX_AAD) });
      const plain = Buffer.from(field(json, "plain"), "base64");
      if (plain.length !== 32) throw new FortanixOperationError("The vault returned a data key of the wrong length.");
      return plain;
    } catch (error) {
      if (error instanceof FortanixOperationError) throw error;
      throw new FortanixOperationError("The vault could not unwrap the data key.", error instanceof Error ? error.message : String(error));
    }
  }
}
