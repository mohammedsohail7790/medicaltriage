import {
  auditSignatureFor,
  HITL_FORBIDDEN_PAYLOAD,
  isSignedHumanApprovalTrace,
  SafetyKernelError,
  SafetyKernelTraceVerificationError
} from "../src/services/safetyKernel.js";

describe("non-bypassable safety kernel", () => {
  const originalHmacSecret = process.env.AUDIT_HMAC_SECRET;

  beforeEach(() => {
    process.env.AUDIT_HMAC_SECRET = "unit-test-hitl-secret";
  });

  afterEach(() => {
    if (originalHmacSecret === undefined) {
      delete process.env.AUDIT_HMAC_SECRET;
    } else {
      process.env.AUDIT_HMAC_SECRET = originalHmacSecret;
    }
  });

  it("accepts only clinician approvals with a recomputed HMAC signature", () => {
    const approvalTrace = {
      eventType: "HITL_CLINICAL_APPROVAL",
      activeReviewConfirmed: true,
      featureLevelReasoningReviewed: true,
      reviewedReasoningFeatureIds: ["rules-floor", "symptom-red-flag"],
      encounterId: "enc-100",
      finalDispositionCode: "HMC_EMERGENCY_DEPARTMENT"
    };
    const signedApprovalTrace = {
      ...approvalTrace,
      auditSignature: auditSignatureFor(approvalTrace)
    };

    expect(isSignedHumanApprovalTrace([signedApprovalTrace])).toBe(true);
  });

  it("does not accept unsigned or blind-review clinical approvals", () => {
    expect(
      isSignedHumanApprovalTrace([
        {
          eventType: "HITL_CLINICAL_APPROVAL",
          activeReviewConfirmed: true,
          featureLevelReasoningReviewed: false,
          reviewedReasoningFeatureIds: ["rules-floor", "symptom-red-flag"],
          auditSignature: auditSignatureFor({
            eventType: "HITL_CLINICAL_APPROVAL",
            activeReviewConfirmed: true,
            featureLevelReasoningReviewed: false,
            reviewedReasoningFeatureIds: ["rules-floor", "symptom-red-flag"]
          })
        }
      ])
    ).toBe(false);
  });

  it("throws a safety exception for forged approval signatures", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const approvalTrace = {
      eventType: "HITL_CLINICAL_APPROVAL",
      activeReviewConfirmed: true,
      featureLevelReasoningReviewed: true,
      reviewedReasoningFeatureIds: ["rules-floor", "symptom-red-flag"],
      encounterId: "enc-forged",
      finalDispositionCode: "HMC_EMERGENCY_DEPARTMENT",
      auditSignature: "a".repeat(64)
    };

    try {
      expect(() => isSignedHumanApprovalTrace([approvalTrace])).toThrow(SafetyKernelTraceVerificationError);
      expect(errorSpy).toHaveBeenCalledWith("HITL audit signature verification failed", {
        eventType: "HITL_CLINICAL_APPROVAL",
        encounterId: "enc-forged"
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("uses the required 403 payload for blocked external transactions", () => {
    const error = new SafetyKernelError("enc-100", "EMR_WRITEBACK");
    expect(error.status).toBe(403);
    expect(error.payload).toEqual(HITL_FORBIDDEN_PAYLOAD);
  });
});

// M-039: the audit signing key has no fallback outside demonstration mode.
describe("audit signing secret fallback", () => {
  const keys = ["AUDIT_HMAC_SECRET", "AUDIT_SIGNING_SECRET", "AUTH_JWT_SECRET", "MOCK_MODE"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of keys) saved[key] = process.env[key];
    delete process.env.AUDIT_HMAC_SECRET;
    delete process.env.AUDIT_SIGNING_SECRET;
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("refuses to sign with no audit secret when demonstration mode is off", () => {
    process.env.MOCK_MODE = "false";
    expect(() => auditSignatureFor({ a: 1 })).toThrow(/AUDIT_HMAC_SECRET must be set/);
  });

  it("does not fall back to the session-signing secret", () => {
    process.env.MOCK_MODE = "false";
    process.env.AUTH_JWT_SECRET = "a-session-secret-that-must-not-sign-audit-records";
    expect(() => auditSignatureFor({ a: 1 })).toThrow(/AUDIT_HMAC_SECRET must be set/);
  });

  it("signs with the configured secret when one is set", () => {
    process.env.MOCK_MODE = "false";
    process.env.AUDIT_HMAC_SECRET = "configured-audit-secret";
    expect(auditSignatureFor({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the demonstration fallback only in demonstration mode", () => {
    process.env.MOCK_MODE = "true";
    expect(auditSignatureFor({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });
});
