import { basePrisma } from "../db.js";

/**
 * NFR-153: the running application connects with a role that can read and write rows and nothing more. It must not be a
 * superuser, must not own the tables (an owner can alter and drop them) and must not be able to create objects. Migrations
 * run through a different role (see prisma/roles/least-privilege.sql and scripts/migrate.mjs).
 */

export type DatabaseRoleReport = { role: string; superuser: boolean; createRole: boolean; createDb: boolean; ownedTables: number; canCreateInSchema: boolean; leastPrivilege: boolean; problems: string[] };

export async function databaseRoleReport(): Promise<DatabaseRoleReport> {
  const [row] = await basePrisma.$queryRaw<Array<{ role: string; superuser: boolean; createrole: boolean; createdb: boolean; owned: bigint; cancreate: boolean }>>`
    SELECT current_user AS role,
           r.rolsuper AS superuser, r.rolcreaterole AS createrole, r.rolcreatedb AS createdb,
           (SELECT count(*) FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = current_user) AS owned,
           has_schema_privilege(current_user, 'public', 'CREATE') AS cancreate
    FROM pg_roles r WHERE r.rolname = current_user`;
  const problems: string[] = [];
  if (row.superuser) problems.push("The role is a superuser.");
  if (row.createrole || row.createdb) problems.push("The role can create roles or databases.");
  if (Number(row.owned) > 0) problems.push(`The role owns ${Number(row.owned)} table(s) and could alter or drop them.`);
  if (row.cancreate) problems.push("The role can create objects in the public schema.");
  return { role: row.role, superuser: row.superuser, createRole: row.createrole, createDb: row.createdb, ownedTables: Number(row.owned), canCreateInSchema: row.cancreate, leastPrivilege: problems.length === 0, problems };
}

/** With DB_ROLE_CHECK=enforce, start-up stops when the runtime role has more power than it needs. */
export async function enforceDatabaseRole(env: NodeJS.ProcessEnv = process.env): Promise<DatabaseRoleReport | undefined> {
  if (env.DB_ROLE_CHECK !== "enforce" || !env.DATABASE_URL) return undefined;
  const report = await databaseRoleReport();
  if (!report.leastPrivilege) throw new Error(`The database role is not least privilege: ${report.problems.join(" ")}`);
  return report;
}
