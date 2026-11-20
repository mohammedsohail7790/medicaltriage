import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { InfrastructureConfigurationError, breakGlassUsers, databaseTransportProblems, localLoginAllowed, residencyProblems, ssoEnforced, validateInfrastructureConfiguration } from "../src/config/infrastructureGuards.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { checkSecretRotation, rotationReport } from "../src/services/secretRotation.js";
import { clearSubscribersForTests, subscribe } from "../src/services/eventBus.js";
import { resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
const env = (over: Record<string, string>) => ({ NODE_ENV: "production", ...over }) as unknown as NodeJS.ProcessEnv;

describe("data residency (M-028, NFR-063, NFR-087, NFR-088, NFR-089)", () => {
  it("accepts regions on the approved list and rejects any other, for data, backups, DR, logs and keys", () => {
    expect(residencyProblems(env({ APPROVED_DATA_REGIONS: "me-central1", DATA_REGION: "me-central1", DR_REGION: "me-central1" }))).toEqual([]);
    expect(residencyProblems(env({ APPROVED_DATA_REGIONS: "me-central1", DATA_REGION: "europe-west1" }))).toEqual(["DATA_REGION names a region that is not approved."]);
    expect(residencyProblems(env({ APPROVED_DATA_REGIONS: "me-central1,me-central2", DR_REGION: "us-east1", BACKUP_REGION: "me-central2" }))).toEqual(["DR_REGION names a region that is not approved."]);
    expect(residencyProblems(env({ DATA_REGION: "me-central1" }))).toEqual(["APPROVED_DATA_REGIONS must list the approved regions when a region is declared.", "DATA_REGION names a region that is not approved."]);
    expect(residencyProblems(env({}))).toEqual([]);
  });

  it("stops production start-up on a violation, and does nothing outside production", () => {
    expect(() => validateInfrastructureConfiguration(env({ APPROVED_DATA_REGIONS: "me-central1", DATA_REGION: "asia-south1" }))).toThrow(InfrastructureConfigurationError);
    expect(() => validateInfrastructureConfiguration({ NODE_ENV: "development", DATA_REGION: "asia-south1" } as never)).not.toThrow();
  });
});

describe("database in transit (M-018, AI-013)", () => {
  it("requires TLS in the connection string, or a Cloud SQL socket", () => {
    expect(databaseTransportProblems(env({ DATABASE_URL: "postgresql://u:p@h/db" }))).toHaveLength(1);
    expect(databaseTransportProblems(env({ DATABASE_URL: "postgresql://u:p@h/db?sslmode=disable" }))).toHaveLength(1);
    expect(databaseTransportProblems(env({ DATABASE_URL: "postgresql://u:p@h/db?sslmode=require" }))).toEqual([]);
    expect(databaseTransportProblems(env({ DATABASE_URL: "postgresql://u:p@h/db?schema=public&sslmode=verify-full" }))).toEqual([]);
    expect(databaseTransportProblems(env({ DATABASE_URL: "postgresql://u:p@/db?host=/cloudsql/proj:region:inst" }))).toEqual([]);
    expect(databaseTransportProblems(env({}))).toEqual([]);
    expect(() => validateInfrastructureConfiguration(env({ DATABASE_URL: "postgresql://u:p@h/db" }))).toThrow(/TLS/);
  });
});

describe("single sign-on only (NFR-151)", () => {
  it("allows local passwords only for named break-glass accounts once SSO is enforced", () => {
    expect(localLoginAllowed("anyone@irisstar.tech", {} as never)).toBe(true);
    const on = { SSO_ENFORCED: "true", BREAK_GLASS_USERS: "Rishma@irisstar.tech, emergency@irisstar.tech" } as unknown as NodeJS.ProcessEnv;
    expect(ssoEnforced(on)).toBe(true);
    expect(breakGlassUsers(on)).toEqual(["rishma@irisstar.tech", "emergency@irisstar.tech"]);
    expect(localLoginAllowed("layla@irisstar.tech", on)).toBe(false);
    expect(localLoginAllowed(" RISHMA@irisstar.tech ", on)).toBe(true);
  });

  describe("at the sign-in endpoint", () => {
    const app = createApp();
    beforeEach(() => { resetSecurityStoreForTests(); resetRateLimitBucketsForTests(); });
    afterEach(() => { delete process.env.SSO_ENFORCED; delete process.env.BREAK_GLASS_USERS; });

    it("refuses a local password for an ordinary user, and still admits a break-glass account", async () => {
      process.env.SSO_ENFORCED = "true";
      process.env.BREAK_GLASS_USERS = "rishma@irisstar.tech";
      const refused = await request(app).post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(403);
      expect(refused.body).toMatchObject({ ssoRequired: true });
      await request(app).post("/api/v1/auth/login").send({ username: "rishma@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);
    });
  });
});

describe("secret rotation (NFR-161)", () => {
  const now = new Date("2026-11-21T00:00:00Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  it("reports each secret in use as current, due soon, overdue or unknown, without reading its value", () => {
    const e = {
      SECRET_ROTATION_DAYS: "90", AUTH_JWT_SECRET: "x", AUTH_JWT_SECRET_ROTATED_AT: day(10),
      AUDIT_HMAC_SECRET: "x", AUDIT_HMAC_SECRET_ROTATED_AT: day(80),
      FIELD_ENCRYPTION_KEY: "x", FIELD_ENCRYPTION_KEY_ROTATED_AT: day(120),
      MFA_ENCRYPTION_KEY: "x", METRICS_TOKEN_ROTATED_AT: day(1)
    } as unknown as NodeJS.ProcessEnv;
    const report = rotationReport(e, now);
    expect(Object.fromEntries(report.secrets.map((s) => [s.name, s.status]))).toEqual({ AUTH_JWT_SECRET: "ok", AUDIT_HMAC_SECRET: "due_soon", FIELD_ENCRYPTION_KEY: "overdue", MFA_ENCRYPTION_KEY: "unknown" });
    expect(report.secrets.find((s) => s.name === "FIELD_ENCRYPTION_KEY")).toMatchObject({ ageDays: 120, dueInDays: -30 });
    expect(JSON.stringify(report)).not.toContain('"x"');
  });

  it("raises an event for an overdue secret so an alert rule can send it", async () => {
    clearSubscribersForTests();
    const seen: Array<{ type: string; data: Record<string, unknown> }> = [];
    subscribe({ name: "t", handle: async (e) => { seen.push({ type: e.type, data: e.data }); } });
    const ok = await checkSecretRotation({ AUTH_JWT_SECRET: "x", AUTH_JWT_SECRET_ROTATED_AT: day(5) } as never, now);
    expect(ok.ok).toBe(true);
    expect(seen).toHaveLength(0);
    const late = await checkSecretRotation({ AUTH_JWT_SECRET: "x", AUTH_JWT_SECRET_ROTATED_AT: day(200) } as never, now);
    expect(late).toMatchObject({ ok: false, overdue: ["AUTH_JWT_SECRET"] });
    expect(seen[0]).toMatchObject({ type: "secret.rotation_overdue", data: { overdue: ["AUTH_JWT_SECRET"], intervalDays: 90 } });
  });
});

// Guardrails for the Qatar Airways tenant module: each control is tied to the requirement it answers, so removing one
// fails the build. (This reads the Terraform source; it does not replace `terraform validate` and `terraform plan`.)
describe("Qatar Airways tenant infrastructure as code", () => {
  const dir = path.resolve(process.cwd(), "terraform", "tenant-qatar-airways");
  const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".tf")).map((f) => [f, readFileSync(path.join(dir, f), "utf8")]));
  const all = Object.values(files).join("\n");

  const CONTROLS: Array<[string, string, RegExp]> = [
    ["AI-009 keys cannot be deleted by Terraform", "kms.tf", /prevent_destroy\s*=\s*true/],
    ["AI-009 soft-delete window on key versions", "kms.tf", /destroy_scheduled_duration\s*=\s*var\.key_destroy_delay/],
    ["AI-010 secrets are readable only by the runtime account", "secrets.tf", /secretAccessor[\s\S]*google_service_account\.runtime\.email/],
    ["AI-011 / M-040 threat detection service enabled", "network.tf", /securitycenter\.googleapis\.com/],
    ["M-040 high and critical findings reach the SIEM", "security.tf", /severity=\\"HIGH\\" OR severity=\\"CRITICAL\\"/],
    ["M-040 binary authorisation blocks and logs", "binauth.tf", /ENFORCED_BLOCK_AND_AUDIT_LOG/],
    ["NFR-158 only attested images are admitted", "binauth.tf", /REQUIRE_ATTESTATION/],
    ["NFR-158 the service uses the policy", "run.tf", /binary_authorization\s*\{\s*use_default\s*=\s*true/],
    ["NFR-159 privileged access is requested and approved", "iam.tf", /google_privileged_access_manager_entitlement[\s\S]*manual_approvals/],
    ["NFR-159 access is time-boxed", "iam.tf", /max_request_duration\s*=\s*"14400s"/],
    ["NFR-161 keys rotate", "kms.tf", /rotation_period\s*=\s*var\.kms_rotation_period/],
    ["NFR-161 secrets rotate", "secrets.tf", /rotation_period\s*=\s*var\.secret_rotation_period/],
    ["AI-012 customer-managed key option", "variables.tf", /variable "customer_managed_key"/],
    ["AI-012 database, secrets use the tenant key", "sql.tf", /encryption_key_name\s*=\s*local\.data_key_id/],
    ["AI-005 locations limited to approved regions", "orgpolicy.tf", /gcp\.resourceLocations[\s\S]*approved_regions/],
    ["AI-005 customer keys required", "orgpolicy.tf", /gcp\.restrictNonCmekServices/],
    ["AI-006 / AI-007 application only behind the load balancer", "run.tf", /INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER/],
    ["AI-007 no public database address", "sql.tf", /ipv4_enabled\s*=\s*false/],
    ["AI-007 no public Cloud SQL by policy", "orgpolicy.tf", /sql\.restrictPublicIp/],
    ["AI-008 / M-038 web application firewall with injection rules", "network.tf", /sqli-v33-stable[\s\S]*xss-v33-stable/],
    ["AI-008 / M-038 approved networks only, default deny", "network.tf", /Default deny: not an approved network/],
    ["M-038 DDoS protection", "network.tf", /layer_7_ddos_defense_config/],
    ["AI-013 / M-018 database requires TLS", "sql.tf", /ssl_mode\s*=\s*"ENCRYPTED_ONLY"/],
    ["AI-013 database password policy", "sql.tf", /enable_password_policy\s*=\s*true/],
    ["AI-013 database deletion protection", "sql.tf", /deletion_protection\s*=\s*true/],
    ["M-018 edge accepts TLS 1.2 or later only", "network.tf", /min_tls_version\s*=\s*"TLS_1_2"/],
    ["NFR-153 separate runtime and migration roles", "sql.tf", /aimltriage_runtime[\s\S]*aimltriage_migration/],
    ["AI-015 logs copied to the SIEM", "logging.tf", /aimltriage-siem/],
    ["AI-015 audit logs for every service", "iam.tf", /DATA_WRITE/],
    ["NFR-089 backups stay in the approved region", "sql.tf", /location\s*=\s*var\.region/],
    ["NFR-089 DR region must be approved", "variables.tf", /var\.dr_region == null \|\| contains\(var\.approved_regions, var\.dr_region\)/],
    ["M-028 the primary region must be approved", "variables.tf", /contains\(var\.approved_regions, var\.region\)/],
    ["M-028 secrets replicate only to approved regions", "secrets.tf", /for_each = toset\(var\.approved_regions\)/],
    ["M-028 residency inventory is an output", "outputs.tf", /output "residency_inventory"/],
    ["NFR-151 the deployed application enforces single sign-on", "run.tf", /SSO_ENFORCED/]
  ];

  it.each(CONTROLS)("%s", (_name, file, pattern) => {
    expect(files[file]).toMatch(pattern);
  });

  it("is a separate module that cannot target the existing SOC 2 project", () => {
    expect(files["variables.tf"]).toMatch(/triage-502706/); // only inside the guard that rejects it
    expect(all.match(/triage-502706/g)).toHaveLength(1);
    expect(files["versions.tf"]).toMatch(/backend "gcs" \{\}/);
  });

  it("places no secret value, key or password in the source", () => {
    expect(all).not.toMatch(/password\s*=\s*"[^"$]{4,}"/i);
    expect(all).not.toMatch(/-----BEGIN/);
  });
});

import { estimate, DEFAULT_PROJECTION } from "../src/utils/networkEstimate.js";

describe("network requirements per user (NFR-154)", () => {
  const measured = { queueListBytes: 12_000, caseBytes: 2_500, noteBytes: 850, sessionBytes: 800 };

  it("scales with users and with how often a screen polls, and always includes headroom", () => {
    const base = estimate(measured, DEFAULT_PROJECTION);
    expect(base.peakMbps).toBeCloseTo(base.totalMbps * DEFAULT_PROJECTION.headroom, 2);
    expect(estimate(measured, { ...DEFAULT_PROJECTION, concurrentNurses: 100 }).totalMbps).toBeGreaterThan(base.totalMbps * 1.7);
    expect(estimate(measured, { ...DEFAULT_PROJECTION, pollSeconds: 5 }).perNurseKbps).toBeGreaterThan(base.perNurseKbps * 2);
    expect(base.perNurseKbps).toBeGreaterThan(0);
  });

  it("is smaller on a slow-connection list", () => {
    expect(estimate({ ...measured, queueListBytes: 5_000 }).perNurseKbps).toBeLessThan(estimate(measured).perNurseKbps);
  });
});
