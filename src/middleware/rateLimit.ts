import type { NextFunction, Request, Response } from "express";
import { basePrisma } from "../db.js";

/**
 * Rate limiting (NFR-004). Counters live in a store: memory (per instance, the default in development) or the
 * database (shared by every instance, the default in production), so a limit holds however many instances run.
 * RATE_LIMIT_STORE=memory|database overrides. If the shared store cannot be reached the request is counted in
 * memory instead and an error is logged: throttling degrades to per instance, it never refuses real users.
 * The database counters use fixed windows aligned to the clock.
 */

export type RateLimitHit = { count: number; resetAt: number };

type RateLimitStore = { hit(key: string, windowMs: number): Promise<RateLimitHit> };

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

const memoryStore: RateLimitStore = {
  async hit(key, windowMs) {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      buckets.set(key, fresh);
      return fresh;
    }
    bucket.count += 1;
    return bucket;
  }
};

let lastCleanup = 0;
const databaseStore: RateLimitStore = {
  async hit(key, windowMs) {
    const now = Date.now();
    const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
    const rows = await basePrisma.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "rate_limit_buckets" ("key", "window_start", "count") VALUES (${key}, ${windowStart}, 1)
      ON CONFLICT ("key", "window_start") DO UPDATE SET "count" = "rate_limit_buckets"."count" + 1
      RETURNING "count"`;
    if (now - lastCleanup > 600_000) {
      lastCleanup = now;
      void basePrisma.rateLimitBucket.deleteMany({ where: { windowStart: { lt: new Date(now - 3_600_000) } } }).catch(() => undefined);
    }
    return { count: Number(rows[0].count), resetAt: windowStart.getTime() + windowMs };
  }
};

export function rateLimitStoreName(env: Record<string, string | undefined> = process.env): "memory" | "database" {
  const configured = env.RATE_LIMIT_STORE?.trim().toLowerCase();
  if (configured === "memory" || configured === "database") return configured;
  return env.NODE_ENV === "production" ? "database" : "memory";
}

export async function recordHit(key: string, windowMs: number): Promise<RateLimitHit> {
  if (rateLimitStoreName() === "database") {
    try {
      return await databaseStore.hit(key, windowMs);
    } catch (error) {
      console.error(JSON.stringify({ type: "rate_limit_store_failed", error: error instanceof Error ? error.name : "error" }));
    }
  }
  return memoryStore.hit(key, windowMs);
}

export function resetRateLimitBucketsForTests(): void {
  buckets.clear();
}

/** Counts one request against `key` and says whether it is within `max` for the window. */
export async function checkBudget(key: string, windowMs: number, max: number): Promise<{ allowed: boolean; retryAfterSeconds: number; count: number }> {
  const hit = await recordHit(key, windowMs);
  return { allowed: hit.count <= max, retryAfterSeconds: Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000)), count: hit.count };
}

export function rateLimit(args: {
  name: string;
  windowMs: number;
  maxRequests: number;
  // An optional per-tier override on top of the default maxRequests. `tierResolver` reads whatever already
  // identifies the caller (e.g. the authenticated session's role) and returns a tier name; `tierMaxRequests`
  // maps that name to its own request budget. A request whose tier isn't in the map (or that has no resolver)
  // falls back to the flat `maxRequests`.
  tierResolver?: (req: Request) => string | undefined;
  tierMaxRequests?: Record<string, number>;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tier = args.tierResolver?.(req);
      const effectiveMax = (tier ? args.tierMaxRequests?.[tier] : undefined) ?? args.maxRequests;
      const key = `${args.name}:${tier ?? "default"}:${req.ip ?? "unknown"}`;
      const result = await checkBudget(key, args.windowMs, effectiveMax);
      if (!result.allowed) {
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
        return res.status(429).json({ error: "Rate limit exceeded", retryAfterSeconds: result.retryAfterSeconds });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
