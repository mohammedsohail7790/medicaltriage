import { z } from "zod";
import { apiAnalyticsReport } from "./apiAnalytics.js";
import { createItem, listItems, updateItem } from "./clinicalWork.js";
import { publishEvent } from "./eventBus.js";
import { resourceStatus } from "./resourceGuard.js";

/**
 * Performance thresholds and the alert raised when service dips below them (NFR132, NFR131, NFR110).
 * Thresholds are configuration set by an administrator (defaults below, agreed values from Qatar Airways replace them).
 * A check compares the live picture with them and, when something is outside, publishes a performance.degraded event;
 * alert rules route that event to a log, an email or a webhook like any other.
 */

export const Thresholds = z.object({
  p95Ms: z.number().int().min(50).max(60_000),
  errorRate: z.number().min(0).max(1),
  eventLoopLagMs: z.number().int().min(10).max(10_000),
  minRequests: z.number().int().min(1).max(100_000)
});
export type ThresholdsType = z.infer<typeof Thresholds>;

export const DEFAULT_THRESHOLDS: ThresholdsType = { p95Ms: 2000, errorRate: 0.05, eventLoopLagMs: 200, minRequests: 20 };
const KEY = "performance_thresholds";

export async function getThresholds(): Promise<ThresholdsType> {
  try {
    const item = (await listItems({ kind: "setting", caseRef: KEY, limit: 1 }))[0];
    const parsed = item ? Thresholds.safeParse(item.payload) : undefined;
    return parsed?.success ? parsed.data : DEFAULT_THRESHOLDS;
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

export async function setThresholds(input: ThresholdsType, userId: string): Promise<{ before: ThresholdsType; after: ThresholdsType }> {
  const before = await getThresholds();
  const current = (await listItems({ kind: "setting", caseRef: KEY, limit: 1 }))[0];
  const payload = { ...input, changedBy: userId, changedAtIso: new Date().toISOString() };
  if (current) await updateItem(current.id, { payload });
  else await createItem({ kind: "setting", status: "active", caseRef: KEY, createdBy: userId, payload });
  return { before, after: input };
}

export type Finding = { kind: "latency" | "errors" | "event_loop"; route?: string; value: number; threshold: number; requests?: number };

export function evaluate(thresholds: ThresholdsType, rows = apiAnalyticsReport().rows, resources = resourceStatus()): Finding[] {
  const byRoute = new Map<string, { requests: number; errors: number; p95: number }>();
  for (const r of rows) {
    const key = `${r.method} ${r.route}`;
    const cur = byRoute.get(key) ?? { requests: 0, errors: 0, p95: 0 };
    cur.requests += r.requests;
    cur.errors += r.serverErrors;
    cur.p95 = Math.max(cur.p95, r.p95Ms);
    byRoute.set(key, cur);
  }
  const findings: Finding[] = [];
  for (const [route, m] of byRoute) {
    if (m.requests < thresholds.minRequests) continue;
    if (m.p95 > thresholds.p95Ms) findings.push({ kind: "latency", route, value: m.p95, threshold: thresholds.p95Ms, requests: m.requests });
    const rate = m.errors / m.requests;
    if (rate > thresholds.errorRate) findings.push({ kind: "errors", route, value: Math.round(rate * 1000) / 1000, threshold: thresholds.errorRate, requests: m.requests });
  }
  if (resources.eventLoopLagMs > thresholds.eventLoopLagMs) findings.push({ kind: "event_loop", value: resources.eventLoopLagMs, threshold: thresholds.eventLoopLagMs });
  return findings;
}

export async function checkPerformance(): Promise<{ ok: boolean; findings: Finding[] }> {
  const findings = evaluate(await getThresholds());
  if (findings.length > 0) {
    await publishEvent({
      id: `perf-${Date.now()}`, type: "performance.degraded", occurredAtIso: new Date().toISOString(), subject: findings[0].route ?? "event-loop", risk: "high", success: false,
      data: { findings: findings.map((f) => ({ kind: f.kind, route: f.route ?? null, value: f.value, threshold: f.threshold })) }
    });
  }
  return { ok: findings.length === 0, findings };
}
