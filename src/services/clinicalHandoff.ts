import { randomInt } from "node:crypto";
import { z } from "zod";
import { callExternal } from "../integration/externalClient.js";
import { getEmailAdapter } from "./communicationAdapters.js";
import { WorkError, createItem, getItem, updateItem, type WorkItem } from "./clinicalWork.js";
import { renderReferralPdf, type ReferralFields } from "./referralLetter.js";
import { listPersistedAuditEvents } from "./persistence.js";
import { listAuditEvents } from "./securityAdmin.js";
import type { AuthenticatedSession } from "../types/security.js";

/**
 * Handoffs out of the triage call: the referral letter (F-017) and the escalation to a teleconsultant physician
 * (F-016). In both, nothing leaves the system until the triage nurse has approved it.
 */

// ---- shared ---------------------------------------------------------------------------------------

/** True when a nurse has recorded a signed clinical approval for the encounter (the human-review checkpoint). */
export async function hasSignedClinicalApproval(encounterId: string): Promise<boolean> {
  const resource = `AviationTriageEncounter:${encounterId}`;
  const memoryHit = listAuditEvents({ action: "CLINICAL_APPROVAL_REVIEW" }).some((event) => event.resource === resource && event.success);
  if (memoryHit) return true;
  try {
    return (await listPersistedAuditEvents(200, { action: "CLINICAL_APPROVAL_REVIEW" })).some((event) => event.resource === resource && event.success);
  } catch {
    return false;
  }
}

/** In production a signed clinical approval is required before anything is sent; elsewhere it can be switched on. */
export function signedApprovalRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.HANDOFF_REQUIRES_SIGNED_APPROVAL;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return env.NODE_ENV === "production";
}

async function requireApprovalIfConfigured(caseRef: string | undefined): Promise<void> {
  if (!signedApprovalRequired()) return;
  if (!caseRef || !(await hasSignedClinicalApproval(caseRef))) {
    throw new WorkError(409, "A signed clinical approval for this case is required before anything is sent.", "SIGNED_APPROVAL_REQUIRED");
  }
}

// ---- F-017 referral letter -------------------------------------------------------------------------

export const ReferralInput = z.object({
  caseRef: z.string().trim().min(1).max(160),
  patientName: z.string().trim().max(160).optional(),
  istStaffId: z.string().trim().min(3).max(64).optional(),
  patientAgeYears: z.number().int().min(0).max(120).optional(),
  destinationName: z.string().trim().min(2).max(160),
  destinationPhone: z.string().trim().max(40).optional(),
  destinationHours: z.string().trim().max(120).optional(),
  destinationAddress: z.string().trim().max(300).optional(),
  reason: z.string().trim().min(3).max(1000),
  assessment: z.string().trim().min(3).max(2000),
  recommendation: z.string().trim().min(3).max(2000),
  adviceDelivery: z.enum(["give_now", "send_later"]).optional()
});

export function referralFields(item: WorkItem): ReferralFields {
  return item.payload.fields as ReferralFields;
}

export async function createReferral(input: z.infer<typeof ReferralInput>, session: AuthenticatedSession): Promise<WorkItem> {
  const fields: ReferralFields = {
    patientName: input.patientName, istStaffId: input.istStaffId, patientAgeYears: input.patientAgeYears,
    destinationName: input.destinationName, destinationPhone: input.destinationPhone, destinationHours: input.destinationHours, destinationAddress: input.destinationAddress,
    reason: input.reason, assessment: input.assessment, recommendation: input.recommendation, adviceDelivery: input.adviceDelivery,
    // The nurse is the signed-in user (F-015).
    nurseName: session.user.fullName, issuedAtIso: new Date().toISOString(), reference: `REF-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomInt(1000, 9999)}`
  };
  return createItem({ kind: "referral", status: "draft", caseRef: input.caseRef, organizationId: session.user.organizationId ?? undefined, createdBy: session.user.id, payload: { fields } });
}

async function loadReferral(id: string): Promise<WorkItem> {
  const item = await getItem(id, "referral");
  if (!item) throw new WorkError(404, "Referral not found.", "REFERRAL_NOT_FOUND");
  return item;
}

export async function referralPdf(id: string, session: AuthenticatedSession): Promise<{ item: WorkItem; pdf: Buffer }> {
  const item = await loadReferral(id);
  assertSameOrganisation(item, session);
  return { item, pdf: await renderReferralPdf(referralFields(item), { approved: item.status === "approved" || item.status === "sent" }) };
}

function assertSameOrganisation(item: WorkItem, session: AuthenticatedSession): void {
  const org = session.user.organizationId;
  if (org && item.organizationId && item.organizationId !== org) throw new WorkError(404, "Not found.", "NOT_FOUND");
}

export async function approveReferral(id: string, session: AuthenticatedSession): Promise<WorkItem> {
  const item = await loadReferral(id);
  assertSameOrganisation(item, session);
  if (item.status !== "draft") throw new WorkError(409, "Only a draft can be approved.", "REFERRAL_STATE");
  // Only the nurse who wrote the letter approves it.
  if (item.createdBy !== session.user.id) throw new WorkError(403, "A referral is approved by the nurse who prepared it.", "REFERRAL_APPROVER");
  await requireApprovalIfConfigured(item.caseRef);
  return updateItem(id, { status: "approved", payload: { approvedBy: session.user.id, approvedAtIso: new Date().toISOString() } });
}

/** Recipient domains a letter may be emailed to. Empty means nothing may be emailed. */
export function allowedRecipientDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.REFERRAL_ALLOWED_RECIPIENT_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
}

export async function sendReferral(id: string, to: string, session: AuthenticatedSession): Promise<WorkItem> {
  const item = await loadReferral(id);
  assertSameOrganisation(item, session);
  if (item.status !== "approved") throw new WorkError(409, "The referral must be approved by the nurse before it can be sent.", "REFERRAL_NOT_APPROVED");
  const domain = to.split("@")[1]?.toLowerCase();
  if (!domain || !allowedRecipientDomains().includes(domain)) throw new WorkError(403, "That address is not on the list of approved recipients.", "REFERRAL_RECIPIENT");
  const { pdf } = await referralPdf(id, session);
  const fields = referralFields(item);
  const result = await getEmailAdapter().send({
    to, subject: `Referral ${fields.reference}`,
    body: "Please find the referral letter attached. It was prepared from a tele-triage assessment and approved by the triage nurse.",
    attachments: [{ name: `${fields.reference}.pdf`, contentType: "application/pdf", contentBase64: pdf.toString("base64") }]
  });
  return updateItem(id, { status: result.ok ? "sent" : "send_failed", payload: { sentTo: to, sentAtIso: new Date().toISOString(), transport: result.provider, dryRun: result.dryRun, sendDetail: result.ok ? result.message : result.error ?? result.message } });
}

// ---- F-016 teleconsultant escalation ---------------------------------------------------------------

export const HandoffInput = z.object({
  caseRef: z.string().trim().min(1).max(160),
  urgency: z.enum(["routine", "urgent", "emergency"]),
  question: z.string().trim().min(5).max(2000),
  summary: z.string().trim().min(5).max(4000)
});

export const HandoffResponse = z.object({
  advice: z.string().trim().min(5).max(4000),
  outcome: z.enum(["agree_with_nurse", "change_disposition", "needs_call_back", "needs_emergency_services"]),
  suggestedDisposition: z.string().trim().max(120).optional()
});

export async function proposeHandoff(input: z.infer<typeof HandoffInput>, session: AuthenticatedSession): Promise<WorkItem> {
  return createItem({ kind: "teleconsult", status: "awaiting_nurse_approval", caseRef: input.caseRef, organizationId: session.user.organizationId ?? undefined, createdBy: session.user.id, payload: { ...input, nurseName: session.user.fullName } });
}

export type TeleconsultTransport = (handoff: { id: string; caseRef?: string; urgency: unknown; question: unknown; summary: unknown; nurseId: string; nurseName: unknown }) => Promise<{ delivered: boolean; mode: string; reference?: string }>;
let transportOverride: TeleconsultTransport | undefined;
export function setTeleconsultTransportForTests(t: TeleconsultTransport | undefined): void {
  transportOverride = t;
}

/** Dry run unless the teleconsultant service address is configured; then a signed call to that service. */
async function deliverToTeleconsultService(handoff: Parameters<TeleconsultTransport>[0]): ReturnType<TeleconsultTransport> {
  if (transportOverride) return transportOverride(handoff);
  const url = process.env.TELECONSULT_URL;
  if (!url || process.env.INTEGRATION_TELECONSULT_MODE !== "live") return { delivered: true, mode: "dry-run" };
  const response = await callExternal("teleconsult", url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.TELECONSULT_TOKEN ?? ""}` }, body: JSON.stringify(handoff) }, { attempts: 3, correlationId: handoff.id });
  if (!response.ok) throw new WorkError(502, "The teleconsultant service did not accept the case.", "TELECONSULT_REJECTED");
  const body = (await response.json().catch(() => ({}))) as { reference?: string };
  return { delivered: true, mode: "live", reference: body.reference };
}

export async function approveHandoff(id: string, session: AuthenticatedSession): Promise<WorkItem> {
  const item = await getItem(id, "teleconsult");
  if (!item) throw new WorkError(404, "Handoff not found.", "HANDOFF_NOT_FOUND");
  assertSameOrganisation(item, session);
  if (item.status !== "awaiting_nurse_approval") throw new WorkError(409, "This handoff is not waiting for approval.", "HANDOFF_STATE");
  if (item.createdBy !== session.user.id) throw new WorkError(403, "A handoff is approved by the nurse who prepared it.", "HANDOFF_APPROVER");
  await requireApprovalIfConfigured(item.caseRef);
  const delivery = await deliverToTeleconsultService({ id: item.id, caseRef: item.caseRef, urgency: item.payload.urgency, question: item.payload.question, summary: item.payload.summary, nurseId: item.createdBy, nurseName: item.payload.nurseName });
  return updateItem(id, { status: "queued", payload: { approvedAtIso: new Date().toISOString(), delivery } });
}

export async function acceptHandoff(id: string, session: AuthenticatedSession): Promise<WorkItem> {
  const item = await getItem(id, "teleconsult");
  if (!item) throw new WorkError(404, "Handoff not found.", "HANDOFF_NOT_FOUND");
  assertSameOrganisation(item, session);
  if (item.status !== "queued") throw new WorkError(409, "Only a queued handoff can be accepted.", "HANDOFF_STATE");
  return updateItem(id, { status: "accepted", assignee: session.user.id, payload: { acceptedAtIso: new Date().toISOString() } });
}

export async function respondToHandoff(id: string, input: z.infer<typeof HandoffResponse>, session: AuthenticatedSession): Promise<WorkItem> {
  const item = await getItem(id, "teleconsult");
  if (!item) throw new WorkError(404, "Handoff not found.", "HANDOFF_NOT_FOUND");
  assertSameOrganisation(item, session);
  if (item.status !== "accepted") throw new WorkError(409, "Accept the case before answering it.", "HANDOFF_STATE");
  if (item.assignee !== session.user.id) throw new WorkError(403, "Only the physician who accepted the case can answer it.", "HANDOFF_ASSIGNEE");
  return updateItem(id, { status: "answered", payload: { response: { ...input, physicianId: session.user.id, physicianName: session.user.fullName, answeredAtIso: new Date().toISOString() } } });
}

