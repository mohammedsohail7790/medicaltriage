import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedSession } from "../types/security.js";
import { runWithActor } from "../services/softDelete.js";
import { requireSecret, secretVersions } from "../config/secrets.js";
import { authenticateConsumerToken, looksLikeConsumerToken } from "../services/apiConsumers.js";
import { authenticateOAuthBearer, looksLikeOAuthToken, OAuthBearerError } from "../services/oauthBearer.js";
import { getSessionEndReason, getSessionFromStore, parseSessionCookie, recordSessionActivity, validateSessionContext } from "../services/securityAdmin.js";

const JWT_TTL_SECONDS = 30 * 60;

export type AuthenticatedRequest = Request & {
  securitySession?: AuthenticatedSession;
  /** Set when an OAuth bearer token was presented and rejected, so the response can say why. */
  oauthError?: OAuthBearerError;
};

function jwtSecret(): string {
  return requireSecret("AUTH_JWT_SECRET");
}

function encodePart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signWith(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function sign(data: string): string {
  return signWith(jwtSecret(), data);
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function decodePart<T>(part: string): T | undefined {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

export function signSessionJwt(session: AuthenticatedSession): string {
  const now = Math.floor(Date.now() / 1000);
  const header = encodePart({ alg: "HS256", typ: "JWT" });
  const payload = encodePart({
    sub: session.user.id,
    sid: session.sessionId,
    role: session.activeRole,
    iat: now,
    exp: now + JWT_TTL_SECONDS
  });
  const unsignedToken = `${header}.${payload}`;
  return `${unsignedToken}.${sign(unsignedToken)}`;
}

// Shared by both the Authorization header path (sessionFromBearerToken) and
// the query-string path (sessionFromTokenString, used by the standalone
// /help page - see its comment for why a plain top-level navigation can
// carry a token here but not as a header).
export async function sessionFromTokenString(token: string | undefined): Promise<AuthenticatedSession | undefined> {
  if (!token) {
    return undefined;
  }

  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) {
    return undefined;
  }

  // The current secret signs; previous secrets (rotation window) still verify.
  const signedPart = `${header}.${payload}`;
  const verified = secretVersions("AUTH_JWT_SECRET").some((secret) => safeEquals(signature, signWith(secret, signedPart)));
  if (!verified) {
    return undefined;
  }

  const decoded = decodePart<{ sid?: string; exp?: number }>(payload);
  if (!decoded?.sid || typeof decoded.exp !== "number" || decoded.exp <= Math.floor(Date.now() / 1000)) {
    return undefined;
  }

  return getSessionFromStore(decoded.sid);
}

async function sessionFromBearerToken(req: Request): Promise<AuthenticatedSession | undefined> {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length).trim();
  // AI-001 / NFR-028: a token signed by the identity provider (asymmetric algorithm) is an OAuth
  // access token for an approved API client; the application's own session tokens are HS256.
  // NFR-003 / NFR-004: an access token issued to an onboarded API consumer.
  if (looksLikeConsumerToken(token)) {
    try {
      return await authenticateConsumerToken(token, req.ip ?? "unknown");
    } catch (error) {
      if (error instanceof OAuthBearerError) (req as AuthenticatedRequest).oauthError = error;
      else throw error;
      return undefined;
    }
  }
  if (looksLikeOAuthToken(token)) {
    try {
      return await authenticateOAuthBearer(token, req.ip ?? "unknown");
    } catch (error) {
      if (error instanceof OAuthBearerError) (req as AuthenticatedRequest).oauthError = error;
      else throw error;
      return undefined;
    }
  }
  return sessionFromTokenString(token);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function readAuthenticatedSession(req: Request): Promise<AuthenticatedSession | undefined> {
  const session = (await getSessionFromStore(parseSessionCookie(req.headers))) ?? (await sessionFromBearerToken(req));
  // NFR-145: a state-changing request is user activity and restarts the inactivity clock.
  // Reads (including background polling) do not.
  if (session && !SAFE_METHODS.has(req.method)) {
    await recordSessionActivity(session.sessionId);
  }
  return session;
}

/** The session id a request presented, whether by cookie or by token, even if that session has ended. */
function presentedSessionId(req: Request): string | undefined {
  const cookieId = parseSessionCookie(req.headers);
  if (cookieId) return cookieId;
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const payload = authorization.slice("Bearer ".length).trim().split(".")[1];
  return payload ? decodePart<{ sid?: string }>(payload)?.sid : undefined;
}

// Closes NFR-169 - re-validates the session's bound IP/User-Agent on every
// authenticated request, not just at login. Applies only to cookie-based
// browser sessions (the Nurse Cockpit/admin UI) - a Bearer JWT is a
// portable credential by design, legitimately used across different HTTP
// clients/tools (integrations, scripts, API consumers), so binding it to a
// single User-Agent would reject real, intended usage, not just replay.
// A User-Agent mismatch on a cookie session is rejected outright (a
// session token used from a different client strongly suggests
// theft/replay, and User-Agent essentially never changes mid-session for
// a genuine browser); an IP change alone is allowed through (mobile/CGNAT/
// VPN users legitimately change IP) but is recorded as a real audit event
// by validateSessionContext(), not silently ignored.
export async function requireAuthenticatedSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const session = await readAuthenticatedSession(req);
    if (!session && req.oauthError) {
      const failure = req.oauthError;
      res.setHeader("WWW-Authenticate", `Bearer error="${failure.reason === "invalid_token" ? "invalid_token" : "insufficient_scope"}"`);
      if (failure.retryAfterSeconds) res.setHeader("Retry-After", String(failure.retryAfterSeconds));
      return res.status(failure.status).json({ error: failure.message, code: failure.reason.toUpperCase() });
    }
    if (!session) {
      const reason = getSessionEndReason(presentedSessionId(req));
      return res.status(401).json({
        error: "Authentication required",
        ...(reason === "idle" ? { code: "SESSION_IDLE_TIMEOUT", message: "Your session ended after a period of inactivity. Sign in again." } : {})
      });
    }
    // NFR-148: every request is checked against the context the session was opened from
    // (user, User-Agent, network range), whether it carries the cookie or the session token.
    const userAgent = req.headers["user-agent"] ?? "unknown";
    const viewport = req.headers["x-client-viewport"];
    const contextCheck = await validateSessionContext(
      session.sessionId,
      req.ip ?? "unknown",
      userAgent,
      Array.isArray(viewport) ? viewport[0] : viewport,
      !parseSessionCookie(req.headers)
    );
    if (contextCheck === "user-agent-mismatch" || contextCheck === "ip-range-mismatch") {
      return res.status(401).json({ error: "Session context mismatch", code: "SESSION_CONTEXT_MISMATCH" });
    }
    req.securitySession = session;
    return runWithActor(session.user.id, () => next());
  } catch (error) {
    return next(error);
  }
}
