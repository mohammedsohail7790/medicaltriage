import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import {
  authenticateLocal,
  listAuditEvents,
  resetSecurityStoreForTests,
  sameNetworkRange,
  sessionIpBinding,
  validateSessionContext,
  viewportClassFrom
} from "../src/services/securityAdmin.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
const app = createApp();

async function openSession(ip = "10.0.0.1", ua = "TestBrowser/1.0") {
  const result = await authenticateLocal({ username: "layla@irisstar.tech", password: "Layla@2026", rememberMe: false, simulateRole: "remote_triage_nurse", ipAddress: ip, device: ua });
  if (!result.ok || "mfaRequired" in result) throw new Error("Expected an immediate session");
  return result.session;
}

describe("NFR-148 session context binding", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    resetSecurityStoreForTests();
    resetRateLimitBucketsForTests();
  });
  afterEach(() => {
    process.env = { ...originalEnv, ADMIN_PASSWORD: "TestAdminPassword!2026" };
  });

  describe("helpers", () => {
    it("compares network ranges for IPv4, IPv6 and mapped addresses", () => {
      expect(sameNetworkRange("10.1.2.3", "10.1.2.200")).toBe(true);
      expect(sameNetworkRange("10.1.2.3", "10.1.3.3")).toBe(false);
      expect(sameNetworkRange("::ffff:10.1.2.3", "10.1.2.9")).toBe(true);
      expect(sameNetworkRange("2001:db8:1:2::1", "2001:db8:1:2:ffff::9")).toBe(true);
      expect(sameNetworkRange("2001:db8:1:2::1", "2001:db8:1:3::1")).toBe(false);
    });

    it("classifies the viewport and ignores malformed values", () => {
      expect(viewportClassFrom("390x844")).toBe("phone");
      expect(viewportClassFrom("820x1180")).toBe("tablet");
      expect(viewportClassFrom("1440x900")).toBe("desktop");
      expect(viewportClassFrom("wide")).toBeUndefined();
      expect(viewportClassFrom(undefined)).toBeUndefined();
    });

    it("rejects on address only when the proxy chain is configured (or asked for)", () => {
      delete process.env.SESSION_IP_BINDING;
      delete process.env.TRUST_PROXY_HOPS;
      expect(sessionIpBinding()).toBe("audit");
      process.env.TRUST_PROXY_HOPS = "2";
      expect(sessionIpBinding()).toBe("range");
      process.env.SESSION_IP_BINDING = "exact";
      expect(sessionIpBinding()).toBe("exact");
      process.env.SESSION_IP_BINDING = "nonsense";
      expect(sessionIpBinding()).toBe("range");
    });
  });

  describe("validation", () => {
    beforeEach(() => {
      process.env.SESSION_IP_BINDING = "range";
    });

    it("accepts the same context and a move inside the network range, and records the move", async () => {
      const session = await openSession();
      expect(await validateSessionContext(session.sessionId, "10.0.0.1", "TestBrowser/1.0")).toBe("ok");
      expect(await validateSessionContext(session.sessionId, "10.0.0.77", "TestBrowser/1.0")).toBe("ip-changed");
      expect(listAuditEvents().some((e) => e.action === "SESSION_IP_CHANGED" && e.resource === session.sessionId)).toBe(true);
    });

    it("rejects a request from another network range and raises an alert", async () => {
      const session = await openSession();
      expect(await validateSessionContext(session.sessionId, "203.0.113.9", "TestBrowser/1.0")).toBe("ip-range-mismatch");
      const alert = listAuditEvents().find((e) => e.action === "SESSION_CONTEXT_MISMATCH" && e.resource === session.sessionId);
      expect(alert).toMatchObject({ success: false, risk: "high", userId: session.user.id });
      // The genuine context still works.
      expect(await validateSessionContext(session.sessionId, "10.0.0.1", "TestBrowser/1.0")).toBe("ok");
    });

    it("rejects a different User-Agent and raises an alert", async () => {
      const session = await openSession();
      expect(await validateSessionContext(session.sessionId, "10.0.0.1", "Other/2.0")).toBe("user-agent-mismatch");
      expect(listAuditEvents().filter((e) => e.action === "SESSION_CONTEXT_MISMATCH" && e.resource === session.sessionId)).toHaveLength(1);
    });

    it("exact mode rejects any address change; off mode ignores it", async () => {
      process.env.SESSION_IP_BINDING = "exact";
      const exact = await openSession();
      expect(await validateSessionContext(exact.sessionId, "10.0.0.2", "TestBrowser/1.0")).toBe("ip-range-mismatch");
      process.env.SESSION_IP_BINDING = "off";
      const off = await openSession();
      expect(await validateSessionContext(off.sessionId, "203.0.113.9", "TestBrowser/1.0")).toBe("ok");
    });

    it("treats a change of device class as a signal, not a rejection", async () => {
      const session = await openSession();
      expect(await validateSessionContext(session.sessionId, "10.0.0.1", "TestBrowser/1.0", "1440x900")).toBe("ok");
      expect(await validateSessionContext(session.sessionId, "10.0.0.1", "TestBrowser/1.0", "1300x800")).toBe("ok");
      expect(listAuditEvents().some((e) => e.action === "SESSION_VIEWPORT_CHANGED" && e.resource === session.sessionId)).toBe(false);
      expect(await validateSessionContext(session.sessionId, "10.0.0.1", "TestBrowser/1.0", "390x844")).toBe("ok");
      expect(listAuditEvents().some((e) => e.action === "SESSION_VIEWPORT_CHANGED" && e.resource === session.sessionId)).toBe(true);
    });
  });

  describe("over HTTP", () => {
    it("rejects a stolen cookie and a stolen session token used from another client", async () => {
      const login = await request(app).post("/api/v1/auth/login").set("User-Agent", "TestBrowser/1.0").send({ username: "layla@irisstar.tech", password: "Layla@2026", simulateRole: "remote_triage_nurse" }).expect(200);
      const cookie = login.headers["set-cookie"];
      const token = login.body.accessToken as string;

      await request(app).get("/api/v1/queue").set("Cookie", cookie).set("User-Agent", "TestBrowser/1.0").expect(200);
      await request(app).get("/api/v1/queue").set("Authorization", `Bearer ${token}`).set("User-Agent", "TestBrowser/1.0").expect(200);

      const byCookie = await request(app).get("/api/v1/queue").set("Cookie", cookie).set("User-Agent", "Stolen/1.0").expect(401);
      expect(byCookie.body.code).toBe("SESSION_CONTEXT_MISMATCH");
      const byToken = await request(app).get("/api/v1/queue").set("Authorization", `Bearer ${token}`).set("User-Agent", "Stolen/1.0").expect(401);
      expect(byToken.body.code).toBe("SESSION_CONTEXT_MISMATCH");
      expect(listAuditEvents().filter((e) => e.action === "SESSION_CONTEXT_MISMATCH").length).toBeGreaterThanOrEqual(2);
    });
  });
});
