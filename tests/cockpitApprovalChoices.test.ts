import { ClinicalApprovalRequestSchema } from "../src/routes/approvalRouter.js";

// The cockpit lets a nurse approve, raise the urgency, or add to the care plan (never lower it). These are the exact
// bodies it sends, checked against the server's own approval rules.
const base = { reviewedReasoningFeatureIds: ["reason-for-call", "severity:URGENT"], activeReviewConfirmed: true, rulesEngineSeverity: "Urgent", finalDispositionCode: "HMC_URGENT_REVIEW", featureLevelReasoningReviewed: true };

describe("cockpit approval choices against the server's rules", () => {
  it("accepts a plain approval", () => {
    expect(ClinicalApprovalRequestSchema.safeParse({ ...base, decision: "approve", finalApprovedSeverity: "Urgent" }).success).toBe(true);
  });

  it("accepts a raise with its reason code and rationale", () => {
    expect(ClinicalApprovalRequestSchema.safeParse({ ...base, decision: "override", finalApprovedSeverity: "Emergency", nurseOverrideReasonCode: "CLINICIAN_OVERRIDE_UP", nurseOverrideRationale: "Caller sounds breathless on the line" }).success).toBe(true);
  });

  it("refuses a raise without a rationale", () => {
    expect(ClinicalApprovalRequestSchema.safeParse({ ...base, decision: "override", finalApprovedSeverity: "Emergency", nurseOverrideReasonCode: "CLINICIAN_OVERRIDE_UP" }).success).toBe(false);
  });

  it("accepts a care plan note with its reason code and rationale", () => {
    expect(ClinicalApprovalRequestSchema.safeParse({ ...base, decision: "modify", finalApprovedSeverity: "Urgent", nurseOverrideReasonCode: "CARE_PLAN_MODIFIED", nurseOverrideRationale: "Caller lives far from the clinic", modifiedCarePlan: "Call back in one hour" }).success).toBe(true);
  });

  it("refuses any attempt to lower the severity below the rules engine without the downgrade-blocked path", () => {
    const lowered = ClinicalApprovalRequestSchema.safeParse({ ...base, decision: "override", finalApprovedSeverity: "Routine", nurseOverrideReasonCode: "CLINICIAN_OVERRIDE_UP", nurseOverrideRationale: "Caller feels better now" });
    expect(lowered.success).toBe(false);
  });
});
