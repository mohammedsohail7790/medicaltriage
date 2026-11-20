import { timingSafeEqual } from "node:crypto";
import { shouldPersistPlatformInDatabase } from "../config/runtime.js";
import { basePrisma } from "../db.js";
import { apiAnalyticsReport } from "../services/apiAnalytics.js";
import { listRuns } from "../services/jobScheduler.js";
import { resourceStatus } from "../services/resourceGuard.js";

/** Metrics for performance monitoring across the layers (NFR-131, NFR-110): requests, latency, resources, jobs and the database. */

export async function databaseLatencyMs(): Promise<number | null> {
  if (!shouldPersistPlatformInDatabase()) return null;
  const started = Date.now();
  try {
    await basePrisma.$queryRaw`SELECT 1`;
    return Date.now() - started;
  } catch {
    return -1;
  }
}

export async function collectMetrics() {
  const report = apiAnalyticsReport();
  const routes = new Map<string, { version: string; method: string; route: string; requests: number; clientErrors: number; serverErrors: number; p50: number; p95: number }>();
  for (const r of report.rows) {
    const key = `${r.version}|${r.method}|${r.route}`;
    const cur = routes.get(key) ?? { version: r.version, method: r.method, route: r.route, requests: 0, clientErrors: 0, serverErrors: 0, p50: 0, p95: 0 };
    cur.requests += r.requests;
    cur.clientErrors += r.clientErrors;
    cur.serverErrors += r.serverErrors;
    cur.p50 = Math.max(cur.p50, r.p50Ms);
    cur.p95 = Math.max(cur.p95, r.p95Ms);
    routes.set(key, cur);
  }
  const runs = await listRuns(undefined, 500).catch(() => []);
  const jobRuns = runs.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  const memory = process.memoryUsage();
  return { routes: [...routes.values()], resources: resourceStatus(), jobRuns, databaseLatencyMs: await databaseLatencyMs(), process: { uptimeSeconds: Math.round(process.uptime()), rssBytes: memory.rss, heapUsedBytes: memory.heapUsed } };
}

const label = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

export async function prometheusText(): Promise<string> {
  const m = await collectMetrics();
  const lines: string[] = [];
  const metric = (name: string, help: string, type: string) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  metric("aimltriage_http_requests_total", "Requests by route and outcome class.", "counter");
  for (const r of m.routes) {
    const base = `version="${label(r.version)}",method="${r.method}",route="${label(r.route)}"`;
    lines.push(`aimltriage_http_requests_total{${base},class="2xx_3xx"} ${r.requests - r.clientErrors - r.serverErrors}`, `aimltriage_http_requests_total{${base},class="4xx"} ${r.clientErrors}`, `aimltriage_http_requests_total{${base},class="5xx"} ${r.serverErrors}`);
  }
  metric("aimltriage_http_request_duration_ms", "Request latency over the recent window.", "gauge");
  for (const r of m.routes) {
    const base = `version="${label(r.version)}",method="${r.method}",route="${label(r.route)}"`;
    lines.push(`aimltriage_http_request_duration_ms{${base},quantile="0.5"} ${r.p50}`, `aimltriage_http_request_duration_ms{${base},quantile="0.95"} ${r.p95}`);
  }
  metric("aimltriage_event_loop_lag_ms", "Mean event loop delay.", "gauge");
  lines.push(`aimltriage_event_loop_lag_ms ${m.resources.eventLoopLagMs}`);
  metric("aimltriage_heap_used_ratio", "Heap used as a share of the limit.", "gauge");
  lines.push(`aimltriage_heap_used_ratio ${m.resources.heapUsedRatio}`);
  metric("aimltriage_requests_in_flight", "Requests being served now.", "gauge");
  lines.push(`aimltriage_requests_in_flight ${m.resources.activeRequests}`);
  metric("aimltriage_resource_constrained", "1 while non-critical work is being deferred.", "gauge");
  lines.push(`aimltriage_resource_constrained ${m.resources.constrained ? 1 : 0}`);
  metric("aimltriage_job_runs", "Recent scheduled job runs by status.", "gauge");
  for (const [status, n] of Object.entries(m.jobRuns)) lines.push(`aimltriage_job_runs{status="${label(status)}"} ${n}`);
  if (m.databaseLatencyMs !== null) {
    metric("aimltriage_database_latency_ms", "Round trip of a trivial query (-1 when it failed).", "gauge");
    lines.push(`aimltriage_database_latency_ms ${m.databaseLatencyMs}`);
  }
  metric("aimltriage_process_uptime_seconds", "Process uptime.", "gauge");
  lines.push(`aimltriage_process_uptime_seconds ${m.process.uptimeSeconds}`);
  return lines.join("\n") + "\n";
}

/** The scraper presents METRICS_TOKEN as a bearer token. With no token configured the endpoint does not exist. */
export function metricsAuthorised(header: string | undefined, env: NodeJS.ProcessEnv = process.env): "disabled" | "ok" | "denied" {
  const token = env.METRICS_TOKEN;
  if (!token) return "disabled";
  const presented = (header ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "denied";
}
