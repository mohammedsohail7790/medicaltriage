import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// NFR-033 / NFR-136 / NFR-140: database changes must be backward compatible, so the previous release keeps working while the
// new one is rolled out (zero-downtime upgrades, blue-green and canary releases, instant rollback). A migration that would break
// the running version is "expand then contract": add first, switch the code, remove in a later release. The lint refuses the risky
// statements unless the migration says why it is safe with a comment: `-- expand-contract: <reason>`.
// Migrations shipped before this rule are listed in prisma/migration-lint-baseline.json and are not re-judged.

const RISKY: Array<[RegExp, string]> = [
  [/\bDROP\s+TABLE\b/i, "drops a table the previous release may still read"],
  [/\bDROP\s+COLUMN\b/i, "drops a column the previous release may still read"],
  [/\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i, "changes a column's type under a running release"],
  [/\bRENAME\b/i, "renames something the previous release refers to by name"],
  [/\bALTER\s+COLUMN\b[^;]*\bSET\s+NOT\s+NULL\b/i, "makes a column mandatory, which the previous release may not fill"],
  [/\bADD\s+COLUMN\b[^;,]*\bNOT\s+NULL\b(?![^;,]*\bDEFAULT\b)/i, "adds a mandatory column with no default, so the previous release's inserts fail"],
  [/\bTRUNCATE\b/i, "removes data"],
  [/\bDELETE\s+FROM\b/i, "removes data"]
];

export function lintSql(sql: string) {
  const approved = /--\s*expand-contract:\s*\S+/i.test(sql);
  const found: string[] = [];
  const stripped = sql.replace(/--[^\n]*/g, "");
  for (const [pattern, why] of RISKY) if (pattern.test(stripped)) found.push(why);
  return { approved, found };
}

export function lintAll(root = process.cwd()) {
  const dir = path.join(root, "prisma", "migrations");
  const baselineFile = path.join(root, "prisma", "migration-lint-baseline.json");
  const baseline = existsSync(baselineFile) ? new Set<string>((JSON.parse(readFileSync(baselineFile, "utf8")) as { grandfathered: string[] }).grandfathered) : new Set<string>();
  const problems: Array<{ migration: string; reasons: string[] }> = [];
  const risky: string[] = [];
  for (const name of readdirSync(dir).filter((n) => /^\d/.test(n)).sort()) {
    const { approved, found } = lintSql(readFileSync(path.join(dir, name, "migration.sql"), "utf8"));
    if (found.length) risky.push(name);
    if (found.length && !approved && !baseline.has(name)) problems.push({ migration: name, reasons: found });
  }
  return { problems, risky };
}

