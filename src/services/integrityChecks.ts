import { randomUUID } from "node:crypto";
import { basePrisma } from "../db.js";
import { shouldPersistAuditEventsInDatabase, shouldUseDatabasePersistence } from "../config/runtime.js";
import { verifyAuditEventChain } from "./auditLedger.js";
import { decryptText, ENCRYPTED_FIELDS, isEncryptedValue } from "./fieldEncryption.js";
import { recordAuditEvent } from "./securityAdmin.js";

/**
 * Data integrity checks (NFR-059). Corruption or missing data is looked for proactively, not found
 * by a user. Each check returns what it examined and what is wrong; a failing run raises an alert (a
 * critical audit event, which is also forwarded to the configured stores) and, where the repair is
 * safe, corrects it.
 *
 * Checks:
 *   audit-ledger        the hash chain of audit events verifies from the first entry to the last
 *   encrypted-fields    a sample of encrypted values still decrypts (catches a lost key or damaged value)
 *   completed-cases     every completed queue case has its encounter record
 *   soft-delete         every soft-deleted case records who deleted it
 *   stale-locks         cases still locked after their lock expired (repaired by releasing the lock)
 *   archive-handoff     archived records waiting for handoff for longer than the allowed time
 * Run on a schedule (src/scripts/runIntegrityChecks.ts) and on demand (POST /admin/integrity-checks/run).
 */

export type IntegrityProblem = { reference: string; detail: string };
export type IntegrityCheckResult = {
  name: string;
  ok: boolean;
  checked: number;
  problems: IntegrityProblem[];
  repaired?: number;
  skipped?: string;
};
export type IntegrityReport = { id: string; startedAtIso: string; finishedAtIso: string; ok: boolean; checks: IntegrityCheckResult[] };

const MAX_PROBLEMS = 20;
let lastReport: IntegrityReport | undefined;
export function lastIntegrityReport(): IntegrityReport | undefined {
  return lastReport;
}

type Check = (options: { repair: boolean; sampleSize: number }) => Promise<Omit<IntegrityCheckResult, "name">>;

const auditLedger: Check = async () => {
  if (!shouldPersistAuditEventsInDatabase()) return { ok: true, checked: 0, problems: [], skipped: "audit events are not stored in the database in this environment" };
  const result = await verifyAuditEventChain();
  return {
    ok: result.valid,
    checked: result.checkedEvents,
    problems: result.valid ? [] : [{ reference: result.firstInvalidEventId ?? "unknown", detail: "The audit chain does not verify from this entry." }]
  };
};

const encryptedFields: Check = async ({ sampleSize }) => {
  const problems: IntegrityProblem[] = [];
  let checked = 0;
  for (const [model, fields] of Object.entries(ENCRYPTED_FIELDS)) {
    const delegate = (basePrisma as unknown as Record<string, { findMany(args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> }>)[model.charAt(0).toLowerCase() + model.slice(1)];
    const rows = await delegate.findMany({ take: sampleSize, orderBy: { id: "desc" } });
    for (const row of rows) {
      for (const field of Object.keys(fields)) {
        const value = row[field];
        if (!isEncryptedValue(value)) continue;
        checked += 1;
        try {
          await decryptText(value, `${model}.${field}`);
        } catch {
          if (problems.length < MAX_PROBLEMS) problems.push({ reference: `${model}.${field}:${String(row.id)}`, detail: "The stored value cannot be decrypted." });
        }
      }
    }
  }
  return { ok: problems.length === 0, checked, problems };
};

const completedCases: Check = async () => {
  const completed = await basePrisma.triageQueueItem.findMany({ where: { status: "COMPLETED", deletedAt: null }, select: { id: true }, take: 5000 });
  const ids = completed.map((row) => row.id);
  const withEncounter = new Set(
    (await basePrisma.aviationTriageEncounter.findMany({ where: { sourceQueueItemId: { in: ids } }, select: { sourceQueueItemId: true } })).map((row) => row.sourceQueueItemId)
  );
  const missing = ids.filter((id) => !withEncounter.has(id));
  return { ok: missing.length === 0, checked: ids.length, problems: missing.slice(0, MAX_PROBLEMS).map((id) => ({ reference: `TriageQueueItem:${id}`, detail: "A completed case has no encounter record." })) };
};

const softDelete: Check = async () => {
  const deleted = await basePrisma.triageQueueItem.findMany({ where: { deletedAt: { not: null } }, select: { id: true, deletedBy: true }, take: 5000 });
  const bad = deleted.filter((row) => !row.deletedBy);
  return { ok: bad.length === 0, checked: deleted.length, problems: bad.slice(0, MAX_PROBLEMS).map((row) => ({ reference: `TriageQueueItem:${row.id}`, detail: "Deleted without a recorded user." })) };
};

const staleLocks: Check = async ({ repair }) => {
  const stale = await basePrisma.triageQueueItem.findMany({ where: { lockedBy: { not: null }, lockExpiresAt: { lt: new Date(Date.now() - 60 * 60 * 1000) }, status: { not: "COMPLETED" } }, select: { id: true }, take: 1000 });
  let repaired = 0;
  if (repair && stale.length > 0) {
    // Safe repair: the lock expired more than an hour ago, so releasing it cannot take work from anyone.
    repaired = (await basePrisma.triageQueueItem.updateMany({ where: { id: { in: stale.map((row) => row.id) }, lockedBy: { not: null } }, data: { lockedBy: null, lockExpiresAt: null } })).count;
  }
  return {
    ok: stale.length === 0 || repaired === stale.length,
    checked: stale.length,
    repaired,
    problems: repair && repaired === stale.length ? [] : stale.slice(0, MAX_PROBLEMS).map((row) => ({ reference: `TriageQueueItem:${row.id}`, detail: "Still locked more than an hour after the lock expired." }))
  };
};

const archiveHandoff: Check = async () => {
  const hours = Number(process.env.ARCHIVE_HANDOFF_MAX_HOURS) || 72;
  const column = await basePrisma.$queryRawUnsafe<Array<{ column_name: string }>>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'archived_records' AND column_name = 'handed_off_at'`);
  if (column.length === 0) return { ok: true, checked: 0, problems: [], skipped: "archive handoff is not set up" };
  const rows = await basePrisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM archived_records WHERE handed_off_at IS NULL AND archived_at < now() - ($1 || ' hours')::interval LIMIT ${MAX_PROBLEMS}`, String(hours));
  return { ok: rows.length === 0, checked: rows.length, problems: rows.map((row) => ({ reference: `ArchivedRecord:${row.id}`, detail: `Waiting for handoff for more than ${hours} hours.` })) };
};

export const INTEGRITY_CHECKS: Record<string, Check> = {
  "audit-ledger": auditLedger,
  "encrypted-fields": encryptedFields,
  "completed-cases": completedCases,
  "soft-delete": softDelete,
  "stale-locks": staleLocks,
  "archive-handoff": archiveHandoff
};

export async function runIntegrityChecks(options: { repair?: boolean; sampleSize?: number; only?: string[]; actorUserId?: string } = {}): Promise<IntegrityReport> {
  const startedAtIso = new Date().toISOString();
  const checks: IntegrityCheckResult[] = [];
  if (!shouldUseDatabasePersistence() && !shouldPersistAuditEventsInDatabase() && process.env.DATABASE_URL === undefined) {
    checks.push({ name: "all", ok: true, checked: 0, problems: [], skipped: "no database is configured in this environment" });
  } else {
    for (const [name, check] of Object.entries(INTEGRITY_CHECKS)) {
      if (options.only && !options.only.includes(name)) continue;
      try {
        checks.push({ name, ...(await check({ repair: options.repair ?? true, sampleSize: options.sampleSize ?? 200 })) });
      } catch (error) {
        // A check that cannot run is itself a finding.
        checks.push({ name, ok: false, checked: 0, problems: [{ reference: name, detail: `The check could not run: ${error instanceof Error ? error.name : "error"}` }] });
      }
    }
  }
  const report: IntegrityReport = { id: randomUUID(), startedAtIso, finishedAtIso: new Date().toISOString(), ok: checks.every((check) => check.ok), checks };
  lastReport = report;
  await recordAuditEvent({
    id: randomUUID(),
    timestampIso: report.finishedAtIso,
    userId: options.actorUserId ?? "system",
    activeRole: options.actorUserId ? "operator" : "system",
    organization: "",
    facility: "",
    department: "",
    action: report.ok ? "INTEGRITY_CHECK_PASSED" : "INTEGRITY_CHECK_FAILED",
    module: "DataIntegrity",
    resource: "IntegrityCheck",
    recordReference: report.id,
    purpose: report.ok ? "All integrity checks passed." : `Failed: ${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`,
    ipAddress: "",
    device: "",
    success: report.ok,
    // A failure is an alert: critical events reach the configured audit stores and the SIEM.
    risk: report.ok ? "low" : "critical",
    metadata: { checks: checks.map(({ name, ok, checked, repaired, skipped, problems }) => ({ name, ok, checked, repaired, skipped, problems: problems.slice(0, 5) })) }
  });
  return report;
}
