import type { Application } from "express";
import request from "supertest";

// NFR-145: configurable inactivity timeout with re-authentication.
// The timeout is read when the session store loads, so it is set before the app is imported.
process.env.SESSION_IDLE_TIMEOUT_MINUTES = "0.004"; // 240 ms
process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";

let app: Application;
let listAuditEvents: typeof import("../src/services/securityAdmin.js").listAuditEvents;
let resetSecurityStoreForTests: typeof import("../src/services/securityAdmin.js").resetSecurityStoreForTests;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function signedIn() {
  const agent = request.agent(app);
  await agent.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
  return agent;
}

describe("NFR-145 inactivity timeout", () => {
  beforeAll(async () => {
    app = (await import("../src/app.js")).createApp();
    ({ listAuditEvents, resetSecurityStoreForTests } = await import("../src/services/securityAdmin.js"));
  });
  beforeEach(async () => {
    resetSecurityStoreForTests();
    (await import("../src/middleware/rateLimit.js")).resetRateLimitBucketsForTests();
  });

  it("keeps a session that is in use and reports the timeout to the client", async () => {
    const agent = await signedIn();
    const response = await agent.get("/api/v1/auth/session").expect(200);
    expect(response.body.idleTimeoutSeconds).toBe(Math.round(0.004 * 60));
  });

  it("ends a session after the idle period and tells the user why", async () => {
    const agent = await signedIn();
    await agent.get("/api/v1/auth/session").expect(200);
    await sleep(400);
    const ended = await agent.get("/api/v1/queue").expect(401);
    expect(ended.body.code).toBe("SESSION_IDLE_TIMEOUT");
    expect(listAuditEvents().some((event) => event.action === "SESSION_IDLE_TIMEOUT")).toBe(true);
    // The session is gone for good: it must be re-established by signing in again.
    await agent.get("/api/v1/auth/session").expect(401);
  });

  it("is not kept alive by background polling (reads)", async () => {
    const agent = await signedIn();
    for (let i = 0; i < 8; i += 1) {
      await sleep(60);
      await agent.get("/api/v1/auth/session");
    }
    await agent.get("/api/v1/auth/session").expect(401);
  });

  it("is kept alive by activity pings while the user is working", async () => {
    const agent = await signedIn();
    for (let i = 0; i < 8; i += 1) {
      await sleep(60);
      await agent.post("/api/v1/auth/activity").expect(204);
    }
    await agent.get("/api/v1/auth/session").expect(200);
  });

  it("requires signing in again after a timeout", async () => {
    const agent = await signedIn();
    await sleep(400);
    await agent.get("/api/v1/auth/session").expect(401);
    const again = await agent.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
    expect(again.body.session ?? again.body).toBeDefined();
    await agent.get("/api/v1/auth/session").expect(200);
  });

  it("defaults to 15 minutes", () => {
    jest.isolateModules(() => {
      delete process.env.SESSION_IDLE_TIMEOUT_MINUTES;
      const { sessionIdleTimeoutMs } = require("../src/config/sessionPolicy.js") as typeof import("../src/config/sessionPolicy.js");
      expect(sessionIdleTimeoutMs()).toBe(15 * 60 * 1000);
      process.env.SESSION_IDLE_TIMEOUT_MINUTES = "5";
      expect(sessionIdleTimeoutMs()).toBe(5 * 60 * 1000);
      process.env.SESSION_IDLE_TIMEOUT_MINUTES = "-3";
      expect(sessionIdleTimeoutMs()).toBe(15 * 60 * 1000);
    });
  });
});
