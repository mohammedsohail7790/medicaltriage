import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { matchesAllowlist, parseAllowlist } from "../middleware/ipAllowlist.js";
import type { AuthenticatedSession, SafeAdminUser } from "../types/security.js";
import { PRIVILEGED_PERMISSIONS, recordAuditEvent, roleGrantsForCode } from "./securityAdmin.js";

/**
 * OAuth 2.0 bearer tokens for approved API clients (AI-001, NFR-028).
 *
 * A client calls the API with an access token issued by the Qatar Airways identity provider.
 * The token is verified here, not trusted: signature against the provider's published keys,
 * issuer, audience, expiry, an allow-list of asymmetric algorithms, and an optional required
 * scope. The client (client_id or azp claim) must be on the approved list, which maps it to
 * one application role, so every call is authorised by the same role-based permissions as a
 * signed-in user. A client can also be limited to network ranges. Privileged administration
 * permissions are never grantable to a client.
 *
 * Configuration (all required for the feature to be on):
 *   OAUTH_API_ISSUER     token issuer, e.g. https://idp.example/realms/qr
 *   OAUTH_API_AUDIENCE   audience the tokens must carry for this API
 *   OAUTH_API_JWKS_URI   optional; defaults to <issuer>/.well-known/jwks.json
 *   OAUTH_API_CLIENTS    JSON: [{"clientId":"...","role":"integration_reader","allowedIps":["10.0.0.0/8"]}]
 *   OAUTH_API_REQUIRED_SCOPE   optional scope every token must carry
 */

export type OAuthClientConfig = { clientId: string; role: string; allowedIps?: string[] };

export type OAuthApiConfig = {
  issuer: string;
  audience: string;
  jwksUri: string;
  requiredScope?: string;
  clients: Map<string, OAuthClientConfig>;
};

const ALLOWED_ALGORITHMS = ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512"];

export function parseOAuthApiConfig(env: Record<string, string | undefined> = process.env): OAuthApiConfig | undefined {
  const issuer = env.OAUTH_API_ISSUER?.trim();
  const audience = env.OAUTH_API_AUDIENCE?.trim();
  if (!issuer || !audience) return undefined;
  if (env.NODE_ENV === "production" && !/^https:\/\//i.test(issuer)) throw new Error("OAUTH_API_ISSUER must use https.");
  let rawClients: unknown;
  try {
    rawClients = JSON.parse(env.OAUTH_API_CLIENTS ?? "[]");
  } catch {
    throw new Error("OAUTH_API_CLIENTS is not valid JSON.");
  }
  if (!Array.isArray(rawClients)) throw new Error("OAUTH_API_CLIENTS must be a JSON array.");
  const clients = new Map<string, OAuthClientConfig>();
  for (const [index, entry] of rawClients.entries()) {
    const item = entry as Record<string, unknown>;
    const clientId = typeof item.clientId === "string" ? item.clientId.trim() : "";
    const role = typeof item.role === "string" ? item.role.trim() : "";
    if (!clientId || !role) throw new Error(`OAUTH_API_CLIENTS[${index}] needs clientId and role.`);
    if (clients.has(clientId)) throw new Error(`OAUTH_API_CLIENTS lists ${clientId} twice.`);
    const grants = roleGrantsForCode(role);
    if (!grants) throw new Error(`OAUTH_API_CLIENTS[${index}] names an unknown role: ${role}.`);
    const privileged = grants.permissions.filter((permission) => PRIVILEGED_PERMISSIONS.has(permission));
    if (privileged.length > 0) throw new Error(`OAUTH_API_CLIENTS[${index}] role ${role} holds privileged permissions and cannot be given to an API client.`);
    const allowedIps = Array.isArray(item.allowedIps) ? item.allowedIps.map(String) : undefined;
    clients.set(clientId, { clientId, role, allowedIps });
  }
  return {
    issuer,
    audience,
    jwksUri: env.OAUTH_API_JWKS_URI?.trim() || `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`,
    requiredScope: env.OAUTH_API_REQUIRED_SCOPE?.trim() || undefined,
    clients
  };
}

let cached: { key: string; config: OAuthApiConfig | undefined; jwks?: ReturnType<typeof createRemoteJWKSet> } | undefined;

function currentConfig() {
  const key = [process.env.OAUTH_API_ISSUER, process.env.OAUTH_API_AUDIENCE, process.env.OAUTH_API_JWKS_URI, process.env.OAUTH_API_CLIENTS, process.env.OAUTH_API_REQUIRED_SCOPE].join("|");
  if (!cached || cached.key !== key) {
    const config = parseOAuthApiConfig();
    cached = { key, config, jwks: config ? createRemoteJWKSet(new URL(config.jwksUri), { cooldownDuration: 30_000, timeoutDuration: 5_000 }) : undefined };
  }
  return cached;
}

export function resetOAuthBearerForTests(): void {
  cached = undefined;
  lastSuccessAudit.clear();
}

export function oauthBearerEnabled(): boolean {
  return currentConfig().config !== undefined;
}

/** True when the token should be handled here: OAuth is on and the token is asymmetrically signed. */
export function looksLikeOAuthToken(token: string): boolean {
  if (!oauthBearerEnabled()) return false;
  try {
    const alg = decodeProtectedHeader(token).alg;
    return typeof alg === "string" && ALLOWED_ALGORITHMS.includes(alg);
  } catch {
    return false;
  }
}

export type OAuthFailure = "invalid_token" | "client_not_approved" | "network_not_permitted" | "insufficient_scope";
export class OAuthBearerError extends Error {
  constructor(readonly reason: OAuthFailure, message: string, readonly status: number) {
    super(message);
    this.name = "OAuthBearerError";
  }
}

function scopesOf(payload: JWTPayload): string[] {
  const scope = payload.scope ?? payload.scp;
  if (typeof scope === "string") return scope.split(/\s+/).filter(Boolean);
  if (Array.isArray(scope)) return scope.map(String);
  return [];
}

const lastSuccessAudit = new Map<string, number>();
const SUCCESS_AUDIT_INTERVAL_MS = 5 * 60 * 1000;

async function audit(action: string, clientId: string, success: boolean, ipAddress: string, purpose?: string): Promise<void> {
  await recordAuditEvent({
    id: randomUUID(),
    timestampIso: new Date().toISOString(),
    userId: `oauth:${clientId}`,
    activeRole: "api_client",
    organization: "",
    facility: "",
    department: "",
    action,
    module: "Authentication",
    resource: "oauth-bearer",
    purpose,
    ipAddress,
    device: "oauth-client",
    success,
    risk: success ? "low" : "high"
  });
}

/** Verifies the token and returns the principal it represents, or throws OAuthBearerError. */
export async function authenticateOAuthBearer(token: string, ipAddress: string): Promise<AuthenticatedSession> {
  const { config, jwks } = currentConfig();
  if (!config || !jwks) throw new OAuthBearerError("invalid_token", "OAuth bearer tokens are not enabled.", 401);

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { issuer: config.issuer, audience: config.audience, algorithms: ALLOWED_ALGORITHMS, clockTolerance: 30, requiredClaims: ["exp", "iss", "aud"] }));
  } catch (error) {
    await audit("OAUTH_TOKEN_REJECTED", "unknown", false, ipAddress, error instanceof Error ? error.name : "verification failed");
    throw new OAuthBearerError("invalid_token", "The access token is not valid.", 401);
  }

  const clientId = String(payload.client_id ?? payload.azp ?? "");
  const client = clientId ? config.clients.get(clientId) : undefined;
  if (!client) {
    await audit("OAUTH_CLIENT_REJECTED", clientId || "unknown", false, ipAddress, "client is not on the approved list");
    throw new OAuthBearerError("client_not_approved", "This client is not approved to call the API.", 403);
  }
  if (client.allowedIps && client.allowedIps.length > 0 && !matchesAllowlist(ipAddress, parseAllowlist(client.allowedIps.join(",")))) {
    await audit("OAUTH_CLIENT_REJECTED", clientId, false, ipAddress, "network not permitted for this client");
    throw new OAuthBearerError("network_not_permitted", "This client may not call the API from this network.", 403);
  }
  if (config.requiredScope && !scopesOf(payload).includes(config.requiredScope)) {
    await audit("OAUTH_CLIENT_REJECTED", clientId, false, ipAddress, "required scope missing");
    throw new OAuthBearerError("insufficient_scope", "The access token does not carry the required scope.", 403);
  }

  const grants = roleGrantsForCode(client.role);
  if (!grants) throw new OAuthBearerError("client_not_approved", "The client's role is not available.", 403);

  const last = lastSuccessAudit.get(clientId) ?? 0;
  if (Date.now() - last > SUCCESS_AUDIT_INTERVAL_MS) {
    lastSuccessAudit.set(clientId, Date.now());
    await audit("OAUTH_CLIENT_AUTHENTICATED", clientId, true, ipAddress, `role ${client.role}`);
  }

  const nowIso = new Date().toISOString();
  const user = {
    id: `oauth:${clientId}`,
    employeeId: clientId,
    hrmsId: "",
    fullName: `API client ${clientId}`,
    email: "",
    mobile: "",
    organization: "",
    facility: "",
    department: "",
    clinicalSpecialty: "",
    jobTitle: "API client",
    professionalCategory: "",
    manager: "",
    country: "",
    preferredLanguage: "en",
    timeZone: "UTC",
    authenticationMethod: "oidc",
    mfaStatus: "disabled",
    accountStatus: "active",
    roles: [client.role],
    responsibilities: grants.responsibilities,
    queues: [],
    accessProfiles: [],
    createdBy: "oauth-bearer",
    createdAtIso: nowIso,
    updatedBy: "oauth-bearer",
    updatedAtIso: nowIso
  } as unknown as SafeAdminUser;
  return {
    sessionId: `oauth:${clientId}:${String(payload.jti ?? payload.exp)}`,
    user,
    activeRole: client.role,
    permissions: grants.permissions,
    responsibilities: grants.responsibilities,
    expiresAtIso: new Date((payload.exp ?? 0) * 1000).toISOString(),
    authMethod: "oidc",
    mfaVerified: false
  };
}

export function isOAuthPrincipal(session: AuthenticatedSession): boolean {
  return session.sessionId.startsWith("oauth:");
}
