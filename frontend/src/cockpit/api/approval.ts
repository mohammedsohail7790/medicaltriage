import { apiBase } from "../../auth/apiBase";
import type { QueueItem, QueueSeverity } from "../../QueueContext";

// OI-49: completing a call records the nurse's signed clinical approval (POST /api/v1/approval/reviews/:encounterId).
// The server signs the approval and later checks it before any EMR write-back or patient message.
const SEVERITY_LABEL: Record<QueueSeverity, "Emergency" | "Urgent" | "Routine" | "Self-care"> = {
  EMERGENCY: "Emergency",
  URGENT: "Urgent",
  ROUTINE: "Routine",
  SELF_CARE: "Self-care"
};

export function approvalSeverity(severity: QueueSeverity | undefined) {
  return severity ? SEVERITY_LABEL[severity] : undefined;
}

/** The parts of the case the nurse is shown and confirms they have reviewed. */
export function reasoningFeatureIds(item: QueueItem): string[] {
  const ids: string[] = [];
  if (item.reasonNarrative?.trim()) ids.push("reason-for-call");
  if (item.calculatedSeverity) ids.push(`severity:${item.calculatedSeverity}`);
  if (item.safetyFloorActive) ids.push(`safety-floor:${item.safetyFloorSource ?? "active"}`);
  if (item.matchedProtocolId) ids.push(`protocol:${item.matchedProtocolId}`);
  if (item.dispositionCode) ids.push(`disposition:${item.dispositionCode}`);
  for (const key of Object.keys(item.initialAssessmentResponses ?? {})) ids.push(`initial-assessment:${key}`);
  for (const key of Object.keys(item.taqResponses ?? {})) ids.push(`question:${key}`);
  return ids.map((id) => id.slice(0, 120));
}

// A nurse can approve the system's disposition, raise the urgency, or add to the care plan. Lowering urgency is not
// offered: the safety floors only let severity go up, and the server refuses a downgrade without its own sign-off path.
export type ApprovalChoice =
  | { kind: "approve" }
  | { kind: "raise"; severity: QueueSeverity; rationale: string }
  | { kind: "modify"; carePlan: string; rationale: string };

export const MIN_RATIONALE_LENGTH = 12;
const RANK: Record<QueueSeverity, number> = { SELF_CARE: 0, ROUTINE: 1, URGENT: 2, EMERGENCY: 3 };

/** The severities a nurse may raise to: strictly above the current one. */
export function higherSeverities(current: QueueSeverity | undefined): QueueSeverity[] {
  if (!current) return [];
  return (Object.keys(RANK) as QueueSeverity[]).filter((s) => RANK[s] > RANK[current]).sort((a, b) => RANK[a] - RANK[b]);
}

export function choiceIsValid(choice: ApprovalChoice, item: QueueItem): boolean {
  if (choice.kind === "approve") return true;
  if (choice.rationale.trim().length < MIN_RATIONALE_LENGTH) return false;
  if (choice.kind === "raise") return higherSeverities(item.calculatedSeverity).includes(choice.severity);
  return choice.carePlan.trim().length > 0 && choice.carePlan.length <= 2000;
}

export function approvalBody(item: QueueItem, choice: ApprovalChoice) {
  const severity = approvalSeverity(item.calculatedSeverity);
  if (!severity || !item.dispositionCode) {
    throw new Error("The call needs a severity and a disposition before it can be approved.");
  }
  if (!choiceIsValid(choice, item)) throw new Error("Say why you are changing the disposition (at least 12 characters), and choose a higher urgency or write the care plan note.");
  const base = {
    reviewedReasoningFeatureIds: reasoningFeatureIds(item),
    activeReviewConfirmed: true,
    rulesEngineSeverity: severity,
    finalDispositionCode: item.dispositionCode,
    featureLevelReasoningReviewed: true
  };
  if (choice.kind === "raise") {
    return { ...base, decision: "override", finalApprovedSeverity: approvalSeverity(choice.severity), nurseOverrideReasonCode: "CLINICIAN_OVERRIDE_UP", nurseOverrideRationale: choice.rationale.trim() };
  }
  if (choice.kind === "modify") {
    return { ...base, decision: "modify", finalApprovedSeverity: severity, nurseOverrideReasonCode: "CARE_PLAN_MODIFIED", nurseOverrideRationale: choice.rationale.trim(), modifiedCarePlan: choice.carePlan.trim() };
  }
  return { ...base, decision: "approve", finalApprovedSeverity: severity };
}

export async function submitClinicalApproval(encounterId: string, item: QueueItem, choice: ApprovalChoice = { kind: "approve" }): Promise<void> {
  const response = await fetch(`${apiBase}/api/v1/approval/reviews/${encodeURIComponent(encounterId)}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(approvalBody(item, choice))
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? payload.message ?? `Clinical approval failed with ${response.status}`);
  }
}
