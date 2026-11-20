import { localLoginAllowed } from "../config/infrastructureGuards.js";
import { connectedApps, rememberReturn, sanitizeReturnTo, takeReturn } from "../services/ssoLinks.js";
import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { decryptLoginPayload, loginEncryptionContext, loginEncryptionMode, LoginEncryptionError, loginPathSegment } from "../services/loginEncryption.js";
import { captchaFailsClosed, captchaProvider, captchaRequirement, issueSelfChallenge, verifyCaptcha } from "../services/captcha.js";
import { currentPasswordPolicy } from "../services/passwordPolicy.js";
import { readAuthenticatedSession, requireAuthenticatedSession, signSessionJwt, type AuthenticatedRequest } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  authenticateLocal,
  buildSsoAuthorizationUrl,
  completeSsoLogin,
  confirmMfaEnrollment,
  confirmMfaEnrollmentWithToken,
  enrollMfa,
  enrollMfaWithToken,
  EnrollmentTokenInvalidError,
  expiredSessionCookie,
  MfaChallengeExpiredError,
  MfaChallengeNotFoundError,
  parseSessionCookie,
  revokeSession,
  sessionCookie,
  SsoProviderNotConfiguredError,
  SsoStateInvalidError,
  testSsoProvider,
  UserNotFoundError,
  verifyMfaChallenge,
  changeLocalPassword,
  failedLoginCountFor,
  getSessionEndReason,
  recordAuditEvent,
  InvalidCurrentPasswordError,
  PasswordChangeNotAllowedError,
  PasswordPolicyViolationError,
  enforceSessionContextOnToken,
  sessionIdleTimeoutSeconds
} from "../services/securityAdmin.js";
import {
  LoginRequestSchema,
  MfaEnrollConfirmRequestSchema,
  MfaVerifyRequestSchema,
  SsoTestRequestSchema,
  type AuthenticatedSession
} from "../types/security.js";

const controlCenterRoles = new Set(["platform_super_administrator", "triage_service_manager"]);

// Shared by /login and /mfa/verify - both end a real authentication attempt
// by issuing the same session cookie, JWT, and redirect target. Extracted
// so MFA doesn't duplicate this logic.
function finalizeLoginResponse(req: AuthenticatedRequest, res: Response, session: AuthenticatedSession, rememberMe: boolean, returnTo?: string) {
  const secureCookie = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", sessionCookie(session.sessionId, rememberMe, secureCookie));
  enforceSessionContextOnToken(session.sessionId);
  return res.json({
    authenticated: true,
    session,
    accessToken: signSessionJwt(session),
    redirectTo: controlCenterRoles.has(session.activeRole) ? "admin" : "workspace",
    ...(returnTo ? { returnTo } : {})
  });
}

// NFR-020: returns what the client must show when sign-in needs a challenge that is missing or wrong.
async function challengeIfRequired(req: AuthenticatedRequest, username: string, token: string | undefined) {
  const ipAddress = req.ip ?? "unknown";
  const reason = captchaRequirement({ failedAttempts: failedLoginCountFor(username), ipAddress });
  if (!reason) return undefined;
  const result = await verifyCaptcha(token, ipAddress);
  if (result === "passed" || (result === "unavailable" && !captchaFailsClosed())) return undefined;
  if (token) {
    await recordAuditEvent({
      id: randomUUID(), timestampIso: new Date().toISOString(), userId: username.trim().toLowerCase(), activeRole: "unknown", organization: "", facility: "", department: "",
      action: "CAPTCHA_FAILED", module: "Authentication", resource: "local", purpose: `${reason}; ${result}`, ipAddress, device: "", success: false, risk: "medium"
    });
  }
  return captchaPrompt(reason);
}

function captchaPrompt(reason: string) {
  const provider = captchaProvider();
  return {
    captchaRequired: true,
    reason,
    provider,
    ...(provider === "self" ? { challenge: issueSelfChallenge() } : {}),
    ...(provider && provider !== "self" ? { siteKey: process.env.CAPTCHA_SITE_KEY } : {})
  };
}

export function createAuthRouter(): Router {
  const router = Router();
  // The real, production-strict limit is 10/min per bucket. The Playwright
  // e2e harness (scripts/startE2eServer.ts, the only place that sets
  // APP_DATA_PROFILE=synthetic-e2e) runs several browser-engine projects
  // sequentially against one shared backend server/rate-limit bucket (see
  // playwright.config.ts's shared-server rationale) - real login attempts
  // across those projects legitimately exceed 10/min even though each one
  // individually is a normal, intentional test login, not abuse. Loosening
  // this only for the synthetic e2e profile keeps the real security behavior
  // untouched in mock/production/demo modes.
  const isSyntheticE2e = process.env.APP_DATA_PROFILE === "synthetic-e2e";
  const loginRateLimit = rateLimit({
    name: "auth-login",
    windowMs: 60_000,
    maxRequests: isSyntheticE2e ? 200 : 10
  });
  const mfaVerifyRateLimit = rateLimit({
    name: "auth-mfa-verify",
    windowMs: 60_000,
    maxRequests: isSyntheticE2e ? 200 : 10
  });

  router.get("/session", async (req, res, next) => {
    try {
      const session = await readAuthenticatedSession(req);
      if (!session) {
        const reason = getSessionEndReason(parseSessionCookie(req.headers));
        return res.status(401).json({ authenticated: false, ...(reason === "idle" ? { code: "SESSION_IDLE_TIMEOUT" } : {}) });
      }
      return res.json({ authenticated: true, session, idleTimeoutSeconds: sessionIdleTimeoutSeconds() });
    } catch (error) {
      return next(error);
    }
  });

  // NFR-145: the client calls this while the user is working. A POST counts as activity
  // (see readAuthenticatedSession), so a user who is reading or typing keeps the session
  // alive while background polling does not.
  router.post("/activity", async (req, res, next) => {
    try {
      const session = await readAuthenticatedSession(req);
      if (!session) {
        const reason = getSessionEndReason(parseSessionCookie(req.headers));
        return res.status(401).json({ authenticated: false, ...(reason === "idle" ? { code: "SESSION_IDLE_TIMEOUT" } : {}) });
      }
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  // NFR-016: change a local password. A signed-in user changes their own; a user whose temporary or
  // expired password blocked sign-in sends their user name and current password instead.
  router.post("/password/change", loginRateLimit, async (req, res, next) => {
    try {
      const parsed = z
        .object({ username: z.string().min(3).max(180).optional(), currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      }
      const session = await readAuthenticatedSession(req);
      const username = session ? session.user.id : parsed.data.username;
      if (!username) {
        return res.status(400).json({ error: "A user name is required." });
      }
      const userAgent = req.headers["user-agent"];
      try {
        await changeLocalPassword({
          username,
          currentPassword: parsed.data.currentPassword,
          newPassword: parsed.data.newPassword,
          ipAddress: req.ip ?? "unknown",
          device: Array.isArray(userAgent) ? userAgent.join(" ") : userAgent ?? "unknown",
          keepSessionId: session?.sessionId,
          userId: session?.user.id
        });
        return res.json({ changed: true });
      } catch (error) {
        if (error instanceof PasswordPolicyViolationError) {
          return res.status(422).json({ error: "The new password does not meet the password policy.", code: "PASSWORD_POLICY", violations: error.violations });
        }
        if (error instanceof InvalidCurrentPasswordError) {
          return res.status(401).json({ error: error.message, code: "INVALID_CURRENT_PASSWORD" });
        }
        if (error instanceof PasswordChangeNotAllowedError) {
          return res.status(403).json({ error: error.message, code: "PASSWORD_CHANGE_NOT_ALLOWED" });
        }
        throw error;
      }
    } catch (error) {
      return next(error);
    }
  });

  // NFR-020: lets the sign-in page know whether a challenge is needed before the first attempt
  // (for example from outside the approved networks) and which method to show.
  router.get("/login-config", async (req, res, next) => {
    try {
    const provider = captchaProvider();
    const reason = captchaRequirement({ failedAttempts: 0, ipAddress: req.ip ?? "unknown" });
    // The encryption nonce is single use, so this answer must never be cached.
    res.setHeader("Cache-Control", "no-store");
    return res.json({ loginEncryption: (await loginEncryptionContext()) ?? null, captcha: provider ? { provider, required: Boolean(reason), reason: reason ?? null, ...(provider !== "self" ? { siteKey: process.env.CAPTCHA_SITE_KEY } : {}) } : null });
    } catch (error) {
      return next(error);
    }
  });

  // A fresh proof-of-work challenge for the self-hosted method.
  router.get("/captcha/challenge", loginRateLimit, (_req, res) => {
    if (captchaProvider() !== "self") return res.status(404).json({ error: "Not available" });
    return res.json(issueSelfChallenge());
  });

  // The policy a user's new password must meet, so the form can show it before submission.
  router.get("/password/policy", (_req, res) => {
    const { minLength, requireUppercase, requireLowercase, requireDigit, requireSymbol, historyCount, maxAgeDays } = currentPasswordPolicy();
    return res.json({ minLength, requireUppercase, requireLowercase, requireDigit, requireSymbol, historyCount, maxAgeDays });
  });

  const loginHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = LoginRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid login payload", details: parsed.error.flatten() });
      }

      // NFR-020: a solved challenge is required after repeated failures and from outside the approved networks.
      const captcha = await challengeIfRequired(req, parsed.data.username, parsed.data.captchaToken);
      if (captcha) {
        return res.status(403).json({ error: "Authentication failed", message: "Complete the security check to continue.", ...captcha });
      }

      // NFR-151: with single sign-on enforced, a local password works only for a named break-glass account.
      if (!localLoginAllowed(parsed.data.username)) {
        await recordAuditEvent({
          id: randomUUID(), timestampIso: new Date().toISOString(), userId: parsed.data.username.trim().toLowerCase(), activeRole: "unknown", organization: "", facility: "", department: "",
          action: "LOCAL_LOGIN_REFUSED_SSO_ENFORCED", module: "Authentication", resource: "local", ipAddress: req.ip ?? "unknown", device: "", success: false, risk: "low"
        });
        return res.status(403).json({ error: "Authentication failed", message: "Sign in with your organisation account.", ssoRequired: true });
      }

      const userAgent = req.headers["user-agent"];
      const result = await authenticateLocal({
        username: parsed.data.username,
        password: parsed.data.password,
        rememberMe: parsed.data.rememberMe,
        simulateRole: parsed.data.simulateRole,
        ipAddress: req.ip ?? "unknown",
        device: Array.isArray(userAgent) ? userAgent.join(" ") : userAgent ?? "unknown"
      });

      if (!result.ok) {
        return res.status(result.forbidden || result.passwordChangeRequired ? 403 : result.locked ? 423 : 401).json({
          error: "Authentication failed",
          message: result.message,
          ...(result.passwordChangeRequired ? { passwordChangeRequired: result.passwordChangeRequired } : {}),
          ...(result.mfaEnrollmentRequired
            ? { mfaEnrollmentRequired: true, enrollmentToken: result.enrollmentToken }
            : {})
        });
      }

      if ("mfaRequired" in result) {
        return res.status(202).json({ authenticated: false, mfaRequired: true, challengeId: result.challengeId });
      }

      return finalizeLoginResponse(req, res, result.session, parsed.data.rememberMe);
    } catch (error) {
      return next(error);
    }
  };

  // NFR-146: the encrypted form of sign-in. The body is `{ "encrypted": "<JWE>" }`; it is decrypted
  // and checked for a fresh, unused nonce before the normal sign-in runs. LOGIN_ENCRYPTION_MODE
  // decides whether the plain form is still accepted, and LOGIN_PATH_SEGMENT moves the address.
  async function unwrapLoginBody(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const mode = loginEncryptionMode();
      const encrypted = typeof req.body?.encrypted === "string" ? (req.body.encrypted as string) : undefined;
      if (mode === "off" || (!encrypted && mode === "optional")) return next();
      if (!encrypted) {
        return res.status(400).json({ error: "Encrypted sign-in is required.", code: "LOGIN_ENCRYPTION_REQUIRED" });
      }
      try {
        req.body = await decryptLoginPayload(encrypted);
      } catch (error) {
        if (error instanceof LoginEncryptionError) {
          await recordAuditEvent({
            id: randomUUID(), timestampIso: new Date().toISOString(), userId: "unknown", activeRole: "unknown", organization: "", facility: "", department: "",
            action: "LOGIN_PAYLOAD_REJECTED", module: "Authentication", resource: "local", purpose: error.code, ipAddress: req.ip ?? "unknown", device: "", success: false, risk: "medium"
          });
          return res.status(error.code === "LOGIN_REPLAYED" ? 409 : 400).json({ error: error.message, code: error.code });
        }
        throw error;
      }
      return next();
    } catch (error) {
      return next(error);
    }
  }

  const loginSegment = loginPathSegment();
  const loginPaths = [
    ...(loginSegment ? [`/login-${loginSegment}`] : []),
    // With a rotated address and encryption required, the well-known address is not served at all.
    ...(!loginSegment || loginEncryptionMode() !== "required" ? ["/login"] : [])
  ];
  for (const path of loginPaths) router.post(path, loginRateLimit, unwrapLoginBody, loginHandler);

  router.post("/mfa/verify", mfaVerifyRateLimit, async (req, res, next) => {
    try {
      const parsed = MfaVerifyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid MFA verification payload", details: parsed.error.flatten() });
      }
      const result = await verifyMfaChallenge(parsed.data.challengeId, parsed.data.code);
      if (!result.ok) {
        return res.status(result.locked ? 423 : 401).json({ error: "MFA verification failed", message: result.message });
      }
      // rememberMe was already captured when the challenge was created; the
      // cookie's max-age just mirrors whatever the initial /login request
      // requested (the session object itself already reflects it via TTL).
      return finalizeLoginResponse(req, res, result.session, false);
    } catch (error) {
      if (error instanceof MfaChallengeNotFoundError || error instanceof MfaChallengeExpiredError) {
        return res.status(410).json({ error: error.message });
      }
      return next(error);
    }
  });

  // Both routes below accept EITHER a real authenticated session (the
  // existing self-service "enroll while already logged in" path) OR a
  // real pre-auth enrollment token (closes AR.13 - lets an unenrolled user
  // reach these two routes, and only these two, without a session). The
  // token grants no other capability anywhere in this app - see
  // pendingEnrollmentTokens' own comment in securityAdmin.ts.
  router.post("/mfa/enroll", async (req, res, next) => {
    try {
      const enrollmentToken = typeof req.body?.enrollmentToken === "string" ? req.body.enrollmentToken : undefined;
      if (enrollmentToken) {
        const enrollment = enrollMfaWithToken(enrollmentToken);
        return res.json(enrollment);
      }
      const session = await readAuthenticatedSession(req);
      if (!session) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const enrollment = enrollMfa(session.user.id);
      return res.json(enrollment);
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof EnrollmentTokenInvalidError) {
        return res.status(401).json({ error: error.message });
      }
      return next(error);
    }
  });

  router.post("/mfa/enroll/confirm", async (req, res, next) => {
    try {
      const parsed = MfaEnrollConfirmRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid MFA enrollment confirmation", details: parsed.error.flatten() });
      }
      const enrollmentToken = typeof req.body?.enrollmentToken === "string" ? req.body.enrollmentToken : undefined;
      if (enrollmentToken) {
        const confirmed = confirmMfaEnrollmentWithToken(enrollmentToken, parsed.data.code);
        if (!confirmed) {
          return res.status(401).json({ error: "Invalid authentication code" });
        }
        return res.json({ enrolled: true });
      }
      const session = await readAuthenticatedSession(req);
      if (!session) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const confirmed = confirmMfaEnrollment(session.user.id, parsed.data.code);
      if (!confirmed) {
        return res.status(401).json({ error: "Invalid authentication code" });
      }
      return res.json({ enrolled: true });
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof EnrollmentTokenInvalidError) {
        return res.status(401).json({ error: error.message });
      }
      return next(error);
    }
  });

  router.post("/logout", async (req, res, next) => {
    try {
      await revokeSession(parseSessionCookie(req.headers));
      res.setHeader("Set-Cookie", expiredSessionCookie());
      return res.json({ authenticated: false });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/sso/test", async (req, res, next) => {
    try {
      const parsed = SsoTestRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid SSO test payload", details: parsed.error.flatten() });
      }
      return res.json(await testSsoProvider(parsed.data.providerId));
    } catch (error) {
      return next(error);
    }
  });

  const ssoCallbackRateLimit = rateLimit({
    name: "auth-sso-callback",
    windowMs: 60_000,
    maxRequests: 20
  });

  // NFR-019: applications connected to the same identity provider, and a one-click transition to each.
  router.get("/connected-apps", requireAuthenticatedSession, (_req, res) => {
    res.json({ apps: connectedApps().map((app) => ({ id: app.id, name: app.name, launchPath: `/api/v1/auth/launch/${encodeURIComponent(app.id)}` })) });
  });

  router.get("/launch/:appId", requireAuthenticatedSession, (req, res) => {
    const target = connectedApps().find((app) => app.id === req.params.appId);
    if (!target) return res.status(404).json({ error: "Unknown connected application" });
    return res.redirect(target.launchUrl);
  });

  router.get("/sso/:providerId/login", async (req, res, next) => {
    try {
      const redirectUri = `${req.protocol}://${req.get("host")}/api/v1/auth/sso/${req.params.providerId}/callback`;
      const authorizationUrl = await buildSsoAuthorizationUrl(req.params.providerId, redirectUri);
      // NFR-019: remember a validated deep link to return to after sign-in.
      rememberReturn(new URL(authorizationUrl).searchParams.get("state"), sanitizeReturnTo(req.query.returnTo));
      return res.redirect(authorizationUrl);
    } catch (error) {
      if (error instanceof SsoProviderNotConfiguredError) {
        return res.status(404).json({ error: error.message });
      }
      return next(error);
    }
  });

  router.get("/sso/:providerId/callback", ssoCallbackRateLimit, async (req, res, next) => {
    try {
      const callbackUrl = new URL(req.originalUrl, `${req.protocol}://${req.get("host")}`);
      const result = await completeSsoLogin(
        req.params.providerId,
        callbackUrl,
        req.ip ?? "unknown",
        Array.isArray(req.headers["user-agent"]) ? req.headers["user-agent"].join(" ") : req.headers["user-agent"] ?? "unknown"
      );
      if (!result.ok) {
        return res.status(401).json({ error: "SSO login failed", message: result.message });
      }
      const returnTo = takeReturn(callbackUrl.searchParams.get("state"));
      return finalizeLoginResponse(req, res, result.session, false, returnTo);
    } catch (error) {
      if (error instanceof SsoProviderNotConfiguredError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof SsoStateInvalidError) {
        return res.status(400).json({ error: error.message });
      }
      return next(error);
    }
  });

  return router;
}
