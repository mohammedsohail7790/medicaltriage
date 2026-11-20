import { authenticator } from "otplib";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setExternalClientForTests } from "../src/integration/externalClient.js";
import { collectMetrics, metricsAuthorised, prometheusText } from "../src/observability/metrics.js";
import { flushTraces, formatTraceparent, parseTraceparent, recentTraces, resetTracesForTests, setTraceExporterForTests, spansForTrace, toOtlp } from "../src/observability/tracing.js";
import { resetApiAnalyticsForTests, recordApiCall } from "../src/services/apiAnalytics.js";
import { resetClinicalWorkForTests } from "../src/services/clinicalWork.js";
import { DEFAULT_THRESHOLDS, checkPerformance, evaluate, getThresholds, setThresholds } from "../src/services/performanceMonitor.js";
import { buildReport, sendMetricsReport } from "../src/services/metricsReport.js";
import { clearSubscribersForTests, subscribe } from "../src/services/eventBus.js";
import { setResourceStatusForTests } from "../src/services/resourceGuard.js";
import { runSyntheticChecks } from "../src/services/syntheticChecks.js";
import { computeInsights, maskUser } from "../src/services/usageInsights.js";
import { confirmMfaEnrollment, enrollMfa, resetSecurityStoreForTests } from "../src/services/securityAdmin.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import type { AuditEvent } from "../src/types/security.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";

describe("NFR-101 tracing", () => {
  beforeEach(() => resetTracesForTests());
  afterEach(() => { delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT; setTraceExporterForTests(undefined); setExternalClientForTests(undefined); });

  it("continues an incoming W3C trace and answers with the same trace id", async () => {
    const app = createApp();
    const incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const res = await request(app).get("/api/v1/runtime/environment").set("traceparent", incoming).expect(200);
    const out = parseTraceparent(res.headers.traceparent as string)!;
    expect(out.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    const spans = spansForTrace(out.traceId);
    expect(spans[0]).toMatchObject({ kind: "server", parentSpanId: "00f067aa0ba902b7", name: "GET /api/v1/runtime/environment" });
    expect(spans[0].attributes["http.status_code"]).toBe(200);
  });

  it("starts a trace when none arrives, and refuses a malformed header", async () => {
    const app = createApp();
    const res = await request(app).get("/api/v1/runtime/environment").set("traceparent", "garbage").expect(200);
    expect(parseTraceparent(res.headers.traceparent as string)?.traceId).toHaveLength(32);
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeUndefined();
    expect(parseTraceparent(formatTraceparent({ traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: true }))?.sampled).toBe(true);
  });

  it("lists recent traces and exports spans as OTLP to a collector when one is configured", async () => {
    const app = createApp();
    await request(app).get("/api/v1/runtime/environment").expect(200);
    expect(recentTraces(5)[0]).toMatchObject({ root: "GET /api/v1/runtime/environment", errors: 0 });
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://collector.example:4318";
    await request(app).get("/api/v1/runtime/environment").expect(200);
    const sent: Array<{ url: string; body: string }> = [];
    setTraceExporterForTests(async (url, body) => { sent.push({ url, body }); });
    expect(await flushTraces()).toBeGreaterThan(0);
    expect(sent[0].url).toBe("https://collector.example:4318/v1/traces");
    const otlp = JSON.parse(sent[0].body);
    expect(otlp.resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({ kind: 2, name: "GET /api/v1/runtime/environment" });
    expect(toOtlp([]).resourceSpans[0].resource.attributes[0].key).toBe("service.name");
  });
});

describe("NFR-131 / NFR-110 metrics", () => {
  beforeEach(resetApiAnalyticsForTests);

  it("describes requests, latency, resources and jobs in Prometheus text", async () => {
    for (let i = 0; i < 10; i += 1) recordApiCall({ version: "v1", method: "GET", route: "/api/v1/queue", consumer: "interactive" }, i === 9 ? 500 : 200, 40 + i);
    const text = await prometheusText();
    expect(text).toContain('aimltriage_http_requests_total{version="v1",method="GET",route="/api/v1/queue",class="5xx"} 1');
    expect(text).toContain("aimltriage_http_request_duration_ms");
    expect(text).toContain("aimltriage_event_loop_lag_ms");
    expect(text).toContain("aimltriage_process_uptime_seconds");
    expect((await collectMetrics()).routes[0]).toMatchObject({ requests: 10, serverErrors: 1 });
  });

  it("is absent without a token, and bearer-protected with one", async () => {
    const app = createApp();
    delete process.env.METRICS_TOKEN;
    await request(app).get("/metrics").expect(404);
    process.env.METRICS_TOKEN = "scrape-token-123";
    try {
      await request(app).get("/metrics").expect(401);
      await request(app).get("/metrics").set("Authorization", "Bearer wrong-token-xyz").expect(401);
      const ok = await request(app).get("/metrics").set("Authorization", "Bearer scrape-token-123").expect(200);
      expect(ok.text).toContain("aimltriage_resource_constrained");
    } finally {
      delete process.env.METRICS_TOKEN;
    }
    expect(metricsAuthorised(undefined, {} as never)).toBe("disabled");
  });
});

describe("NFR-132 alerts when performance dips", () => {
  beforeEach(() => { resetApiAnalyticsForTests(); resetClinicalWorkForTests(); clearSubscribersForTests(); setResourceStatusForTests(undefined); });

  it("compares the live picture with the thresholds, ignoring routes with too few requests", () => {
    const rows = (n: number, status: number, ms: number) => { resetApiAnalyticsForTests(); for (let i = 0; i < n; i += 1) recordApiCall({ version: "v1", method: "GET", route: "/slow", consumer: "c" }, status, ms); };
    rows(30, 200, 5000);
    expect(evaluate(DEFAULT_THRESHOLDS).map((f) => f.kind)).toEqual(["latency"]);
    rows(5, 200, 5000);
    expect(evaluate(DEFAULT_THRESHOLDS)).toEqual([]);
    rows(40, 500, 10);
    expect(evaluate(DEFAULT_THRESHOLDS).map((f) => f.kind)).toEqual(["errors"]);
    setResourceStatusForTests({ eventLoopLagMs: 900 });
    expect(evaluate(DEFAULT_THRESHOLDS).some((f) => f.kind === "event_loop")).toBe(true);
  });

  it("publishes a performance.degraded event when something is outside, and nothing when all is well", async () => {
    const seen: string[] = [];
    subscribe({ name: "t", handle: async (e) => { seen.push(e.type); } });
    expect((await checkPerformance()).ok).toBe(true);
    for (let i = 0; i < 30; i += 1) recordApiCall({ version: "v1", method: "POST", route: "/bad", consumer: "c" }, 500, 10);
    expect((await checkPerformance()).ok).toBe(false);
    expect(seen).toEqual(["performance.degraded"]);
  });

  it("keeps administrator-set thresholds", async () => {
    expect(await getThresholds()).toEqual(DEFAULT_THRESHOLDS);
    await setThresholds({ ...DEFAULT_THRESHOLDS, p95Ms: 500 }, "usr");
    expect((await getThresholds()).p95Ms).toBe(500);
  });
});

describe("NFR-115 usage insights", () => {
  const ev = (over: Partial<AuditEvent>): AuditEvent => ({ id: Math.random().toString(), timestampIso: "2026-11-20T09:15:00Z", userId: "usr_nurse_1", activeRole: "remote_triage_nurse", organization: "o", facility: "", department: "Cabin crew", action: "QUEUE_ITEM_CLAIM", module: "Queue", resource: "x", ipAddress: "", device: "", success: true, risk: "low", ...over });

  it("counts by user, role, department, feature, errors and peak time, with users masked", () => {
    const events = [ev({}), ev({}), ev({ userId: "usr_nurse_2", success: false, action: "FAILED_LOGIN", module: "Authentication", timestampIso: "2026-11-21T14:00:00Z" }), ev({ activeRole: "triage_service_manager", department: "Operations", userId: "usr_mgr" })];
    const i = computeInsights(events);
    expect(i.window.events).toBe(4);
    expect(i.users.total).toBe(3);
    expect(i.users.top[0].user).toBe(maskUser("usr_nurse_1"));
    expect(i.users.top[0].user).not.toContain("nurse_1");
    expect(i.byRole).toMatchObject({ remote_triage_nurse: 3, triage_service_manager: 1 });
    expect(i.byDepartment["Cabin crew"]).toBe(3);
    expect(i.errors).toMatchObject({ total: 1, rate: 0.25 });
    expect(i.errors.topActions[0]).toEqual({ action: "FAILED_LOGIN", count: 1 });
    expect(i.peakHours[0].hourUtc).toBe(9);
    expect(i.daily).toHaveLength(2);
    expect(computeInsights(events, { revealUsers: true }).users.top[0].user).toBe("usr_nurse_1");
    expect(computeInsights(events, { sinceIso: "2026-11-21T00:00:00Z" }).window.events).toBe(1);
  });
});

describe("NFR-106 synthetic transactions and NFR-105 reports", () => {
  it("runs the critical flows with invented data and reports each", async () => {
    const out = await runSyntheticChecks();
    expect(out.results.map((r) => r.name)).toEqual(expect.arrayContaining(["bilingual note compiles", "referral letter renders as a PDF"]));
    expect(out.ok).toBe(true);
    const failing = await runSyntheticChecks([{ name: "always fails", run: async () => { throw new Error("nope"); } }]);
    expect(failing.ok).toBe(false);
    expect(failing.results.at(-1)).toMatchObject({ ok: false, detail: "nope" });
  });

  it("emails a summary only to approved domains", async () => {
    delete process.env.REPORT_ALLOWED_RECIPIENT_DOMAINS;
    await expect(sendMetricsReport({ to: ["a@x.example"], report: "usage" })).rejects.toThrow(/approved domain/);
    process.env.REPORT_ALLOWED_RECIPIENT_DOMAINS = "ops.example";
    try {
      const out = await sendMetricsReport({ to: ["a@ops.example", "b@other.example"], report: "performance" });
      expect(out).toEqual({ sent: 1, skipped: ["b@other.example"] });
      expect((await buildReport("usage")).body).toContain("Active users");
    } finally {
      delete process.env.REPORT_ALLOWED_RECIPIENT_DOMAINS;
    }
  });
});

describe("admin monitoring routes", () => {
  const app = createApp();
  beforeEach(() => { resetSecurityStoreForTests(); resetRateLimitBucketsForTests(); resetClinicalWorkForTests(); });
  async function elevated() {
    const agent = request.agent(app);
    await agent.post("/api/v1/auth/login").send({ username: "rishma@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);
    const { secret } = enrollMfa("usr_platform_admin_10001");
    confirmMfaEnrollment("usr_platform_admin_10001", authenticator.generate(secret));
    await agent.post("/api/v1/admin/elevate").send({ code: authenticator.generate(secret) }).expect(200);
    return agent;
  }

  it("serves metrics, traces, thresholds, usage insights (masked) and synthetic checks to administrators", async () => {
    const a = await elevated();
    expect((await a.get("/api/v1/admin/ops/metrics").expect(200)).body.resources).toBeDefined();
    expect((await a.get("/api/v1/admin/ops/traces").expect(200)).body.traces).toBeDefined();
    const t = (await a.get("/api/v1/admin/ops/thresholds").expect(200)).body;
    expect(t.thresholds.p95Ms).toBe(2000);
    await a.put("/api/v1/admin/ops/thresholds").send({ ...t.thresholds, p95Ms: 800 }).expect(200);
    await a.put("/api/v1/admin/ops/thresholds").send({ p95Ms: 1 }).expect(400);
    expect((await a.get("/api/v1/admin/ops/usage-insights").expect(200)).body.usersMasked).toBe(true);
    expect((await a.post("/api/v1/admin/ops/synthetic").expect(200)).body.ok).toBe(true);
  });

  it("is closed to nurses", async () => {
    const nurse = request.agent(app);
    await nurse.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
    await nurse.get("/api/v1/admin/ops/metrics").expect(403);
    await nurse.get("/api/v1/admin/ops/usage-insights").expect(403);
  });
});

import { LogStreamer, classify, parseLogSinks } from "../src/observability/logStream.js";

describe("NFR-167 log streaming to a SIEM", () => {
  const sink = { name: "siem", url: "https://siem.example/ingest" };
  const secret = () => "log-secret-for-tests";

  it("classes lines as security or application, and only accepts https collectors", () => {
    expect(classify({ type: "failed_login" })).toBe("security");
    expect(classify({ type: "request_duration" })).toBe("application");
    expect(parseLogSinks(undefined)).toEqual([]);
    expect(() => parseLogSinks('[{"name":"x","url":"http://insecure"}]')).toThrow(/https/);
    expect(() => parseLogSinks("{}")).toThrow(/array/);
  });

  it("sends signed batches of structured lines and counts them", async () => {
    const received: Array<{ body: string; signature: string }> = [];
    const streamer = new LogStreamer([sink], async (_s, body, signature) => { received.push({ body, signature }); return true; }, { batchSize: 2, secret });
    for (const type of ["request_duration", "failed_login", "route_not_found"]) streamer.push({ type });
    await streamer.flush();
    expect(received).toHaveLength(2);
    expect(JSON.parse(received[0].body).events.map((e: { stream: string }) => e.stream)).toEqual(["application", "security"]);
    expect(received[0].signature).toMatch(/^[0-9a-f]{64}$/);
    expect(streamer.statistics()).toMatchObject({ sent: 3, failed: 0, buffered: 0 });
  });

  it("keeps lines for another try when a collector is down, and never grows without bound", async () => {
    let up = false;
    const streamer = new LogStreamer([sink], async () => up, { maxBuffer: 5, secret });
    for (let i = 0; i < 9; i += 1) streamer.push({ type: "x", i });
    expect(streamer.statistics()).toMatchObject({ buffered: 5, dropped: 4 });
    await streamer.flush();
    expect(streamer.statistics()).toMatchObject({ failed: 5, buffered: 5 });
    up = true;
    await streamer.flush();
    expect(streamer.statistics()).toMatchObject({ sent: 5, buffered: 0 });
  });

  it("does nothing with no collector configured", () => {
    const streamer = new LogStreamer([], async () => true);
    streamer.push({ type: "x" });
    expect(streamer.enabled).toBe(false);
    expect(streamer.buffered).toBe(0);
  });
});
