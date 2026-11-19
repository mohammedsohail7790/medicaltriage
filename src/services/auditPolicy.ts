import { randomUUID } from "node:crypto";
import { shouldPersistAuditEventsInDatabase } from "../config/runtime.js";
import { prisma } from "../db.js";
import { buildAuditChange } from "./auditChange.js";
import { parseAuditSinkConfig } from "./auditForwarding.js";
import { listPersistedAuditEvents } from "./persistence.js";
import { auditRetentionPolicy } from "./retentionGovernance.js";
import { recordAuditEvent } from "./securityAdmin.js";

/**
 * The audit policy (NFR-011).
 *
 * Qatar Airways asked how auditing can be disabled for specific data elements and what the
 * approval workflow is. The answer is by design: it cannot. There is no setting, per data element
 * or global, that switches auditing off. Production refuses to start without durable audit storage,
 * and the database rejects any update or delete of an audit entry. What can be configured is how long
 * entries are kept and where copies are sent, and those changes are made under change control and are
 * themselves written to the ledger: every start records the audit configuration, with before and
 * after values when it differs from the last one.
 */

export type AuditPolicyStatement = {
  auditingCanBeDisabled: false;
  perDataElementDisable: false;
  guarantees: string[];
  configurable: { retention: ReturnType<typeof auditRetentionPolicy>; forwardingSinks: string[]; durableStorage: boolean };
  appendOnlyEnforcedByDatabase: boolean | "not-checked";
  governance: string[];
};

async function appendOnlyEnforced(): Promise<boolean | "not-checked"> {
  if (!shouldPersistAuditEventsInDatabase()) return "not-checked";
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
      `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'audit_events' AND NOT t.tgisinternal`
    );
    const names = rows.map((row) => row.tgname);
    return names.some((n) => /mutation|update|delete|immutable|append/i.test(n)) && names.some((n) => /insert|chain/i.test(n));
  } catch {
    return "not-checked";
  }
}

export async function auditPolicyStatement(): Promise<AuditPolicyStatement> {
  return {
    auditingCanBeDisabled: false,
    perDataElementDisable: false,
    guarantees: [
      "No configuration setting turns auditing off, for the whole system or for a single data element.",
      "Production does not start without durable, database-backed audit storage and its signing secret.",
      "Audit entries are append-only in the database: updates and deletes are rejected, and each entry is hash-chained to the one before it.",
      "Changes to staff, roles, permissions and the agreed clinical entities are recorded with before and after values.",
      "Audit events are kept for the life of the contract unless Qatar Airways sets another period."
    ],
    configurable: {
      retention: auditRetentionPolicy(),
      forwardingSinks: parseAuditSinkConfig(process.env.AUDIT_FORWARD_SINKS).map((sink) => sink.name),
      durableStorage: shouldPersistAuditEventsInDatabase()
    },
    appendOnlyEnforcedByDatabase: await appendOnlyEnforced(),
    governance: [
      "Retention period and forwarding targets are changed only through the release and configuration change process: a written change request, review and approval by the security owner, and Qatar Airways agreement where it affects their data.",
      "Every start of the service records the audit configuration in the ledger (AUDIT_CONFIGURATION_LOADED), with before and after values when it differs from the previous start, so each approved change is visible in the ledger itself.",
      "An attempt to alter or delete an audit entry fails at the database and is itself an event worth investigating."
    ]
  };
}

/** Writes the audit configuration to the ledger, with before and after values when it changed. */
export async function recordAuditConfigurationState(): Promise<void> {
  const retention = auditRetentionPolicy();
  const state = {
    retentionMode: retention.mode,
    retentionDays: retention.days,
    forwardingSinks: parseAuditSinkConfig(process.env.AUDIT_FORWARD_SINKS).map((sink) => sink.name).sort(),
    durableStorage: shouldPersistAuditEventsInDatabase(),
    ledgerKeyVersion: process.env.AUDIT_HMAC_KEY_VERSION?.trim() || "v1"
  };
  let previous: Record<string, unknown> | null = null;
  try {
    const [last] = await listPersistedAuditEvents(1, { action: "AUDIT_CONFIGURATION_LOADED" });
    previous = ((last?.metadata as { state?: Record<string, unknown> } | undefined)?.state) ?? null;
  } catch {
    previous = null;
  }
  await recordAuditEvent({
    id: randomUUID(),
    timestampIso: new Date().toISOString(),
    userId: "system",
    activeRole: "system",
    organization: "",
    facility: "",
    department: "",
    action: "AUDIT_CONFIGURATION_LOADED",
    module: "AuditGovernance",
    resource: "AuditConfiguration",
    ipAddress: "",
    device: "",
    success: true,
    risk: "low",
    metadata: { state, change: buildAuditChange(previous, state) }
  });
}
