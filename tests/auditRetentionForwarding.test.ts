import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AuditForwarder,
  createSink,
  parseAuditSinkConfig,
  signAuditPayload,
  type AuditSink,
  type ForwardedAuditEvent
} from "../src/services/auditForwarding.js";
import { resetSecretProvider } from "../src/config/secrets.js";
import { assertRuntimeConfiguration } from "../src/config/runtime.js";
import { auditEventsEligibleBefore, auditRetentionPolicy } from "../src/services/retentionGovernance.js";

const event: ForwardedAuditEvent = {
  id: "e1",
  timestampIso: "2026-11-19T00:00:00.000Z",
  userId: "u1",
  activeRole: "nurse",
  organization: "org",
  facility: "",
  department: "",
  action: "QUEUE_ITEM_CLAIM",
  module: "Queue",
  resource: "TriageQueueItem",
  ipAddress: "",
  device: "",
  success: true,
  risk: "low",
  sequenceNumber: "42",
  previousHash: "a".repeat(64),
  eventHash: "b".repeat(64),
  keyVersion: "v1"
};

describe("M-008 audit retention", () => {
  it("keeps audit events for the life of the contract by default", () => {
    const policy = auditRetentionPolicy({});
    expect(policy.mode).toBe("contract-life");
    expect(auditEventsEligibleBefore(policy)).toBeNull();
  });

  it("applies another period only when one is configured", () => {
    const policy = auditRetentionPolicy({ AUDIT_RETENTION_DAYS: "2555" });
    expect(policy).toMatchObject({ mode: "fixed-days", days: 2555 });
    const now = new Date("2026-11-19T00:00:00.000Z");
    expect(auditEventsEligibleBefore(policy, now)?.toISOString()).toBe(new Date(now.getTime() - 2555 * 86400000).toISOString());
  });

  it.each(["0", "-5", "abc", "1.5", "30 days"])("rejects an invalid period (%s)", (value) => {
    expect(() => auditRetentionPolicy({ AUDIT_RETENTION_DAYS: value })).toThrow(/AUDIT_RETENTION_DAYS/);
  });

  it("has no code path that deletes audit events", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts") && !path.endsWith("pr010Soc2LiveVerify.ts")) {
          const text = readFileSync(path, "utf8");
          if (/auditEvent\.(delete|deleteMany|update|updateMany)\b/.test(text) || /DELETE\s+FROM\s+"?audit_events"?/i.test(text) || /TRUNCATE\s+"?audit_events"?/i.test(text)) {
            offenders.push(path);
          }
        }
      }
    };
    walk(join(__dirname, "..", "src"));
    expect(offenders).toEqual([]);
  });
});

describe("M-008 audit forwarding", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    resetSecretProvider();
  });

  it("parses sinks and rejects malformed configuration", () => {
    expect(parseAuditSinkConfig(undefined)).toEqual([]);
    expect(parseAuditSinkConfig('[{"name":"siem","type":"https","url":"https://siem.example/audit"},{"name":"logs","type":"stdout"}]')).toHaveLength(2);
    expect(() => parseAuditSinkConfig("not json")).toThrow(/valid JSON/);
    expect(() => parseAuditSinkConfig('{"a":1}')).toThrow(/array/);
    expect(() => parseAuditSinkConfig('[{"type":"stdout"}]')).toThrow(/name/);
    expect(() => parseAuditSinkConfig('[{"name":"a","type":"stdout"},{"name":"a","type":"stdout"}]')).toThrow(/duplicate/);
    expect(() => parseAuditSinkConfig('[{"name":"a","type":"ftp"}]')).toThrow(/unsupported/);
  });

  it("requires https outside local development", () => {
    expect(() => parseAuditSinkConfig('[{"name":"a","type":"https","url":"http://siem.example"}]', true)).toThrow(/https/);
    expect(() => parseAuditSinkConfig('[{"name":"a","type":"https","url":"http://localhost:9000"}]', true)).toThrow(/https/);
    expect(parseAuditSinkConfig('[{"name":"a","type":"https","url":"http://localhost:9000"}]', false)).toHaveLength(1);
  });

  it("posts a signed body to an https sink", async () => {
    process.env.AUDIT_FORWARD_SECRET = "forward-secret-for-test";
    process.env.NODE_ENV = "test";
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const sink = createSink({ name: "siem", type: "https", url: "https://siem.example/audit" }, async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { ok: true, status: 200 };
    });
    await sink.send([event]);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body).events[0].eventHash).toBe(event.eventHash);
    expect(calls[0].headers["x-audit-signature"]).toBe(signAuditPayload(calls[0].body, "forward-secret-for-test"));
  });

  it("retries a failing sink and then delivers", async () => {
    let attempts = 0;
    const flaky: AuditSink = {
      name: "flaky",
      async send() {
        attempts += 1;
        if (attempts < 3) throw new Error("temporarily down");
      }
    };
    const forwarder = new AuditForwarder([flaky], { sleep: async () => undefined });
    await forwarder.forward([event]);
    expect(attempts).toBe(3);
    expect(forwarder.statistics().flaky).toMatchObject({ forwarded: 1, failed: 0 });
  });

  it("never throws when a sink is permanently down, and still serves the healthy sink", async () => {
    const delivered: string[] = [];
    const down: AuditSink = { name: "down", send: async () => { throw new Error("unreachable"); } };
    const up: AuditSink = { name: "up", send: async (events) => { delivered.push(...events.map((e) => e.sequenceNumber)); } };
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const forwarder = new AuditForwarder([down, up], { attempts: 2, sleep: async () => undefined });
    await expect(forwarder.forward([event])).resolves.toBeUndefined();
    expect(delivered).toEqual(["42"]);
    expect(forwarder.statistics().down).toMatchObject({ forwarded: 0, failed: 1, lastError: "unreachable" });
    errors.mockRestore();
  });

  it("fails startup in production when an https sink has no signing secret", () => {
    process.env.NODE_ENV = "production";
    process.env.AUTH_JWT_SECRET = "jwt-secret-for-test-run-1234";
    process.env.MFA_ENCRYPTION_KEY = "mfa-key-for-test-run-123456";
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.AUDIT_DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.AUDIT_HMAC_SECRET = "audit-hmac-secret-for-test-run";
    process.env.AUDIT_FORWARD_SINKS = '[{"name":"siem","type":"https","url":"https://siem.example/audit"}]';
    delete process.env.AUDIT_FORWARD_SECRET;
    expect(() => assertRuntimeConfiguration()).toThrow(/AUDIT_FORWARD_SECRET/);
  });

  it("fails startup on a malformed retention period", () => {
    process.env.AUDIT_RETENTION_DAYS = "forever";
    expect(() => assertRuntimeConfiguration()).toThrow(/AUDIT_RETENTION_DAYS/);
  });
});
