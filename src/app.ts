import { createDeveloperApiRouter, createDeveloperPageRouter } from "./routes/developerRouter.js";
import { createIntegrationAdminRouter } from "./routes/integrationAdmin.js";
import { registerPlatformSubscribers } from "./services/platformEvents.js";
import { interfaceWatcher } from "./integration/interfaceLog.js";
import { captchaProvider, validateCaptchaConfiguration, WIDGET_ORIGINS } from "./services/captcha.js";
import { validateArchiveHandoffConfiguration } from "./services/archiveHandoff.js";
import { cacheStoreName } from "./services/sharedCache.js";
import { validateLoginEncryptionConfiguration } from "./services/loginEncryption.js";
import { parseOAuthApiConfig } from "./services/oauthBearer.js";
import compression from "compression";
import cors, { type CorsOptions, type CorsOptionsDelegate } from "cors";
import express, { type Request } from "express";
import helmet from "helmet";
import morgan from "morgan";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  assertRuntimeConfiguration,
  getAllowedCorsOrigins,
  isMockMode,
  publicRuntimeEnvironment,
  runtimeModeSummary
} from "./config/runtime.js";
import { requireAuthenticatedSession } from "./middleware/auth.js";
import { corsRejectionHandler, globalErrorHandler } from "./middleware/error.js";
import { ipAllowlist } from "./middleware/ipAllowlist.js";
import { requestDurationLogger } from "./middleware/requestDuration.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { responseRecorder } from "./middleware/responseRecorder.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { createAdminRouter } from "./routes/admin.js";
import { createApprovalRouter } from "./routes/approvalRouter.js";
import { createAuthRouter } from "./routes/auth.js";
import {
  createCallCenterInboundRouter,
  createCallCenterRouter
} from "./routes/callCenterGateway.js";
import { createCcpRouter } from "./routes/ccp.js";
import { createEmrRouter } from "./routes/emr.js";
import { createFeedbackRouter } from "./routes/feedback.js";
import { createHelpApiRouter, createHelpPageRouter } from "./routes/helpRouter.js";
import { createSecurityTxtRouter } from "./routes/securityTxt.js";
import { createJobStatusRouter, createOpsAdminRouter } from "./routes/opsAdmin.js";
import { createHandoffRouter } from "./routes/handoffRouter.js";
import { createNoteTemplatesRouter } from "./routes/noteTemplates.js";
import { createSafetyRouter } from "./routes/safetyRouter.js";
import { lowBandwidthMiddleware } from "./middleware/lowBandwidth.js";
import { metricsAuthorised, prometheusText } from "./observability/metrics.js";
import { tracingMiddleware } from "./observability/tracing.js";
import { requestCounter } from "./services/resourceGuard.js";
import { apiAnalytics } from "./services/apiAnalytics.js";
import { gatewayGuard } from "./middleware/gatewayGuard.js";
import { apiVersioning, createVersionsRouter } from "./middleware/apiVersioning.js";
import { validateInfrastructureConfiguration } from "./config/infrastructureGuards.js";
import { createApiDocsRouter } from "./routes/apiDocsRouter.js";
import { createMeRouter } from "./routes/meRouter.js";
import { createHrmsRouter } from "./routes/hrms.js";
import { createProtocolsRouter } from "./routes/protocols.js";
import { createQueueRouter } from "./routes/queueRouter.js";
import { createSearchRouter } from "./routes/search.js";
import { createSimulationRouter } from "./routes/simulation.js";
import { createStaffRouter } from "./routes/staff.js";
import { createTriageRouter } from "./routes/triage.js";
import { createVoiceAssessmentRouter } from "./routes/voiceAssessment.js";
import { getCurrentClinicalContentPackage } from "./services/clinicalContent.js";

const staticRoot = path.resolve(process.cwd(), "dist-web");
const staticIndex = path.join(staticRoot, "index.html");

function loadSpaIndexHtml() {
  if (!existsSync(staticIndex)) {
    return null;
  }

  return readFileSync(staticIndex, "utf8")
    .replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (tag, src: string) =>
      tag.includes('type="module"') ? `<script defer src="${src}"></script>` : tag
    )
    .replace(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/g, (tag, href: string) =>
      tag.includes('rel="stylesheet"') ? `<link rel="stylesheet" href="${href}">` : tag
    );
}

function requestOrigin(req: Request): string | undefined {
  const host = req.get("x-forwarded-host") ?? req.get("host");
  if (!host) {
    return undefined;
  }

  const forwardedProtocol = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol || (req.secure ? "https" : req.protocol);
  return `${protocol}://${host}`;
}

function isAllowedOriginForRequest(origin: string | undefined, req: Request, allowedOrigins: string[]) {
  if (!origin) {
    return true;
  }

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  return origin === requestOrigin(req);
}

function corsForbiddenError() {
  const error = new Error("Origin not allowed by security policies") as Error & {
    status?: number;
    code?: string;
  };
  error.status = 403;
  error.code = "CORS_ORIGIN_FORBIDDEN";
  return error;
}

// NFR-020: a third-party CAPTCHA widget needs its own origins in the Content-Security-Policy.
// Nothing is added unless such a provider is configured; the self-hosted method needs none.
function captchaWidgetOrigins(): string[] {
  const provider = captchaProvider();
  return provider && provider !== "self" && provider !== "custom" ? WIDGET_ORIGINS[provider] : [];
}

export function createApp() {
  assertRuntimeConfiguration();
  // AI-001 / NFR-028: fail at startup on a malformed OAuth client list rather than on the first call.
  parseOAuthApiConfig();
  validateCaptchaConfiguration();
  validateLoginEncryptionConfiguration();
  validateArchiveHandoffConfiguration();
  cacheStoreName();
  // Sprint 7: data residency, database transport and sign-in policy, checked at start-up in production.
  validateInfrastructureConfiguration();
  const app = express();
  // Behind Firebase Hosting and Cloud Run the socket address is a Google front end, not the user.
// TRUST_PROXY_HOPS is the number of trusted proxies in front of the service; with it set,
// req.ip is the real client address (used by the IP allowlist, rate limits, audit trail and
// session binding). Unset keeps the previous behaviour.
  const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS);
  if (Number.isInteger(trustedProxyHops) && trustedProxyHops > 0) {
    app.set("trust proxy", trustedProxyHops);
  }
  const spaIndexHtml = loadSpaIndexHtml();
  const allowedOrigins = getAllowedCorsOrigins();
  const corsOptions: CorsOptionsDelegate<Request> = (req, callback) => {
    const origin = req.get("origin");
    if (!isAllowedOriginForRequest(origin, req, allowedOrigins)) {
      return callback(corsForbiddenError());
    }

    const options: CorsOptions = {
      credentials: true,
      origin: origin || false,
      // Closes NFR-171 - without an explicit list, the `cors` package
      // reflects back whatever the browser's preflight requests, which is
      // not a real whitelist. Only the verbs/headers this API actually
      // uses are allowed: GET/POST/PATCH/DELETE (confirmed via the real
      // router method usage) and Content-Type/Authorization (JSON bodies
      // + Bearer-token auth; session-cookie auth needs neither, since
      // `credentials: true` already covers cookies).
      methods: ["GET", "POST", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Client-Viewport"]
    };
    return callback(null, options);
  };
  const staffValidateRateLimit = rateLimit({
    name: "staff-validate",
    windowMs: 60_000,
    maxRequests: 30
  });
  // Closes NFR-047 (universal request throttling) - previously only a
  // handful of especially sensitive endpoints (login, staff-validate, admin
  // user-status) had any rate limit; every other endpoint had none at all.
  // This is a generous default ceiling applied to the whole API, layered
  // underneath the tighter, endpoint-specific limits above (both apply to
  // the same request - this doesn't replace them) - closes the gap that
  // most endpoints had zero throttling, without meaningfully constraining
  // real usage.
  const defaultApiRateLimit = rateLimit({
    name: "api-default",
    windowMs: 60_000,
    maxRequests: 600
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "connect-src": ["'self'", ...captchaWidgetOrigins()],
          "img-src": ["'self'", "data:"],
          "script-src": ["'self'", ...captchaWidgetOrigins()],
          "script-src-elem": ["'self'", ...captchaWidgetOrigins()],
          "frame-src": ["'self'", ...captchaWidgetOrigins()],
          "style-src": ["'self'", "'unsafe-inline'"],
          // Closes a real ZAP-baseline finding ("CSP: Wildcard Directive")
          // - helmet's useDefaults font-src is 'self' https: data:, which
          // is broader than this app actually needs. The only external
          // font host in use is Google Fonts' static CSS/asset origin.
          "font-src": ["'self'", "data:", "https://fonts.gstatic.com", "https://fonts.googleapis.com"],
          "upgrade-insecure-requests": null
        }
      }
    })
  );
  app.use(cors(corsOptions));
  app.use(corsRejectionHandler);
  // Closes NFR-143 - compresses response payloads (the queue/protocols
  // endpoints were flagged in the load-test baseline as large-payload
  // hotspots) to reduce network transfer time, especially for slower
  // client connections.
  app.use(compression());
  app.use(requestIdMiddleware());
  app.use(requestDurationLogger());
  app.use(requestCounter());
  app.use(tracingMiddleware());
  app.use(lowBandwidthMiddleware());
  app.use(apiAnalytics());
  app.use(gatewayGuard());
  // Optional IP allowlisting (NFR-027) - a no-op unless IP_ALLOWLIST is set,
  // so it never affects an existing deployment that hasn't opted in.
  app.use(ipAllowlist(process.env.IP_ALLOWLIST));
  app.use(express.json({ limit: "1mb" }));
  app.use(responseRecorder());
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (
        isMockMode() &&
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        !("is_mock" in body)
      ) {
        return originalJson({ ...body, is_mock: true });
      }
      return originalJson(body);
    }) as typeof res.json;
    return next();
  });
  if (process.env.NODE_ENV !== "test") {
    // NFR-078/NFR-004(AI): morgan's built-in ":url" token logs the full
    // request path *including query string* verbatim. No current route
    // accepts sensitive data as a query parameter, but nothing structurally
    // prevents a future one from doing so - stripping the query string here
    // closes that class of leak at the logging layer rather than relying on
    // every future route author to remember not to log it. Path, method,
    // status, size, referrer, and user-agent are unaffected.
    morgan.token("url-no-query", (req) => (req.url ?? "").split("?")[0]);
    app.use(
      morgan(
        ':remote-addr - :remote-user [:date[clf]] ":method :url-no-query HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"'
      )
    );
  }

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: "ist-tech-tele-triage-mvp",
      architecture: "rules-first-ai-second",
      phiPersistenceMode: "ephemeral-api-session-only",
      gcpPrimaryRegion: "me-central1",
      clinicalContentRelease: getCurrentClinicalContentPackage().release,
      runtime: runtimeModeSummary()
    });
  });

  app.use(apiVersioning());
  // NFR-131: metrics for a scraper, bearer-token protected, absent unless METRICS_TOKEN is set.
  app.get("/metrics", async (req, res, next) => {
    try {
      const verdict = metricsAuthorised(req.get("authorization"));
      if (verdict === "disabled") return res.status(404).json({ error: "Route not found" });
      if (verdict === "denied") return res.status(401).json({ error: "Invalid metrics token" });
      return res.type("text/plain; version=0.0.4").send(await prometheusText());
    } catch (error) {
      return next(error);
    }
  });
  app.get("/api/v1/runtime/environment", (_req, res) => {
    res.json(publicRuntimeEnvironment());
  });

  // NFR-166 / NFR-092 / NFR-093: webhooks, alert rules and the message broker listen to platform events.
  registerPlatformSubscribers();
  app.use("/api/v1", createVersionsRouter());
  app.use("/api/v1", defaultApiRateLimit);
  app.use("/api/v1/auth", createAuthRouter());
  app.use("/api/v1", createDeveloperApiRouter());
  // NFR-096: inbound calls from other systems are logged before they are processed.
  app.use("/api/v1/hrms", interfaceWatcher("hrms"), createHrmsRouter());
  app.use("/api/v1/integrations/call-center", interfaceWatcher("call-center"), createCallCenterInboundRouter());
  app.use("/api/v1/admin", requireAuthenticatedSession, createAdminRouter());
  app.use("/api/v1/admin/integrations", requireAuthenticatedSession, createIntegrationAdminRouter());
  app.use("/api/v1/admin/ops", requireAuthenticatedSession, createOpsAdminRouter());
  app.use("/api/v1/jobs", requireAuthenticatedSession, createJobStatusRouter());
  app.use("/api/v1/handoff", requireAuthenticatedSession, createHandoffRouter());
  app.use("/api/v1/note-templates", requireAuthenticatedSession, createNoteTemplatesRouter());
  app.use("/api/v1/safety", requireAuthenticatedSession, createSafetyRouter());
  app.use("/api/v1/approval", requireAuthenticatedSession, createApprovalRouter());
  app.use("/api/v1/ccp", requireAuthenticatedSession, interfaceWatcher("ccp"), createCcpRouter());
  app.use("/api/v1/staff/validate", staffValidateRateLimit);
  app.use("/api/v1/staff", requireAuthenticatedSession, createStaffRouter());
  app.use("/api/v1/me", requireAuthenticatedSession, createMeRouter());
  app.use("/api/v1/protocols", requireAuthenticatedSession, createProtocolsRouter());
  app.use("/api/v1/queue", requireAuthenticatedSession, createQueueRouter());
  app.use("/api/v1/search", requireAuthenticatedSession, createSearchRouter());
  app.use("/api/v1/call-center", requireAuthenticatedSession, createCallCenterRouter());
  app.use("/api/v1/simulation", requireAuthenticatedSession, createSimulationRouter());
  app.use("/api/v1/triage", requireAuthenticatedSession, createTriageRouter());
  app.use("/api/v1/voice-assessment", requireAuthenticatedSession, createVoiceAssessmentRouter());
  app.use("/api/v1/emr", requireAuthenticatedSession, interfaceWatcher("emr"), createEmrRouter());
  // Closes NFR-011 (UX tab) - a real user-feedback capture mechanism.
  app.use("/api/v1/feedback", requireAuthenticatedSession, createFeedbackRouter());
  app.use("/api/v1/help", createHelpApiRouter());
  // Mounted before the SPA catch-all below so /help is a genuinely separate
  // server-rendered page (not part of the Vite SPA bundle) - opening it in a
  // new tab never touches the Nurse Cockpit's or Service Manager Board's live
  // state in the other tab.
  app.use(createHelpPageRouter());
  // Closes NFR-002 (API Discovery) - a real, self-hosted portal for the
  // existing docs/openapi.json spec, top-level like /help since it's a
  // developer-facing reference page, not part of the Vite SPA bundle.
  app.use(createApiDocsRouter());
  app.use(createDeveloperPageRouter());
  // NFR-162: the public vulnerability disclosure policy and security.txt.
  app.use(createSecurityTxtRouter());

  if (spaIndexHtml) {
    app.use(express.static(staticRoot, { index: false }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.type("html").send(spaIndexHtml);
    });
  }

  app.use((req, res) => {
    // Unmatched requests are logged (path only, no query) so a misrouted client or a missing route shows up in operations.
    // The stack size and the number of sign-in routes help tell a missing route from a router that was built differently.
    const layers = (req.app as unknown as { _router?: { stack: Array<{ name?: string; regexp?: RegExp; handle?: { stack?: Array<{ route?: { path?: unknown } }> } }> } })._router?.stack ?? [];
    const authRouter = layers.find((l) => l.name === "router" && /\\\/api\\\/v1\\\/auth/.test(l.regexp?.source ?? ""));
    const loginRoutes = (authRouter?.handle?.stack ?? []).filter((l) => typeof l.route?.path === "string" && /^\/login/.test(String(l.route.path))).length;
    console.warn(JSON.stringify({ type: "route_not_found", method: req.method, path: req.path, requestId: res.getHeader("x-request-id") ?? null, layers: layers.length, loginRoutes, bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body).slice(0, 8) : null }));
    res.status(404).json({ error: "Route not found" });
  });
  app.use(globalErrorHandler);

  return app;
}
