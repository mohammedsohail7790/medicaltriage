import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { shouldUseDatabasePersistence } from "../config/runtime.js";
import { requireSecret } from "../config/secrets.js";
import type { AuthenticatedSession } from "../types/security.js";
import { recordAuditEvent } from "./securityAdmin.js";
import { signAuditPayload } from "./auditForwarding.js";

/**
 * Export governance (M-021).
 *
 * - Every export attempt is written to the audit trail: requested, denied or completed.
 * - Administrator exports (organisation data) need a second administrator's approval.
 *   The approval is bound to the requester and the organisation, expires, and can be
 *   used once.
 * - Exports can be disabled by configuration: EXPORTS_ENABLED=false stops all of them,
 *   EXPORTS_DISABLED_KINDS=self,organization stops named kinds.
 * - A DLP tool can inspect each export before release. Only metadata is sent (who,
 *   what kind, how many records, size and a SHA-256 of the file), never the content.
 */

export type ExportKind = "self" | "organization";

export class ExportGovernanceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "ExportGovernanceError";
  }
}

// ---------------------------------------------------------------- policy

export function assertExportEnabled(kind: ExportKind, env: Record<string, string | undefined> = process.env): void {
  const enabled = (env.EXPORTS_ENABLED ?? "true").trim().toLowerCase() !== "false";
  const disabledKinds = (env.EXPORTS_DISABLED_KINDS ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (!enabled || disabledKinds.includes(kind)) {
    throw new ExportGovernanceError(403, "Exports are disabled by configuration.", "EXPORTS_DISABLED");
  }
}

// -------------------------------------------------------------- approvals

export type ExportApprovalStatus = "pending" | "approved" | "rejected";

export type ExportApprovalRecord = {
  id: string;
  exportKind: ExportKind;
  resourceId: string;
  requesterId: string;
  reason: string;
  status: ExportApprovalStatus;
  approverId?: string;
  comments?: string;
  requestedAtIso: string;
  expiresAtIso: string;
  decidedAtIso?: string;
  consumedAtIso?: string;
};

const memoryApprovals = new Map<string, ExportApprovalRecord>();

export function resetExportGovernanceForTests(): void {
  memoryApprovals.clear();
  dlpFetch = undefined;
}

function ttlMs(): number {
  const minutes = Number(process.env.EXPORT_APPROVAL_TTL_MINUTES ?? "60");
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60 * 1000;
}

type DbApproval = {
  id: string; exportKind: string; resourceId: string; requesterId: string; reason: string; status: string;
  approverId: string | null; comments: string | null; requestedAt: Date; expiresAt: Date; decidedAt: Date | null; consumedAt: Date | null;
};

function fromRow(row: DbApproval): ExportApprovalRecord {
  return {
    id: row.id,
    exportKind: row.exportKind as ExportKind,
    resourceId: row.resourceId,
    requesterId: row.requesterId,
    reason: row.reason,
    status: row.status as ExportApprovalStatus,
    approverId: row.approverId ?? undefined,
    comments: row.comments ?? undefined,
    requestedAtIso: row.requestedAt.toISOString(),
    expiresAtIso: row.expiresAt.toISOString(),
    decidedAtIso: row.decidedAt?.toISOString(),
    consumedAtIso: row.consumedAt?.toISOString()
  };
}

async function loadApproval(id: string): Promise<ExportApprovalRecord | undefined> {
  if (!shouldUseDatabasePersistence()) return memoryApprovals.get(id);
  const row = await prisma.exportApproval.findUnique({ where: { id } });
  return row ? fromRow(row) : undefined;
}

export async function requestExportApproval(input: {
  exportKind: ExportKind;
  resourceId: string;
  requesterId: string;
  reason: string;
}): Promise<ExportApprovalRecord> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs());
  if (!shouldUseDatabasePersistence()) {
    const record: ExportApprovalRecord = {
      id: `exp-${randomUUID()}`,
      ...input,
      status: "pending",
      requestedAtIso: now.toISOString(),
      expiresAtIso: expiresAt.toISOString()
    };
    memoryApprovals.set(record.id, record);
    return record;
  }
  const row = await prisma.exportApproval.create({
    data: { exportKind: input.exportKind, resourceId: input.resourceId, requesterId: input.requesterId, reason: input.reason, expiresAt }
  });
  return fromRow(row);
}

export async function decideExportApproval(input: {
  id: string;
  approverId: string;
  decision: "approve" | "reject";
  comments?: string;
}): Promise<ExportApprovalRecord> {
  const current = await loadApproval(input.id);
  if (!current) throw new ExportGovernanceError(404, "Export request not found.", "EXPORT_REQUEST_NOT_FOUND");
  if (current.status !== "pending") throw new ExportGovernanceError(409, "This export request has already been decided.", "EXPORT_REQUEST_DECIDED");
  if (new Date(current.expiresAtIso).getTime() <= Date.now()) throw new ExportGovernanceError(410, "This export request has expired.", "EXPORT_REQUEST_EXPIRED");
  if (current.requesterId === input.approverId) {
    throw new ExportGovernanceError(403, "A second administrator must approve the export; you cannot approve your own request.", "EXPORT_SELF_APPROVAL");
  }
  const status: ExportApprovalStatus = input.decision === "approve" ? "approved" : "rejected";
  const decidedAt = new Date();
  if (!shouldUseDatabasePersistence()) {
    const updated = { ...current, status, approverId: input.approverId, comments: input.comments, decidedAtIso: decidedAt.toISOString() };
    memoryApprovals.set(updated.id, updated);
    return updated;
  }
  const result = await prisma.exportApproval.updateMany({
    where: { id: input.id, status: "pending" },
    data: { status, approverId: input.approverId, comments: input.comments, decidedAt }
  });
  if (result.count !== 1) throw new ExportGovernanceError(409, "This export request has already been decided.", "EXPORT_REQUEST_DECIDED");
  return (await loadApproval(input.id))!;
}

/** Marks an approval used. Succeeds once, for the original requester and organisation only. */
export async function consumeExportApproval(input: {
  id: string | undefined;
  exportKind: ExportKind;
  resourceId: string;
  requesterId: string;
  /** false checks the approval without using it (used before the data is read). */
  consume?: boolean;
}): Promise<ExportApprovalRecord> {
  if (!input.id) throw new ExportGovernanceError(403, "An approved export request is required for this export.", "EXPORT_APPROVAL_REQUIRED");
  const current = await loadApproval(input.id);
  if (!current || current.exportKind !== input.exportKind || current.resourceId !== input.resourceId || current.requesterId !== input.requesterId) {
    throw new ExportGovernanceError(403, "No approved export request matches this export.", "EXPORT_APPROVAL_REQUIRED");
  }
  if (current.status !== "approved") throw new ExportGovernanceError(403, "The export request has not been approved.", "EXPORT_APPROVAL_REQUIRED");
  if (current.consumedAtIso) throw new ExportGovernanceError(403, "This approval has already been used.", "EXPORT_APPROVAL_USED");
  if (new Date(current.expiresAtIso).getTime() <= Date.now()) throw new ExportGovernanceError(410, "This approval has expired.", "EXPORT_REQUEST_EXPIRED");
  if (input.consume === false) return current;
  const consumedAt = new Date();
  if (!shouldUseDatabasePersistence()) {
    const updated = { ...current, consumedAtIso: consumedAt.toISOString() };
    memoryApprovals.set(updated.id, updated);
    return updated;
  }
  const result = await prisma.exportApproval.updateMany({
    where: { id: input.id, status: "approved", consumedAt: null },
    data: { consumedAt }
  });
  if (result.count !== 1) throw new ExportGovernanceError(403, "This approval has already been used.", "EXPORT_APPROVAL_USED");
  return { ...current, consumedAtIso: consumedAt.toISOString() };
}

// ------------------------------------------------------------------- DLP

export type ExportDescriptor = {
  kind: ExportKind;
  actorUserId: string;
  actorRole: string;
  organizationId: string;
  resourceId: string;
  recordCount: number;
  bytes: number;
  sha256: string;
};

type DlpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
let dlpFetch: DlpFetch | undefined;

export function setExportDlpFetchForTests(fn: DlpFetch | undefined): void {
  dlpFetch = fn;
}

export function describeExport(kind: ExportKind, session: AuthenticatedSession, resourceId: string, body: unknown, recordCount: number): ExportDescriptor {
  const text = JSON.stringify(body);
  return {
    kind,
    actorUserId: session.user.id,
    actorRole: session.activeRole,
    organizationId: session.user.organizationId ?? "",
    resourceId,
    recordCount,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text).digest("hex")
  };
}

/**
 * Asks the configured DLP endpoint to allow the export. With EXPORT_DLP_URL unset this
 * does nothing. A reachable endpoint that answers allow:false blocks the export. If the
 * endpoint is unreachable the export is blocked unless EXPORT_DLP_FAIL_MODE=open.
 */
export async function inspectExportWithDlp(descriptor: ExportDescriptor, env: Record<string, string | undefined> = process.env): Promise<void> {
  const url = env.EXPORT_DLP_URL?.trim();
  if (!url) return;
  const failOpen = (env.EXPORT_DLP_FAIL_MODE ?? "closed").trim().toLowerCase() === "open";
  const body = JSON.stringify({ event: "export_inspection", requestedAtIso: new Date().toISOString(), ...descriptor });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.EXPORT_DLP_TIMEOUT_MS ?? "5000") || 5000);
  try {
    const send = dlpFetch ?? ((target, init) => fetch(target, init) as unknown as ReturnType<DlpFetch>);
    const response = await send(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dlp-signature": signAuditPayload(body, requireSecret("EXPORT_DLP_SECRET")) },
      body,
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`DLP endpoint answered HTTP ${response.status}`);
    const verdict = (await response.json()) as { allow?: unknown };
    if (verdict.allow !== true) {
      throw new ExportGovernanceError(403, "The data loss prevention policy blocked this export.", "EXPORT_BLOCKED_BY_DLP");
    }
  } catch (error) {
    if (error instanceof ExportGovernanceError) throw error;
    if (failOpen) return;
    throw new ExportGovernanceError(503, "The data loss prevention check could not be completed, so the export was not released.", "EXPORT_DLP_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------- audit

export async function recordExportEvent(args: {
  action: "EXPORT_REQUESTED" | "EXPORT_APPROVAL_DECIDED" | "EXPORT_COMPLETED" | "EXPORT_DENIED";
  kind: ExportKind;
  session: AuthenticatedSession;
  resourceId: string;
  success: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await recordAuditEvent({
    id: `export-${randomUUID()}`,
    timestampIso: new Date().toISOString(),
    userId: args.session.user.id,
    activeRole: args.session.activeRole,
    organization: args.session.user.organizationId ?? "",
    facility: "",
    department: "",
    action: args.action,
    module: "DataExport",
    resource: `Export:${args.kind}:${args.resourceId}`,
    ipAddress: "",
    device: "",
    success: args.success,
    risk: args.kind === "organization" ? "high" : "medium",
    metadata: { kind: args.kind, ...args.metadata }
  });
}
