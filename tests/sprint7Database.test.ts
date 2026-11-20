import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

// NFR-153 proved against PostgreSQL: the role script produces a runtime role that can read and write rows and cannot
// change the schema or the audit ledger. Skipped without DATABASE_URL.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("Sprint 7 database-backed behaviour", () => {
  const dbName = "ist_triage_roles_check";
  let admin: PrismaClient;
  let base: URL;
  const urlFor = (db: string, user?: string, password?: string) => {
    const u = new URL(base.toString());
    u.pathname = `/${db}`;
    u.search = "?schema=public";
    if (user) {
      u.username = user;
      u.password = password ?? "";
    }
    return u.toString();
  };

  beforeAll(async () => {
    base = new URL(process.env.DATABASE_URL!);
    admin = new PrismaClient({ datasourceUrl: urlFor(base.pathname.slice(1)) });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.$executeRawUnsafe(`CREATE DATABASE ${dbName}`);
    await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS aimltriage_runtime`).catch(() => undefined);
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlFor(dbName) }, stdio: "pipe" });
    const sql = readFileSync(path.resolve(process.cwd(), "prisma/roles/least-privilege.sql"), "utf8").replace(/REPLACE_ME/g, "role_test_pw");
    execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", urlFor(dbName).replace("?schema=public", "")], { input: sql, stdio: ["pipe", "pipe", "pipe"] });
  }, 180_000);

  afterAll(async () => {
    await admin.$disconnect();
  });

  it("gives the runtime role row access only, and reports it as least privilege", async () => {
    const runtime = new PrismaClient({ datasourceUrl: urlFor(dbName, "aimltriage_runtime", "role_test_pw") });
    try {
      const [row] = await runtime.$queryRaw<Array<{ role: string; superuser: boolean; owned: bigint; cancreate: boolean }>>`
        SELECT current_user AS role, r.rolsuper AS superuser,
               (SELECT count(*) FROM pg_tables t WHERE t.schemaname='public' AND t.tableowner=current_user) AS owned,
               has_schema_privilege(current_user,'public','CREATE') AS cancreate
        FROM pg_roles r WHERE r.rolname = current_user`;
      expect(row).toMatchObject({ role: "aimltriage_runtime", superuser: false, cancreate: false });
      expect(Number(row.owned)).toBe(0);

      // It can read and write rows.
      await runtime.$executeRawUnsafe(`INSERT INTO rate_limit_buckets (key, window_start, count) VALUES ('role-test', now(), 1)`);
      expect(Number((await runtime.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM rate_limit_buckets WHERE key = 'role-test'`))[0].n)).toBe(1);
      await runtime.$executeRawUnsafe(`UPDATE rate_limit_buckets SET count = 2 WHERE key = 'role-test'`);
      await runtime.$executeRawUnsafe(`DELETE FROM rate_limit_buckets WHERE key = 'role-test'`);

      // It cannot change the schema.
      await expect(runtime.$executeRawUnsafe(`DROP TABLE rate_limit_buckets`)).rejects.toThrow(/must be owner|permission denied/i);
      await expect(runtime.$executeRawUnsafe(`ALTER TABLE rate_limit_buckets ADD COLUMN x int`)).rejects.toThrow(/must be owner|permission denied/i);
      await expect(runtime.$executeRawUnsafe(`CREATE TABLE intruder (id int)`)).rejects.toThrow(/permission denied/i);

      // It cannot change or remove an audit ledger entry.
      await expect(runtime.$executeRawUnsafe(`UPDATE audit_events SET action = 'X'`)).rejects.toThrow(/permission denied/i);
      await expect(runtime.$executeRawUnsafe(`DELETE FROM audit_events`)).rejects.toThrow(/permission denied/i);
    } finally {
      await runtime.$disconnect();
    }
  });

  it("flags a role that owns the tables, as the test database's own role does", async () => {
    const { databaseRoleReport } = await import("../src/services/databaseRole.js");
    const report = await databaseRoleReport();
    expect(report.leastPrivilege).toBe(false);
    expect(report.problems.join(" ")).toMatch(/owns|superuser|create/);
  });

  it("refuses to start on such a role when the check is enforced", async () => {
    const { enforceDatabaseRole } = await import("../src/services/databaseRole.js");
    await expect(enforceDatabaseRole({ DB_ROLE_CHECK: "enforce", DATABASE_URL: process.env.DATABASE_URL } as never)).rejects.toThrow(/not least privilege/);
    await expect(enforceDatabaseRole({ DATABASE_URL: process.env.DATABASE_URL } as never)).resolves.toBeUndefined();
  });
});
