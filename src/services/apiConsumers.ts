import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requireSecret } from "../config/secrets.js";
import { basePrisma } from "../db.js";
import { checkBudget } from "../middleware/rateLimit.js";
import { matchesAllowlist, parseAllowlist } from "../middleware/ipAllowlist.js";
import type { AuthenticatedSession } from "../types/security.js";
import { OAuthBearerError, buildApiClientSession } from "./oauthBearer.js";
import { PRIVILEGED_PERMISSIONS, roleGrantsForCode } from "./securityAdmin.js";

/**
 * API consumer onboarding (NFR-003) and per-consumer throttling (NFR-004).
 *
 * A prospective consumer registers (who they are, what for, and the load they expect, so capacity is planned), an
 * administrator approves or rejects, and an approved consumer is issued OAuth client credentials. The consumer
 * exchanges them for a short-lived access token (client credentials grant) and calls the API with it. Each consumer
 * has its own role (never an administrative one), its own request budget per minute counted in the shared store,
 * and optionally a list of networks it may call from. A consumer can be suspended at once and its secret rotated.
 */

export class ConsumerError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
    this.name = "ConsumerError";
  }
}

export const RegistrationInput = z.object({
  name: z.string().trim().min(2).max(120),
  organization: z.string().trim().min(2).max(160),
  contactEmail: z.string().trim().email().max(200),
  purpose: z.string().trim().min(20).max(1000),
  sizing: z.object({
    expectedRequestsPerMinute: z.number().int().min(1).max(100_000),
    peakRequestsPerMinute: z.number().int().min(1).max(1_000_000),
    integrationType: z.enum(["read-only", "read-write", "events"]),
    dataVolumeNote: z.string().trim().max(500).optional()
  })
});

export async function register(input: z.infer<typeof RegistrationInput>): Promise<{ requestId: string }> {
  const row = await basePrisma.apiConsumer.create({ data: { name: input.name, organization: input.organization, contactEmail: input.contactEmail, purpose: input.purpose, sizing: input.sizing } });
  return { requestId: row.id };
}

export const DecisionInput = z.object({
  decision: z.enum(["approve", "reject"]),
  role: z.string().trim().min(2).max(80).optional(),
  rateLimitPerMinute: z.number().int().min(1).max(1_000_000).optional(),
  allowedIps: z.array(z.string().trim().min(3).max(64)).max(50).optional(),
  note: z.string().trim().max(500).optional()
});

export function newSecret(): { clientSecret: string; hash: string } {
  const clientSecret = `cs_${randomBytes(32).toString("base64url")}`;
  return { clientSecret, hash: createHash("sha256").update(clientSecret).digest("hex") };
}

const hashOf = (secret: string) => createHash("sha256").update(secret).digest("hex");

export async function decide(id: string, input: z.infer<typeof DecisionInput>, actorUserId: string): Promise<{ clientId?: string; clientSecret?: string; status: string }> {
  const consumer = await basePrisma.apiConsumer.findUnique({ where: { id } });
  if (!consumer) throw new ConsumerError(404, "Request not found.", "CONSUMER_NOT_FOUND");
  if (consumer.status !== "pending") throw new ConsumerError(409, "This request has already been decided.", "CONSUMER_DECIDED");
  if (input.decision === "reject") {
    await basePrisma.apiConsumer.update({ where: { id }, data: { status: "rejected", decidedAt: new Date(), decidedBy: actorUserId, decisionNote: input.note } });
    return { status: "rejected" };
  }
  const role = input.role ?? "";
  const grants = roleGrantsForCode(role);
  if (!grants) throw new ConsumerError(400, "Choose an existing role for this consumer.", "CONSUMER_ROLE_UNKNOWN");
  if (grants.permissions.some((p) => PRIVILEGED_PERMISSIONS.has(p))) throw new ConsumerError(400, "A role with administration permissions cannot be given to an API consumer.", "CONSUMER_ROLE_PRIVILEGED");
  const sizing = consumer.sizing as { expectedRequestsPerMinute?: number; peakRequestsPerMinute?: number };
  const budget = input.rateLimitPerMinute ?? Math.max(sizing.peakRequestsPerMinute ?? 60, 1);
  const clientId = `cl_${randomBytes(9).toString("base64url")}`;
  const { clientSecret, hash } = newSecret();
  await basePrisma.apiConsumer.update({
    where: { id },
    data: { status: "approved", clientId, clientSecretHash: hash, role, rateLimitPerMinute: budget, allowedIps: input.allowedIps ?? undefined, decidedAt: new Date(), decidedBy: actorUserId, decisionNote: input.note }
  });
  // The secret is returned once, here, and only its hash is kept.
  return { status: "approved", clientId, clientSecret };
}

export async function rotateSecret(id: string): Promise<{ clientId: string; clientSecret: string }> {
  const consumer = await basePrisma.apiConsumer.findUnique({ where: { id } });
  if (!consumer?.clientId) throw new ConsumerError(404, "No approved consumer with that id.", "CONSUMER_NOT_FOUND");
  const { clientSecret, hash } = newSecret();
  await basePrisma.apiConsumer.update({ where: { id }, data: { clientSecretHash: hash } });
  invalidate(consumer.clientId);
  return { clientId: consumer.clientId, clientSecret };
}

export async function setStatus(id: string, status: "approved" | "suspended"): Promise<void> {
  const consumer = await basePrisma.apiConsumer.findUnique({ where: { id } });
  if (!consumer?.clientId) throw new ConsumerError(404, "No approved consumer with that id.", "CONSUMER_NOT_FOUND");
  await basePrisma.apiConsumer.update({ where: { id }, data: { status } });
  invalidate(consumer.clientId);
}

// ---- tokens ----------------------------------------------------------------------------------------

const TOKEN_TTL_SECONDS = 3600;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function signingKey(): Buffer {
  return createHmac("sha256", requireSecret("AUTH_JWT_SECRET")).update("api-consumer-access-token").digest();
}
const mac = (data: string) => createHmac("sha256", signingKey()).update(data).digest("base64url");

type Cached = { at: number; consumer: Awaited<ReturnType<typeof basePrisma.apiConsumer.findUnique>> };
const cache = new Map<string, Cached>();
function invalidate(clientId: string) {
  cache.delete(clientId);
}
export function resetConsumerCacheForTests(): void {
  cache.clear();
}
async function consumerByClientId(clientId: string) {
  const hit = cache.get(clientId);
  if (hit && Date.now() - hit.at < 15_000) return hit.consumer;
  const consumer = await basePrisma.apiConsumer.findUnique({ where: { clientId } });
  cache.set(clientId, { at: Date.now(), consumer });
  return consumer;
}

/** The client credentials grant: exchanges a client id and secret for a one-hour access token. */
export async function issueToken(clientId: string, clientSecret: string, ipAddress: string): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number }> {
  const consumer = await basePrisma.apiConsumer.findUnique({ where: { clientId } });
  const supplied = Buffer.from(hashOf(clientSecret));
  const stored = Buffer.from(consumer?.clientSecretHash ?? "0".repeat(64));
  // Compared even when the client is unknown, so timing does not reveal which client ids exist.
  const secretOk = supplied.length === stored.length && timingSafeEqual(supplied, stored) && Boolean(consumer?.clientSecretHash);
  if (!consumer || !secretOk) throw new ConsumerError(401, "The client credentials are not valid.", "INVALID_CLIENT");
  if (consumer.status !== "approved") throw new ConsumerError(403, "This client is not active.", "CLIENT_NOT_ACTIVE");
  const allowed = (consumer.allowedIps as string[] | null) ?? [];
  if (allowed.length > 0 && !matchesAllowlist(ipAddress, parseAllowlist(allowed.join(",")))) throw new ConsumerError(403, "This client may not call from this network.", "NETWORK_NOT_PERMITTED");
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "HS256", typ: "at+jwt" });
  const payload = b64({ iss: "aimltriage", sub: consumer.id, cid: clientId, iat: now, exp: now + TOKEN_TTL_SECONDS, jti: randomUUID() });
  return { access_token: `${header}.${payload}.${mac(`${header}.${payload}`)}`, token_type: "Bearer", expires_in: TOKEN_TTL_SECONDS };
}

export function looksLikeConsumerToken(token: string): boolean {
  try {
    return (JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as { typ?: string }).typ === "at+jwt";
  } catch {
    return false;
  }
}

/** Verifies a consumer's access token on a request, applies its network list and its own request budget, and returns its principal. */
export async function authenticateConsumerToken(token: string, ipAddress: string): Promise<AuthenticatedSession> {
  const [header, payload, signature] = token.split(".");
  const expected = Buffer.from(mac(`${header}.${payload}`));
  const given = Buffer.from(signature ?? "");
  if (!header || !payload || expected.length !== given.length || !timingSafeEqual(expected, given)) throw new OAuthBearerError("invalid_token", "The access token is not valid.", 401);
  let claims: { cid?: string; exp?: number; jti?: string };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new OAuthBearerError("invalid_token", "The access token is not valid.", 401);
  }
  if (!claims.cid || !claims.exp || claims.exp * 1000 < Date.now()) throw new OAuthBearerError("invalid_token", "The access token has expired.", 401);
  const consumer = await consumerByClientId(claims.cid);
  if (!consumer || consumer.status !== "approved" || !consumer.role) throw new OAuthBearerError("client_not_approved", "This client is not active.", 403);
  const allowed = (consumer.allowedIps as string[] | null) ?? [];
  if (allowed.length > 0 && !matchesAllowlist(ipAddress, parseAllowlist(allowed.join(",")))) throw new OAuthBearerError("network_not_permitted", "This client may not call from this network.", 403);
  // The consumer's own budget, counted across every instance.
  const budget = await checkBudget(`consumer:${claims.cid}`, 60_000, consumer.rateLimitPerMinute ?? 600);
  if (!budget.allowed) throw new OAuthBearerError("rate_limited", `This client has used its budget of ${consumer.rateLimitPerMinute} requests per minute.`, 429, budget.retryAfterSeconds);
  if (!consumer.lastUsedAt || Date.now() - consumer.lastUsedAt.getTime() > 300_000) {
    void basePrisma.apiConsumer.update({ where: { id: consumer.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  return buildApiClientSession({ clientId: claims.cid, role: consumer.role, expiresAtSeconds: claims.exp, jti: claims.jti ?? "t", label: `${consumer.name} (${consumer.organization})` });
}
