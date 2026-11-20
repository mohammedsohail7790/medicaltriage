import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";

// NFR-008: how the API is being consumed. Per route and per consumer: requests, client and server
// errors, and latency percentiles over a bounded window. Held in memory per instance (cheap, no
// payloads, no personal data); the request_duration log lines are the durable record.

const WINDOW = 500;

type Bucket = { requests: number; clientErrors: number; serverErrors: number; samples: number[]; lastSeenIso: string };
const buckets = new Map<string, Bucket>();
const MAX_KEYS = 5000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function recordApiCall(key: { version: string; method: string; route: string; consumer: string }, status: number, durationMs: number): void {
  const id = `${key.version}|${key.method}|${key.route}|${key.consumer}`;
  let bucket = buckets.get(id);
  if (!bucket) {
    if (buckets.size >= MAX_KEYS) return;
    bucket = { requests: 0, clientErrors: 0, serverErrors: 0, samples: [], lastSeenIso: "" };
    buckets.set(id, bucket);
  }
  bucket.requests += 1;
  if (status >= 500) bucket.serverErrors += 1;
  else if (status >= 400) bucket.clientErrors += 1;
  bucket.samples.push(durationMs);
  if (bucket.samples.length > WINDOW) bucket.samples.shift();
  bucket.lastSeenIso = new Date().toISOString();
}

export function apiAnalytics() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api/")) return next();
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const session = (req as AuthenticatedRequest).securitySession;
      const consumer = session?.user.id.startsWith("oauth:") ? session.user.id.slice(6) : session ? "interactive" : "anonymous";
      const template = req.route ? `${req.baseUrl}${typeof req.route.path === "string" ? req.route.path : ""}` : "(unmatched)";
      recordApiCall(
        { version: (req as Request & { apiVersion?: string }).apiVersion ?? "v1", method: req.method, route: template.replace(/\/$/, "") || "/", consumer },
        res.statusCode,
        Number(process.hrtime.bigint() - started) / 1_000_000
      );
    });
    next();
  };
}

export type AnalyticsRow = { version: string; method: string; route: string; consumer: string; requests: number; clientErrors: number; serverErrors: number; errorRate: number; p50Ms: number; p95Ms: number; lastSeenIso: string };

export function apiAnalyticsReport(filter: { consumer?: string; route?: string } = {}): { rows: AnalyticsRow[]; totals: { requests: number; serverErrors: number; clientErrors: number }; byConsumer: Array<{ consumer: string; requests: number }> } {
  const rows: AnalyticsRow[] = [];
  for (const [id, bucket] of buckets) {
    const [version, method, route, consumer] = id.split("|");
    if (filter.consumer && consumer !== filter.consumer) continue;
    if (filter.route && !route.includes(filter.route)) continue;
    const sorted = [...bucket.samples].sort((a, b) => a - b);
    rows.push({
      version, method, route, consumer,
      requests: bucket.requests, clientErrors: bucket.clientErrors, serverErrors: bucket.serverErrors,
      errorRate: bucket.requests ? Math.round(((bucket.clientErrors + bucket.serverErrors) / bucket.requests) * 10_000) / 10_000 : 0,
      p50Ms: Math.round(percentile(sorted, 50) * 100) / 100, p95Ms: Math.round(percentile(sorted, 95) * 100) / 100,
      lastSeenIso: bucket.lastSeenIso
    });
  }
  rows.sort((a, b) => b.requests - a.requests);
  const byConsumerMap = new Map<string, number>();
  for (const row of rows) byConsumerMap.set(row.consumer, (byConsumerMap.get(row.consumer) ?? 0) + row.requests);
  return {
    rows,
    totals: { requests: rows.reduce((n, r) => n + r.requests, 0), serverErrors: rows.reduce((n, r) => n + r.serverErrors, 0), clientErrors: rows.reduce((n, r) => n + r.clientErrors, 0) },
    byConsumer: [...byConsumerMap].map(([consumer, requests]) => ({ consumer, requests })).sort((a, b) => b.requests - a.requests)
  };
}

export function resetApiAnalyticsForTests(): void {
  buckets.clear();
}
