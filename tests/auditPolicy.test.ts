import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { assertRuntimeConfiguration } from "../src/config/runtime.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { auditPolicyStatement, recordAuditConfigurationState } from "../src/services/auditPolicy.js";
import { listAuditEvents, resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
const app = createApp();

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("NFR-011 auditing cannot be disabled", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv, ADMIN_PASSWORD: "TestAdminPassword!2026" };
  });

  it("has no setting anywhere in the code that turns auditing off", () => {
    const offenders: string[] = [];
    const pattern = /process\.env\.[A-Z0-9_]*(DISABLE_?AUDIT|SKIP_?AUDIT|NO_?AUDIT|BYPASS_?AUDIT|AUDIT[A-Z0-9_]*(DISABLE|DISABLED|OFF|SKIP|BYPASS))|envFlag\(\s*["'][A-Z0-9_]*(DISABLE_?AUDIT|SKIP_?AUDIT|AUDIT[A-Z0-9_]*(DISABLE|OFF|SKIP|BYPASS))/;
    for (const file of sourceFiles(join(__dirname, "..", "src"))) {
      if (pattern.test(readFileSync(file, "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("refuses to start in production without durable audit storage", () => {
    process.env.NODE_ENV = "production";
    process.env.AUTH_JWT_SECRET = "jwt-secret-for-test-run-1234";
    process.env.MFA_ENCRYPTION_KEY = "mfa-key-for-test-run-123456";
    process.env.FIELD_ENCRYPTION_KEY = "field-key-for-test-run-1234";
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.AUDIT_DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.AUDIT_HMAC_SECRET = "audit-hmac-secret-for-test-run";
    for (const flag of ["QUEUE_DB_PERSISTENCE", "SESSION_DB_PERSISTENCE", "MFA_DB_PERSISTENCE"]) process.env[flag] = "true";
    delete process.env.AUDIT_EVENT_DB_PERSISTENCE;
    expect(() => assertRuntimeConfiguration()).toThrow(/AUDIT_EVENT_DB_PERSISTENCE/);
  });

  it("states the policy: not disableable, what is configurable, how a change is governed", async () => {
    const statement = await auditPolicyStatement();
    expect(statement.auditingCanBeDisabled).toBe(false);
    expect(statement.perDataElementDisable).toBe(false);
    expect(statement.configurable.retention.mode).toBe("contract-life");
    expect(statement.guarantees.join(" ")).toMatch(/append-only/);
    expect(statement.governance.join(" ")).toMatch(/AUDIT_CONFIGURATION_LOADED/);
  });

  it("writes the audit configuration to the ledger", async () => {
    process.env.AUDIT_RETENTION_DAYS = "2555";
    await recordAuditConfigurationState();
    const event = listAuditEvents().filter((e) => e.action === "AUDIT_CONFIGURATION_LOADED").pop();
    expect(event?.metadata).toMatchObject({ state: { retentionMode: "fixed-days", retentionDays: 2555, durableStorage: false } });
  });

  describe("over the API", () => {
    beforeEach(() => {
      resetSecurityStoreForTests();
      resetRateLimitBucketsForTests();
    });

    it("shows the statement to someone who may view audit information, and no one else", async () => {
      const admin = request.agent(app);
      await admin.post("/api/v1/auth/login").send({ username: "rishma@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);
      const response = await admin.get("/api/v1/admin/audit-policy").expect(200);
      expect(response.body.auditingCanBeDisabled).toBe(false);
      const nurse = request.agent(app);
      await nurse.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
      await nurse.get("/api/v1/admin/audit-policy").expect(403);
    });
  });
});
