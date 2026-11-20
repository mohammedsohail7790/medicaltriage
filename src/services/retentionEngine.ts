import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "../db.js";
import { appendOperationalAuditEvent } from "./auditLedger.js";
import { excludeLegallyHeld, isDeletionMode, LEGAL_HOLD_MUTATION_LOCK_ID, policyRetentionDays, type DeletionMode } from "./retentionGovernance.js";

/**
 * The retention engine: purge and archive for each data type independently (NFR-055, NFR-057).
 *
 * Every target below is its own data type with its own policy row, schedule and legal-hold scope.
 * Nothing is purged without an approved policy. Audit events and anything not listed here are never
 * touched: this list is the whole of what retention can remove.
 */

export type RetentionTarget = {
  code: string;
  name: string;
  model: string;
  /** The date the retention period is measured from. */
  dateField: string;
  /** Extra conditions that must hold for a row to be eligible. */
  where?: Record<string, unknown>;
  /** Legal-hold resource type that blocks purging of a row, if holds apply to this type. */
  holdResourceType?: string;
  /** Archive-then-delete is the default; some data (sessions, nonces) is never worth archiving. */
  archivable: boolean;
  /** Clinical data may only be removed after an archive copy exists. */
  requiresArchive?: boolean;
};

export const RETENTION_TARGETS: RetentionTarget[] = [
  { code: "TRIAGE_QUEUE_ITEM_COMPLETED", name: "Completed queue cases", model: "TriageQueueItem", dateField: "updatedAt", where: { status: "COMPLETED" }, holdResourceType: "TriageQueueItem", archivable: true },
  { code: "TRIAGE_QUEUE_ITEM_DELETED", name: "Deleted queue cases", model: "TriageQueueItem", dateField: "deletedAt", where: { deletedAt: { not: null } }, holdResourceType: "TriageQueueItem", archivable: true },
  { code: "AVIATION_TRIAGE_ENCOUNTER", name: "Clinical encounters", model: "AviationTriageEncounter", dateField: "completedAt", where: { completedAt: { not: null } }, holdResourceType: "AviationTriageEncounter", archivable: true, requiresArchive: true },
  { code: "DEPENDENT_DELETED", name: "Deleted dependents", model: "Dependent", dateField: "deletedAt", where: { deletedAt: { not: null } }, archivable: true },
  { code: "CCP_DRAFT_DELETED", name: "Deleted message drafts", model: "CcpDraft", dateField: "deletedAt", where: { deletedAt: { not: null } }, archivable: true },
  { code: "CCP_WEBHOOK_DELETED", name: "Deleted inbound messages", model: "CcpWebhookRecord", dateField: "deletedAt", where: { deletedAt: { not: null } }, archivable: true },
  { code: "CCP_WEBHOOK_RECORD", name: "Inbound message records", model: "CcpWebhookRecord", dateField: "persistedAt", archivable: true },
  { code: "INTEGRATION_INBOUND_LOG", name: "Integration inbound logs", model: "IntegrationInboundLog", dateField: "receivedAt", archivable: true },
  // NFR-108 / NFR-109: the interface log (every call to and from another system) is purged on the agreed rule, archived first.
  { code: "INTERFACE_LOG", name: "Interface logs", model: "InterfaceLog", dateField: "timestamp", archivable: true },
  { code: "USER_SESSION_EXPIRED", name: "Expired sessions", model: "UserSession", dateField: "expiresAt", archivable: false },
  { code: "LOGIN_NONCE", name: "Used sign-in nonces", model: "LoginNonce", dateField: "expiresAt", archivable: false },
  { code: "EXPORT_APPROVAL", name: "Export approvals", model: "ExportApproval", dateField: "requestedAt", archivable: false }
];

type Delegate = {
  findMany(args: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  deleteMany(args: Record<string, unknown>): Promise<{ count: number }>;
};
function modelShape(model: string): { pk: string; hasOrganization: boolean } {
  const meta = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
  if (!meta) throw new Error(`Unknown model ${model}`);
  return { pk: meta.fields.find((f) => f.isId)?.name ?? "id", hasOrganization: meta.fields.some((f) => f.name === "organizationId") };
}
const delegateFor = (client: unknown, model: string) => (client as Record<string, Delegate>)[model.charAt(0).toLowerCase() + model.slice(1)];

export type TargetResult = {
  code: string;
  name: string;
  policySource: string;
  approved: boolean;
  retentionDays: number | null;
  deletionMode: DeletionMode;
  cutoffIso: string | null;
  eligible: number;
  excludedByLegalHold: number;
  archived: number;
  deleted: number;
  note?: string;
};

export async function runRetention(options: { execute: boolean; codes?: string[]; daysOverride?: number; actorUserId?: string; batchSize?: number }): Promise<TargetResult[]> {
  const results: TargetResult[] = [];
  for (const target of RETENTION_TARGETS) {
    if (options.codes && !options.codes.includes(target.code)) continue;
    results.push(await runTarget(target, options));
  }
  return results;
}

async function runTarget(target: RetentionTarget, options: { execute: boolean; daysOverride?: number; actorUserId?: string; batchSize?: number }): Promise<TargetResult> {
  const policy = await basePrisma.retentionPolicy.findUnique({ where: { code: target.code } });
  // A data type without an approved policy is reported and skipped, not an error: a run over every
  // data type must not stop because one of them has not been configured yet.
  const unapproved = options.execute && options.daysOverride === undefined && !policyRetentionDays(policy, false).approved;
  const resolved = policyRetentionDays(policy, options.execute && !unapproved, options.daysOverride);
  const execute = options.execute && !unapproved;
  const policyMode = policy?.deletionMode ?? "archive_then_delete";
  let deletionMode: DeletionMode = isDeletionMode(policyMode) ? policyMode : "archive_then_delete";
  if (target.requiresArchive) deletionMode = "archive_then_delete";
  if (!target.archivable) deletionMode = "hard_delete";
  const base: TargetResult = { code: target.code, name: target.name, policySource: resolved.source, approved: resolved.approved, retentionDays: resolved.days, deletionMode, cutoffIso: null, eligible: 0, excludedByLegalHold: 0, archived: 0, deleted: 0 };
  if (unapproved) return { ...base, note: "Skipped: the policy is missing or not approved (it needs to be active with a period, a decision reference and a legal basis)." };
  if (resolved.days === null) return { ...base, note: "No retention period is set for this data type, so nothing is eligible." };

  const cutoff = new Date(Date.now() - resolved.days * 86_400_000);
  base.cutoffIso = cutoff.toISOString();
  const where = { ...(target.where ?? {}), [target.dateField]: { ...((target.where?.[target.dateField] as object | undefined) ?? {}), lt: cutoff } };
  const delegate = delegateFor(basePrisma, target.model);
  const { pk, hasOrganization } = modelShape(target.model);
  const idOf = (row: Record<string, unknown>) => String(row[pk]);
  const batch = options.batchSize ?? 500;

  const heldIds = new Set<string>();
  const heldOrgs = new Set<string>();
  const loadHolds = async (client: typeof basePrisma) => {
    heldIds.clear();
    heldOrgs.clear();
    if (target.holdResourceType) {
      for (const hold of await client.legalHold.findMany({ where: { resourceType: target.holdResourceType, status: "active" }, select: { resourceId: true } })) heldIds.add(hold.resourceId);
    }
    for (const hold of await client.legalHold.findMany({ where: { resourceType: "Organization", status: "active" }, select: { resourceId: true } })) heldOrgs.add(hold.resourceId);
  };

  await loadHolds(basePrisma);
  const preview = await delegate.findMany({ where, take: 100_000, select: { [pk]: true, ...(hasOrganization ? { organizationId: true } : {}) } });
  const split = excludeLegallyHeld(preview.map((row) => ({ id: idOf(row), organizationId: (row.organizationId as string | null | undefined) ?? null })), heldIds, heldOrgs);
  base.eligible = split.eligible.length;
  base.excludedByLegalHold = split.excluded.length;

  if (execute && split.eligible.length > 0) {
    for (;;) {
      const outcome = await basePrisma.$transaction(
        async (tx) => {
          // Serialize with every legal-hold change, then re-read eligibility: a hold placed first is honoured.
          await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock($1)", LEGAL_HOLD_MUTATION_LOCK_ID);
          await loadHolds(tx as unknown as typeof basePrisma);
          const rows = await delegateFor(tx, target.model).findMany({ where, take: batch });
          const { eligible } = excludeLegallyHeld(rows.map((row) => ({ ...row, id: idOf(row), organizationId: (row.organizationId as string | null | undefined) ?? null })), heldIds, heldOrgs);
          if (eligible.length === 0) return { archived: 0, deleted: 0, done: true };
          let archived = 0;
          if (deletionMode === "archive_then_delete") {
            await tx.archivedRecord.createMany({
              data: eligible.map((row) => ({ entityName: target.model, recordId: idOf(row), policyCode: target.code, payload: JSON.parse(JSON.stringify(row)) }))
            });
            archived = eligible.length;
          }
          const removed = await delegateFor(tx, target.model).deleteMany({ where: { [pk]: { in: eligible.map((row) => idOf(row)) } } });
          return { archived, deleted: removed.count, done: eligible.length < batch };
        },
        { isolationLevel: "Serializable" }
      );
      base.archived += outcome.archived;
      base.deleted += outcome.deleted;
      if (outcome.done) break;
    }
  }

  if (resolved.approved || execute) {
    await appendOperationalAuditEvent({
      action: execute ? "RETENTION_PURGE_EXECUTED" : "RETENTION_PURGE_DRY_RUN",
      module: "DataRetention",
      resource: target.model,
      recordReference: target.code,
      userId: options.actorUserId,
      success: true,
      risk: execute ? "high" : "medium",
      metadata: { runId: randomUUID(), policy: target.code, retentionDays: resolved.days, cutoffIso: base.cutoffIso, eligible: base.eligible, excludedByLegalHold: base.excludedByLegalHold, archived: base.archived, deleted: base.deleted, deletionMode }
    });
  }
  return base;
}
