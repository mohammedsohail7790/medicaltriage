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

export async function submitClinicalApproval(encounterId: string, item: QueueItem): Promise<void> {
  const severity = approvalSeverity(item.calculatedSeverity);
  if (!severity || !item.dispositionCode) {
    throw new Error("The call needs a severity and a disposition before it can be approved.");
  }
  const response = await fetch(`${apiBase}/api/v1/approval/reviews/${encodeURIComponent(encounterId)}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      decision: "approve",
      reviewedReasoningFeatureIds: reasoningFeatureIds(item),
      activeReviewConfirmed: true,
      rulesEngineSeverity: severity,
      finalApprovedSeverity: severity,
      finalDispositionCode: item.dispositionCode,
      featureLevelReasoningReviewed: true
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? payload.message ?? `Clinical approval failed with ${response.status}`);
  }
}
