jest.mock("../../auth/apiBase", () => ({ apiBase: "" }));

import { approvalBody, choiceIsValid, higherSeverities } from "./approval";
import type { QueueItem } from "../../QueueContext";

const item = (overrides: Partial<QueueItem> = {}) =>
  ({ id: "c1", reasonNarrative: "Chest pain since this morning.", calculatedSeverity: "URGENT", dispositionCode: "HMC_URGENT_REVIEW", matchedProtocolId: "p1", ...overrides }) as QueueItem;

describe("what a nurse may change when approving", () => {
  it("offers only higher severities, in order", () => {
    expect(higherSeverities("SELF_CARE")).toEqual(["ROUTINE", "URGENT", "EMERGENCY"]);
    expect(higherSeverities("URGENT")).toEqual(["EMERGENCY"]);
    expect(higherSeverities("EMERGENCY")).toEqual([]);
    expect(higherSeverities(undefined)).toEqual([]);
  });

  it("accepts a plain approval, and requires a reason of 12 characters for any change", () => {
    expect(choiceIsValid({ kind: "approve" }, item())).toBe(true);
    expect(choiceIsValid({ kind: "raise", severity: "EMERGENCY", rationale: "short" }, item())).toBe(false);
    expect(choiceIsValid({ kind: "raise", severity: "EMERGENCY", rationale: "Caller is breathless" }, item())).toBe(true);
    expect(choiceIsValid({ kind: "modify", carePlan: "", rationale: "Caller is far from clinic" }, item())).toBe(false);
    expect(choiceIsValid({ kind: "modify", carePlan: "Call back in one hour", rationale: "Caller is far from clinic" }, item())).toBe(true);
  });

  it("refuses to lower or repeat the severity", () => {
    expect(choiceIsValid({ kind: "raise", severity: "ROUTINE", rationale: "Caller feels better now" }, item())).toBe(false);
    expect(choiceIsValid({ kind: "raise", severity: "URGENT", rationale: "Caller feels worse now" }, item())).toBe(false);
  });

  it("builds the request the server expects for approve, override and modify", () => {
    expect(approvalBody(item(), { kind: "approve" })).toMatchObject({ decision: "approve", rulesEngineSeverity: "Urgent", finalApprovedSeverity: "Urgent" });
    expect(approvalBody(item(), { kind: "raise", severity: "EMERGENCY", rationale: "Caller is breathless" })).toMatchObject({
      decision: "override",
      rulesEngineSeverity: "Urgent",
      finalApprovedSeverity: "Emergency",
      nurseOverrideReasonCode: "CLINICIAN_OVERRIDE_UP",
      nurseOverrideRationale: "Caller is breathless"
    });
    expect(approvalBody(item(), { kind: "modify", carePlan: "Call back in one hour", rationale: "Caller is far from clinic" })).toMatchObject({
      decision: "modify",
      finalApprovedSeverity: "Urgent",
      nurseOverrideReasonCode: "CARE_PLAN_MODIFIED",
      modifiedCarePlan: "Call back in one hour"
    });
  });

  it("throws when the change is not valid, before anything is sent", () => {
    expect(() => approvalBody(item(), { kind: "raise", severity: "EMERGENCY", rationale: "no" })).toThrow(/at least 12/);
    expect(() => approvalBody(item({ dispositionCode: undefined }), { kind: "approve" })).toThrow(/severity and a disposition/);
  });
});
