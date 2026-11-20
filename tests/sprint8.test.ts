import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { lintAll, lintSql } from "../src/utils/migrationLint.js";

const root = process.cwd();

describe("NFR-033 / NFR-136 / NFR-140 backward-compatible database changes", () => {
  it("refuses the statements that break the running release, and accepts additive ones", () => {
    expect(lintSql("ALTER TABLE t DROP COLUMN c;").found).toHaveLength(1);
    expect(lintSql("DROP TABLE t;").found).toHaveLength(1);
    expect(lintSql("ALTER TABLE t ALTER COLUMN c TYPE bigint;").found).toHaveLength(1);
    expect(lintSql("ALTER TABLE t RENAME COLUMN a TO b;").found).toHaveLength(1);
    expect(lintSql("ALTER TABLE t ALTER COLUMN c SET NOT NULL;").found).toHaveLength(1);
    expect(lintSql("ALTER TABLE t ADD COLUMN c text NOT NULL;").found).toHaveLength(1);
    expect(lintSql("TRUNCATE t;").found).toHaveLength(1);
    expect(lintSql("CREATE TABLE t (id int); CREATE INDEX i ON t(id); ALTER TABLE t ADD COLUMN c text; ALTER TABLE t ADD COLUMN d int NOT NULL DEFAULT 0;").found).toEqual([]);
    expect(lintSql("-- DROP TABLE mentioned in a comment only\nCREATE TABLE t (id int);").found).toEqual([]);
  });

  it("lets a risky change through only with a stated expand-contract reason", () => {
    expect(lintSql("-- expand-contract: column unused since release 12\nALTER TABLE t DROP COLUMN c;")).toMatchObject({ approved: true });
    expect(lintSql("ALTER TABLE t DROP COLUMN c;")).toMatchObject({ approved: false });
  });

  it("passes for every migration in the repository, with earlier ones grandfathered by name", () => {
    expect(lintAll(root).problems).toEqual([]);
    const baseline = JSON.parse(readFileSync(path.join(root, "prisma/migration-lint-baseline.json"), "utf8")).grandfathered as string[];
    const all = readdirSync(path.join(root, "prisma/migrations"));
    for (const name of baseline) expect(all).toContain(name);
  });
});

// Guardrails for the Sprint 8 parts of the tenant module, in the same style as the Sprint 7 ones.
describe("tenant availability, environments, monitoring and release controls", () => {
  const dir = path.resolve(root, "terraform", "tenant-qatar-airways");
  const read = (f: string) => readFileSync(path.join(dir, f), "utf8");
  const CONTROLS: Array<[string, string, RegExp]> = [
    ["NFR-034 database in two zones with automatic failover", "sql.tf", /availability_type\s*=\s*"REGIONAL"/],
    ["NFR-034 application runs at least two instances", "run.tf", /min_instance_count\s*=\s*2/],
    ["NFR-036 / M-014 cross-region replica in the DR region", "ha_dr.tf", /master_instance_name\s*=\s*google_sql_database_instance\.primary\.name/],
    ["NFR-089 the DR replica is private, TLS only and encrypted with its own key", "ha_dr.tf", /ENCRYPTED_ONLY[\s\S]*|encryption_key_name\s*=\s*local\.use_own_key \? google_kms_crypto_key\.dr/],
    ["M-013 replica lag alerts at the RPO", "monitoring.tf", /recovery_tier\.rpo_minutes \* 60/],
    ["NFR-037 backups start in a quiet window", "sql.tf", /start_time\s*=\s*var\.backup_start_time/],
    ["NFR-035 / NFR-068 each environment has its own database", "modules/environment/main.tf", /resource "google_sql_database_instance" "db"/],
    ["NFR-069 environments come from one definition and can be added", "environments.tf", /for_each\s*=\s*var\.environments/],
    ["NFR-073 / NFR-137 canary traffic split", "run.tf", /var\.canary_percent/],
    ["NFR-139 instant rollback by setting the canary to zero", "variables.tf", /Set to 0 \(or empty the canary\) to roll back instantly/],
    ["M-024 database availability alert", "monitoring.tf", /cloudsql\.googleapis\.com\/database\/up/],
    ["M-024 disk alert", "monitoring.tf", /disk\/utilization/],
    ["M-024 backup failure alert", "monitoring.tf", /aimltriage_backup_failed/],
    ["NFR-102 alerts pushed to an HTTPS endpoint", "variables.tf", /startswith\(var\.alert_push_url, "https:\/\/"\)/],
    ["NFR-102 the push token is never in the source", "variables.tf", /sensitive\s*=\s*true/],
    ["NFR-104 read-only dashboard access", "monitoring.tf", /roles\/monitoring\.viewer/],
    ["NFR-068 availability measured from outside every minute", "monitoring.tf", /period\s*=\s*"60s"/],
    ["NFR-108 / NFR-109 log archive with cold storage and purge", "logging.tf", /storage_class = "ARCHIVE"[\s\S]*type = "Delete"/],
    ["NFR-116 / AI-018 cost budget and export in the approved region", "costs.tf", /google_billing_budget[\s\S]*|location\s*=\s*var\.region/]
  ];
  it.each(CONTROLS)("%s", (_n, file, pattern) => {
    expect(read(file)).toMatch(pattern);
  });
});

describe("NFR-129 data growth: the completed-cases index", () => {
  it("adds the index in a migration that only adds, matching the schema", () => {
    const sql = readFileSync(path.join(root, "prisma/migrations/20260823090000_queue_completed_cases_index/migration.sql"), "utf8");
    expect(sql).toMatch(/CREATE INDEX "triage_queue_items_org_status_updated_idx" ON "triage_queue_items"\("organization_id", "status", "updated_at" DESC\)/);
    expect(readFileSync(path.join(root, "prisma/schema.prisma"), "utf8")).toMatch(/triage_queue_items_org_status_updated_idx/);
  });
});

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("M-013 / M-014 / AI-021 recovery rehearsal", () => {
  it("backs up, restores into an empty database and proves the copy is usable", () => {
    const out = execFileSync("node", ["scripts/recoveryRehearsal.mjs"], { env: { ...process.env, RPO_MINUTES: "15", RTO_MINUTES: "240" }, encoding: "utf8", timeout: 170_000 });
    const result = JSON.parse(out.slice(out.indexOf("{")));
    expect(result.ok).toBe(true);
    const names = result.checks.map((c: { check: string }) => c.check).join("|");
    expect(names).toMatch(/row count/);
    expect(names).toMatch(/hash chain verifies/);
    expect(result.steps.map((s: { step: string }) => s.step)).toEqual(expect.arrayContaining(["backup (pg_dump, custom format)", "restore (pg_restore)"]));
  }, 180_000);

  it("fails the rehearsal when the recovery time exceeds the tier's target", () => {
    let failed = false;
    try {
      execFileSync("node", ["scripts/recoveryRehearsal.mjs"], { env: { ...process.env, RTO_MINUTES: "0" }, encoding: "utf8", stdio: "pipe", timeout: 170_000 });
    } catch (error) {
      failed = (error as { status?: number }).status === 1;
    }
    expect(failed).toBe(true);
  }, 180_000);
});
