// M-013 / M-014 / AI-021: a recovery rehearsal. Takes a backup of the database DATABASE_URL points at, restores it into a
// separate, empty database, and then proves the restore is usable: row counts match, the newest audit event is present, and the
// audit ledger's hash chain still verifies. It reports how long each step took and compares the totals with the agreed tier.
//   DATABASE_URL=... RPO_MINUTES=15 RTO_MINUTES=240 node scripts/recoveryRehearsal.mjs
// It never writes to the source database. The scratch database is dropped at the end unless KEEP_RESTORE=1.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const source = new URL(process.env.DATABASE_URL ?? "");
const rpoMinutes = Number(process.env.RPO_MINUTES ?? 15);
const rtoMinutes = Number(process.env.RTO_MINUTES ?? 240);
const sourceDb = source.pathname.slice(1);
const scratchDb = `${sourceDb}_rehearsal`;
const plain = (db) => {
  const u = new URL(source.toString());
  u.pathname = `/${db}`;
  u.search = "";
  return u.toString();
};
const psql = (db, sql) => execFileSync("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", plain(db), "-c", sql], { encoding: "utf8" }).trim();
const timed = (name, fn) => {
  const start = Date.now();
  const value = fn();
  steps.push({ step: name, seconds: Math.round(((Date.now() - start) / 1000) * 10) / 10 });
  return value;
};

const steps = [];
const dir = mkdtempSync(path.join(os.tmpdir(), "rehearsal-"));
const dump = path.join(dir, "backup.dump");
const started = Date.now();
let ok = true;
const checks = [];
try {
  const sourceRows = timed("count source rows", () => {
    const tables = psql(sourceDb, "select tablename from pg_tables where schemaname='public' order by 1").split("\n").filter(Boolean);
    const counts = {};
    for (const t of tables) counts[t] = Number(psql(sourceDb, `select count(*) from "${t}"`));
    return counts;
  });
  const sourceLatest = psql(sourceDb, "select coalesce(max(timestamp),'epoch') from audit_events") ;
  timed("backup (pg_dump, custom format)", () => execFileSync("pg_dump", ["-Fc", "-f", dump, plain(sourceDb)]));
  const dumpMb = Math.round((statSync(dump).size / 1e6) * 10) / 10;
  timed("create empty database", () => {
    psql("postgres", `drop database if exists "${scratchDb}"`);
    psql("postgres", `create database "${scratchDb}"`);
  });
  timed("restore (pg_restore)", () => execFileSync("pg_restore", ["--no-owner", "--no-privileges", "-d", plain(scratchDb), dump]));
  const restoredRows = timed("count restored rows", () => {
    const counts = {};
    for (const t of Object.keys(sourceRows)) counts[t] = Number(psql(scratchDb, `select count(*) from "${t}"`));
    return counts;
  });
  const mismatched = Object.keys(sourceRows).filter((t) => sourceRows[t] !== restoredRows[t]);
  checks.push({ check: "every table has the same row count after the restore", ok: mismatched.length === 0, detail: mismatched.length ? mismatched : `${Object.keys(sourceRows).length} tables` });
  const restoredLatest = psql(scratchDb, "select coalesce(max(timestamp),'epoch') from audit_events");
  checks.push({ check: "the newest audit event is present after the restore", ok: restoredLatest === sourceLatest, detail: { source: sourceLatest, restored: restoredLatest } });
  const chain = timed("verify the audit chain on the restored copy", () => spawnSync("npx", ["tsx", "scripts/verifyAuditChain.ts"], { env: { ...process.env, DATABASE_URL: `${plain(scratchDb)}?schema=public`, AUDIT_HMAC_SECRET: process.env.AUDIT_HMAC_SECRET ?? "ci-only-audit-hmac-secret-not-for-production" }, encoding: "utf8" }));
  checks.push({ check: "the audit ledger's hash chain verifies on the restored copy", ok: chain.status === 0, detail: (chain.stdout || chain.stderr || "").trim().split("\n").pop() });
  const totalMinutes = (Date.now() - started) / 60000;
  const dataLossMinutes = Math.max(0, (Date.parse(sourceLatest) - Date.parse(restoredLatest)) / 60000);
  checks.push({ check: `recovery time within the tier's RTO (${rtoMinutes} min)`, ok: totalMinutes <= rtoMinutes, detail: `${totalMinutes.toFixed(2)} min` });
  checks.push({ check: `data loss within the tier's RPO (${rpoMinutes} min)`, ok: dataLossMinutes <= rpoMinutes, detail: `${dataLossMinutes.toFixed(2)} min between the newest event at the source and in the restore` });
  ok = checks.every((c) => c.ok);
  console.log(JSON.stringify({ ok, source: sourceDb, backupMegabytes: dumpMb, steps, checks, note: "Measured on this machine, in this database. It shows the procedure works and how long it takes at this size; the tenant's recovery time must be measured again there, at its size and with cross-region restore." }, null, 2));
} finally {
  if (!process.env.KEEP_RESTORE) {
    try { psql("postgres", `drop database if exists "${scratchDb}"`); } catch { /* best effort */ }
  }
  rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
