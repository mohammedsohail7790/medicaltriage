import express from "express";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setExternalClientForTests } from "../src/integration/externalClient.js";
import { gatewayGuard } from "../src/middleware/gatewayGuard.js";
import { apiAnalyticsReport, recordApiCall, resetApiAnalyticsForTests } from "../src/services/apiAnalytics.js";
import { buildAsyncApi, buildGatewayDefinition } from "../src/services/gatewayDefinition.js";
import { INTEGRATIONS, integrationRegistry, integrationStatus, isLive, probeIntegration } from "../src/services/integrationRegistry.js";
import { connectedApps, rememberReturn, sanitizeReturnTo, takeReturn } from "../src/services/ssoLinks.js";

const TEST_ADMIN_PASSWORD = "TestAdminPassword!2026";
process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;

describe("NFR-098 gateway guard", () => {
  const env = { GATEWAY_REQUIRED: "true", GATEWAY_SHARED_SECRET: "s3cret-value" } as unknown as NodeJS.ProcessEnv;
  const build = (e: NodeJS.ProcessEnv) => {
    const app = express();
    app.use(gatewayGuard(e));
    app.get("/api/ping", (_req, res) => res.json({ ok: true }));
    app.get("/healthz", (_req, res) => res.json({ ok: true }));
    return app;
  };

  it("refuses direct traffic and wrong secrets, admits the gateway and health probes", async () => {
    await request(build(env)).get("/api/ping").expect(403);
    await request(build(env)).get("/api/ping").set("x-gateway-secret", "wrong-value!").expect(403);
    await request(build(env)).get("/api/ping").set("x-gateway-secret", "s3cret-value").expect(200);
    await request(build(env)).get("/healthz").expect(200);
  });

  it("is off unless required, and fails closed when no secret is configured", async () => {
    await request(build({} as NodeJS.ProcessEnv)).get("/api/ping").expect(200);
    await request(build({ GATEWAY_REQUIRED: "true" } as NodeJS.ProcessEnv)).get("/api/ping").set("x-gateway-secret", "x").expect(403);
  });

  it("publishes a gateway definition and an event catalogue", () => {
    const def = buildGatewayDefinition({ paths: { "/api/v1/x": { get: { security: [{ bearerAuth: [] }] }, post: { requestBody: {} } } } }, "https://backend");
    expect(def.operations).toEqual([
      { method: "GET", path: "/api/v1/x", authenticated: true, hasRequestSchema: false },
      { method: "POST", path: "/api/v1/x", authenticated: false, hasRequestSchema: true }
    ]);
    const asyncApi = buildAsyncApi("1.0.0");
    expect(Object.keys(asyncApi.channels)).toEqual(expect.arrayContaining(["queue.item.created", "audit.{action}"]));
  });
});

describe("NFR-008 API analytics", () => {
  beforeEach(resetApiAnalyticsForTests);

  it("aggregates requests, errors and latency per route and consumer", () => {
    for (let i = 1; i <= 100; i += 1) recordApiCall({ version: "v1", method: "GET", route: "/api/v1/queue", consumer: "cl_a" }, i === 100 ? 500 : i % 10 === 0 ? 404 : 200, i);
    recordApiCall({ version: "v2", method: "GET", route: "/api/v1/queue", consumer: "interactive" }, 200, 5);
    const report = apiAnalyticsReport();
    const row = report.rows.find((r) => r.consumer === "cl_a")!;
    expect(row).toMatchObject({ requests: 100, serverErrors: 1, clientErrors: 9, errorRate: 0.1 });
    expect(row.p50Ms).toBeGreaterThan(40);
    expect(row.p95Ms).toBeGreaterThan(90);
    expect(report.totals.requests).toBe(101);
    expect(apiAnalyticsReport({ consumer: "interactive" }).rows).toHaveLength(1);
  });

  it("records real traffic by route template, version and consumer, and exposes it only to auditors", async () => {
    const app = createApp();
    await request(app).get("/api/v2/runtime/environment").expect(200);
    await request(app).get("/api/v1/admin/integrations/api-analytics").expect(401);
    const agent = request.agent(app);
    await agent.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: TEST_ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
    await agent.get("/api/v1/admin/integrations/api-analytics").expect(403);
    const seen = apiAnalyticsReport().rows.find((r) => r.route === "/api/v1/runtime/environment");
    expect(seen).toMatchObject({ version: "v2", consumer: "anonymous", requests: 1 });
  });
});

describe("NFR-090 integration registry", () => {
  it("is a dry run unless configured and explicitly set live", () => {
    const qhie = INTEGRATIONS.find((i) => i.name === "qhie")!;
    expect(integrationStatus(qhie, {} as NodeJS.ProcessEnv)).toMatchObject({ configured: false, mode: "dry-run" });
    const configured = { QHIE_BASE_URL: "https://q", QHIE_ACCESS_TOKEN: "t" } as unknown as NodeJS.ProcessEnv;
    expect(integrationStatus(qhie, configured)).toMatchObject({ configured: true, mode: "dry-run", canProbe: true });
    expect(integrationStatus(qhie, { ...configured, INTEGRATION_QHIE_MODE: "live" } as NodeJS.ProcessEnv).mode).toBe("live");
    expect(integrationStatus(qhie, { INTEGRATION_QHIE_MODE: "live" } as NodeJS.ProcessEnv).mode).toBe("dry-run");
    expect(isLive("nope")).toBe(false);
    expect(integrationRegistry().length).toBe(INTEGRATIONS.length);
  });

  it("tests connectivity without retries and reports unreachable systems", async () => {
    setExternalClientForTests({ fetch: async () => new Response("ok", { status: 200 }) });
    const env = { QHIE_BASE_URL: "https://q.example", QHIE_ACCESS_TOKEN: "t" } as unknown as NodeJS.ProcessEnv;
    await expect(probeIntegration("qhie", env)).resolves.toMatchObject({ reachable: true, httpStatus: 200 });
    setExternalClientForTests({ fetch: async () => { throw new Error("connect ECONNREFUSED"); } });
    await expect(probeIntegration("qhie", env)).resolves.toMatchObject({ reachable: false });
    await expect(probeIntegration("qhie", {} as NodeJS.ProcessEnv)).rejects.toThrow(/not configured/);
    await expect(probeIntegration("nope", env)).rejects.toThrow(/Unknown/);
    setExternalClientForTests(undefined);
  });
});

describe("NFR-019 SSO deep links", () => {
  const env = { SSO_ALLOWED_RETURN_HOSTS: "apps.example.com" } as unknown as NodeJS.ProcessEnv;

  it("accepts only local paths and explicitly allowed https hosts", () => {
    expect(sanitizeReturnTo("/queue/case-1?tab=vitals", env)).toBe("/queue/case-1?tab=vitals");
    expect(sanitizeReturnTo("https://apps.example.com/x", env)).toBe("https://apps.example.com/x");
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example/", "http://apps.example.com/", "javascript:alert(1)", "https://user:pw@apps.example.com/", "", undefined, 5, "/a\nb"]) {
      expect(sanitizeReturnTo(bad, env)).toBeUndefined();
    }
  });

  it("returns the remembered link once, for the matching state only", () => {
    rememberReturn("state-1", "/queue/case-1");
    expect(takeReturn("state-2")).toBeUndefined();
    expect(takeReturn("state-1")).toBe("/queue/case-1");
    expect(takeReturn("state-1")).toBeUndefined();
    rememberReturn("old", "/x", Date.now() - 3_600_000);
    expect(takeReturn("old")).toBeUndefined();
  });

  it("lists connected applications from configuration, https only", () => {
    const apps = connectedApps({ SSO_CONNECTED_APPS: JSON.stringify([{ id: "hr", name: "HR portal", launchUrl: "https://hr.example.com/sso" }, { id: "bad", name: "Bad", launchUrl: "http://x" }, { id: "x" }]) } as unknown as NodeJS.ProcessEnv);
    expect(apps).toEqual([{ id: "hr", name: "HR portal", launchUrl: "https://hr.example.com/sso" }]);
    expect(connectedApps({ SSO_CONNECTED_APPS: "not json" } as unknown as NodeJS.ProcessEnv)).toEqual([]);
  });
});
