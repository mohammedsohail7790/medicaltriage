import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { shouldPersistPlatformInDatabase } from "../config/runtime.js";
import { prisma } from "../db.js";
import type { AuthenticatedSession } from "../types/security.js";
import { listCompletedCallsForReview } from "./queueOrchestration.js";

/**
 * Clinical work items that follow a case without being part of the encounter record:
 *   incident     a clinical incident or near miss, linked to a call, managed by the Clinical Safety Officer (F-021)
 *   qa_review    a randomly sampled completed call waiting for a quality review (F-020)
 *   teleconsult  a case handed to a teleconsultant physician (F-016)
 *   referral     a referral letter awaiting the nurse's approval (F-017)
 * Items live in the database when platform persistence is on, and in memory otherwise.
 */

export type WorkKind = "incident" | "qa_review" | "teleconsult" | "referral" | "setting" | "branch_rule";

export type WorkItem = {
  id: string;
  kind: WorkKind;
  status: string;
  caseRef?: string;
  organizationId?: string;
  createdBy: string;
  assignee?: string;
  payload: Record<string, unknown>;
  createdAtIso: string;
  updatedAtIso: string;
};

export class WorkError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
    this.name = "WorkError";
  }
}

const memory = new Map<string, WorkItem>();
export function resetClinicalWorkForTests(): void {
  memory.clear();
}
const useDatabase = () => shouldPersistPlatformInDatabase();

function fromRow(row: { id: string; kind: string; status: string; caseRef: string | null; organizationId: string | null; createdBy: string; assignee: string | null; payload: unknown; createdAt: Date; updatedAt: Date }): WorkItem {
  return {
    id: row.id, kind: row.kind as WorkKind, status: row.status, caseRef: row.caseRef ?? undefined, organizationId: row.organizationId ?? undefined,
    createdBy: row.createdBy, assignee: row.assignee ?? undefined, payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAtIso: row.createdAt.toISOString(), updatedAtIso: row.updatedAt.toISOString()
  };
}

export async function createItem(input: { kind: WorkKind; status: string; caseRef?: string; organizationId?: string; createdBy: string; assignee?: string; payload: Record<string, unknown> }): Promise<WorkItem> {
  if (useDatabase()) {
    const row = await prisma.clinicalWorkItem.create({ data: { kind: input.kind, status: input.status, caseRef: input.caseRef, organizationId: input.organizationId, createdBy: input.createdBy, assignee: input.assignee, payload: input.payload as never } });
    return fromRow(row);
  }
  const now = new Date().toISOString();
  const item: WorkItem = { id: randomUUID(), createdAtIso: now, updatedAtIso: now, ...input };
  memory.set(item.id, item);
  return item;
}

export async function getItem(id: string, kind?: WorkKind): Promise<WorkItem | undefined> {
  const found = useDatabase() ? (await prisma.clinicalWorkItem.findUnique({ where: { id } }).then((row) => (row ? fromRow(row) : undefined))) : memory.get(id);
  return found && (!kind || found.kind === kind) ? found : undefined;
}

export async function listItems(filter: { kind: WorkKind; status?: string; caseRef?: string; organizationId?: string; limit?: number }): Promise<WorkItem[]> {
  const limit = Math.min(filter.limit ?? 200, 1000);
  if (useDatabase()) {
    const rows = await prisma.clinicalWorkItem.findMany({
      where: { kind: filter.kind, ...(filter.status ? { status: filter.status } : {}), ...(filter.caseRef ? { caseRef: filter.caseRef } : {}), ...(filter.organizationId ? { organizationId: filter.organizationId } : {}) },
      orderBy: { createdAt: "desc" }, take: limit
    });
    return rows.map(fromRow);
  }
  return [...memory.values()]
    .filter((i) => i.kind === filter.kind && (!filter.status || i.status === filter.status) && (!filter.caseRef || i.caseRef === filter.caseRef) && (!filter.organizationId || i.organizationId === filter.organizationId))
    .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso))
    .slice(0, limit);
}

export async function updateItem(id: string, patch: { status?: string; assignee?: string | null; payload?: Record<string, unknown> }): Promise<WorkItem> {
  const current = await getItem(id);
  if (!current) throw new WorkError(404, "Item not found.", "WORK_ITEM_NOT_FOUND");
  const payload = patch.payload ? { ...current.payload, ...patch.payload } : current.payload;
  if (useDatabase()) {
    const row = await prisma.clinicalWorkItem.update({ where: { id }, data: { ...(patch.status ? { status: patch.status } : {}), ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}), payload: payload as never } });
    return fromRow(row);
  }
  const next: WorkItem = { ...current, status: patch.status ?? current.status, assignee: patch.assignee === undefined ? current.assignee : patch.assignee ?? undefined, payload, updatedAtIso: new Date().toISOString() };
  memory.set(id, next);
  return next;
}

// ---- F-021 incident and near-miss reports ----------------------------------------------------------

export const INCIDENT_SEVERITIES = ["low", "moderate", "high", "critical"] as const;

export const IncidentInput = z.object({
  type: z.enum(["incident", "near_miss"]),
  severity: z.enum(INCIDENT_SEVERITIES),
  caseRef: z.string().trim().min(1).max(160).optional(),
  occurredAtIso: z.string().datetime().optional(),
  description: z.string().trim().min(10).max(4000),
  immediateAction: z.string().trim().max(2000).optional()
});

export const IncidentClosure = z.object({ outcome: z.string().trim().min(5).max(2000), correctiveActions: z.array(z.string().trim().min(2).max(500)).max(20).default([]), shareLearning: z.boolean().default(false) });

export async function reportIncident(input: z.infer<typeof IncidentInput>, session: AuthenticatedSession): Promise<WorkItem> {
  return createItem({
    kind: "incident", status: "reported", caseRef: input.caseRef, organizationId: session.user.organizationId ?? undefined, createdBy: session.user.id,
    payload: { type: input.type, severity: input.severity, description: input.description, immediateAction: input.immediateAction ?? null, occurredAtIso: input.occurredAtIso ?? new Date().toISOString(), reporterRole: session.activeRole }
  });
}

export async function takeIncidentForReview(id: string, session: AuthenticatedSession): Promise<WorkItem> {
  const item = await getItem(id, "incident");
  if (!item) throw new WorkError(404, "Incident not found.", "INCIDENT_NOT_FOUND");
  if (item.status !== "reported") throw new WorkError(409, "Only a reported incident can be taken for review.", "INCIDENT_STATE");
  return updateItem(id, { status: "under_review", assignee: session.user.id });
}

export async function closeIncident(id: string, input: z.infer<typeof IncidentClosure>, session: AuthenticatedSession): Promise<WorkItem> {
  const item = await getItem(id, "incident");
  if (!item) throw new WorkError(404, "Incident not found.", "INCIDENT_NOT_FOUND");
  if (item.status === "closed") throw new WorkError(409, "The incident is already closed.", "INCIDENT_STATE");
  // The reporter may not close their own report: a second person looks at it.
  if (item.createdBy === session.user.id) throw new WorkError(403, "A report cannot be closed by the person who made it.", "INCIDENT_SELF_CLOSE");
  return updateItem(id, { status: "closed", assignee: session.user.id, payload: { ...input, closedAtIso: new Date().toISOString(), closedBy: session.user.id } });
}

// ---- F-020 randomised call review sampling ---------------------------------------------------------

export const SamplingInput = z.object({
  count: z.number().int().min(1).max(500).optional(),
  percent: z.number().min(0.1).max(100).optional(),
  fromIso: z.string().datetime().optional(),
  toIso: z.string().datetime().optional()
}).refine((v) => v.count !== undefined || v.percent !== undefined, "Give a count or a percentage.");

/** Fisher-Yates with a cryptographic source, so a selection cannot be steered. */
export function drawRandom<T>(pool: T[], size: number, pick: (maxExclusive: number) => number = randomInt): T[] {
  const copy = [...pool];
  const n = Math.min(size, copy.length);
  for (let i = 0; i < n; i += 1) {
    const j = i + pick(copy.length - i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

export async function sampleCalls(input: z.infer<typeof SamplingInput>, session: AuthenticatedSession, pick?: (maxExclusive: number) => number): Promise<{ selectionId: string; eligible: number; selected: WorkItem[] }> {
  const completed = await listCompletedCallsForReview(session);
  const already = new Set((await listItems({ kind: "qa_review", limit: 1000 })).map((item) => item.caseRef));
  const from = input.fromIso ? Date.parse(input.fromIso) : 0;
  const to = input.toIso ? Date.parse(input.toIso) : Number.MAX_SAFE_INTEGER;
  const eligible = completed.filter((call) => {
    const at = call.completedAtIso ? Date.parse(call.completedAtIso) : Number.NaN;
    return !already.has(call.id) && Number.isFinite(at) && at >= from && at <= to;
  });
  const size = input.count ?? Math.max(1, Math.ceil((eligible.length * (input.percent ?? 0)) / 100));
  const chosen = eligible.length === 0 ? [] : drawRandom(eligible, size, pick);
  const selectionId = randomUUID();
  const sampledAtIso = new Date().toISOString();
  const selected: WorkItem[] = [];
  for (const call of chosen) {
    selected.push(await createItem({
      kind: "qa_review", status: "pending", caseRef: call.id, organizationId: call.organizationId, createdBy: session.user.id,
      payload: { selectionId, sampledAtIso, handlingNurseId: call.assignedNurseId ?? null, severity: call.severity ?? null, dispositionCode: call.dispositionCode ?? null, department: call.department ?? null, criteria: { count: input.count ?? null, percent: input.percent ?? null, fromIso: input.fromIso ?? null, toIso: input.toIso ?? null, eligible: eligible.length } }
    }));
  }
  return { selectionId, eligible: eligible.length, selected };
}

/** What a reviewer sees of a sampled call: the drawer is masked, so no identity and no narrative. */
export function maskedReviewView(item: WorkItem): Record<string, unknown> {
  const p = item.payload;
  return { id: item.id, status: item.status, caseRef: item.caseRef, sampledAtIso: p.sampledAtIso, severity: p.severity, dispositionCode: p.dispositionCode, department: p.department, review: p.review ?? null };
}

export const QaReviewInput = z.object({
  score: z.number().int().min(1).max(5),
  findings: z.string().trim().min(5).max(3000),
  followUp: z.enum(["none", "coaching", "incident"]).default("none")
});

export async function listQaQueue(session: AuthenticatedSession): Promise<WorkItem[]> {
  const items = await listItems({ kind: "qa_review", status: "pending" });
  const org = session.user.organizationId;
  // A reviewer sees their own organisation's samples, and never a call they handled themselves.
  return items.filter((item) => item.payload.handlingNurseId !== session.user.id && (!org || !item.organizationId || item.organizationId === org));
}

export async function submitQaReview(id: string, input: z.infer<typeof QaReviewInput>, session: AuthenticatedSession): Promise<WorkItem> {
  const item = await getItem(id, "qa_review");
  if (!item) throw new WorkError(404, "Sampled call not found.", "QA_ITEM_NOT_FOUND");
  if (item.status !== "pending") throw new WorkError(409, "This sampled call has already been reviewed.", "QA_STATE");
  if (item.payload.handlingNurseId === session.user.id) throw new WorkError(403, "A reviewer cannot review their own call.", "QA_SELF_REVIEW");
  if (session.user.organizationId && item.organizationId && item.organizationId !== session.user.organizationId) throw new WorkError(404, "Sampled call not found.", "QA_ITEM_NOT_FOUND");
  return updateItem(id, { status: "reviewed", assignee: session.user.id, payload: { review: { ...input, reviewerId: session.user.id, reviewedAtIso: new Date().toISOString() } } });
}
