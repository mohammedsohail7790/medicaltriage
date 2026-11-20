import type { NextFunction, Request, Response } from "express";
import { Router } from "express";

// NFR-006: versioned API. /api/v1 and /api/v2 are served side by side by the same handlers.
// v2 differs in its error contract (RFC 7807 problem+json); v1 keeps the original { error } shape so
// existing integrations are not broken. A version can be marked deprecated with a sunset date
// (RFC 8594 Sunset header, RFC 9745 Deprecation header) without removing it.

export type ApiVersion = "v1" | "v2";

type VersionInfo = {
  version: ApiVersion;
  basePath: string;
  status: "current" | "supported" | "deprecated";
  errorFormat: "legacy-json" | "problem+json";
  deprecatedAt: string | null;
  sunsetAt: string | null;
  successor: string | null;
};

export const MINIMUM_NOTICE_DAYS = 90;

function isoDate(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function versionCatalogue(env: NodeJS.ProcessEnv = process.env): VersionInfo[] {
  const v1Deprecated = isoDate(env.API_V1_DEPRECATED_AT);
  const v1Sunset = isoDate(env.API_V1_SUNSET_AT);
  return [
    {
      version: "v1",
      basePath: "/api/v1",
      status: v1Deprecated ? "deprecated" : "supported",
      errorFormat: "legacy-json",
      deprecatedAt: v1Deprecated,
      sunsetAt: v1Sunset,
      successor: v1Deprecated ? "/api/v2" : null
    },
    { version: "v2", basePath: "/api/v2", status: "current", errorFormat: "problem+json", deprecatedAt: null, sunsetAt: null, successor: null }
  ];
}

// A sunset earlier than the minimum notice window would break the published deprecation policy.
export function validateSunsetNotice(env: NodeJS.ProcessEnv = process.env): string | null {
  const deprecated = isoDate(env.API_V1_DEPRECATED_AT);
  const sunset = isoDate(env.API_V1_SUNSET_AT);
  if (!deprecated || !sunset) return null;
  const days = (new Date(sunset).getTime() - new Date(deprecated).getTime()) / 86_400_000;
  if (days < MINIMUM_NOTICE_DAYS) return `Sunset must be at least ${MINIMUM_NOTICE_DAYS} days after the deprecation date.`;
  return null;
}

const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict",
  413: "Payload Too Large", 422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error", 503: "Service Unavailable"
};

export function toProblem(status: number, body: unknown, instance: string, requestId: unknown): Record<string, unknown> {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const detail = typeof record.error === "string" ? record.error : typeof record.message === "string" ? record.message : undefined;
  const { error: _e, message: _m, ...extensions } = record;
  return {
    type: `https://developers.irisstar.tech/problems/${status}`,
    title: STATUS_TITLES[status] ?? "Error",
    status,
    ...(detail ? { detail } : {}),
    instance,
    ...(requestId ? { requestId: String(requestId) } : {}),
    ...extensions
  };
}

export function apiVersioning() {
  return (req: Request, res: Response, next: NextFunction) => {
    const match = /^\/api\/(v\d+)(\/.*|$)/.exec(req.url.split("?")[0]);
    if (!match) return next();
    const version = match[1] as ApiVersion;
    if (version === "v2") {
      // Same handlers as v1: only the contract that differs (errors) is changed.
      (req as Request & { apiVersion?: ApiVersion }).apiVersion = "v2";
      req.url = req.url.replace(/^\/api\/v2/, "/api/v1");
      const original = res.json.bind(res);
      const originalUrl = req.originalUrl.split("?")[0];
      res.json = ((body: unknown) => {
        if (res.statusCode >= 400) {
          res.type("application/problem+json");
          return original(toProblem(res.statusCode, body, originalUrl, res.getHeader("x-request-id")));
        }
        return original(body);
      }) as typeof res.json;
    } else {
      (req as Request & { apiVersion?: ApiVersion }).apiVersion = "v1";
      const info = versionCatalogue()[0];
      if (info.deprecatedAt) {
        res.setHeader("Deprecation", `@${Math.floor(new Date(info.deprecatedAt).getTime() / 1000)}`);
        if (info.sunsetAt) res.setHeader("Sunset", new Date(info.sunsetAt).toUTCString());
        res.setHeader("Link", '</api/v2>; rel="successor-version", </api/v1/versions>; rel="deprecation"');
      }
    }
    res.setHeader("API-Version", version);
    next();
  };
}

export function createVersionsRouter(): Router {
  const router = Router();
  router.get("/versions", (_req, res) => {
    res.json({
      versions: versionCatalogue(),
      policy: {
        minimumNoticeDays: MINIMUM_NOTICE_DAYS,
        parallelSupport: "A deprecated version stays available, unchanged, until its sunset date.",
        signalling: "Deprecated versions return Deprecation, Sunset and Link headers on every response.",
        breakingChanges: "Introduced only in a new version path."
      }
    });
  });
  return router;
}
