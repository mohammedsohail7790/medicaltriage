// The clinical actions panel has its own tests (clinical/ClinicalWorkspace.test.tsx).
jest.mock("../ClinicalActionsPanel", () => ({ ClinicalActionsPanel: () => null }));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CompletionStage } from "./CompletionStage";
import type { QueueItem } from "../../QueueContext";

const updateItemContext = jest.fn().mockResolvedValue(undefined);
const moveItem = jest.fn().mockResolvedValue(undefined);

jest.mock("../../QueueContext", () => ({
  useQueue: () => ({ updateItemContext, moveItem })
}));

const previewTriageCompletion = jest.fn();
const compileTriageCompletion = jest.fn();

jest.mock("../api/triageCompletion", () => ({
  previewTriageCompletion: (...args: unknown[]) => previewTriageCompletion(...args),
  compileTriageCompletion: (...args: unknown[]) => compileTriageCompletion(...args)
}));

jest.mock("../../auth/apiBase", () => ({ apiBase: "" }));

const submitClinicalApproval = jest.fn();
jest.mock("../api/approval", () => ({
  ...jest.requireActual("../api/approval"),
  submitClinicalApproval: (...args: unknown[]) => submitClinicalApproval(...args)
}));

jest.mock("../api/feedback", () => ({
  submitFeedback: jest.fn().mockResolvedValue(undefined)
}));

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "queue-item-abc",
    istStaffId: "IST-000042",
    status: "COMPLETED",
    currentStage: "SBAR",
    priorityScore: 0,
    patientType: "Staff",
    channel: "Phone",
    summary: "Ear pain",
    reasonNarrative: "Ear pain and reduced hearing since twenty minutes ago.",
    dispositionCode: "HMC_URGENT_REVIEW",
    destinationName: "HMC urgent review pathway",
    identityValidated: true,
    safetyFloorActive: false,
    sbarCopied: true,
    stccProcess: {
      processName: "Telehealth Triage Encounter",
      averageDurationMinutes: "11-13",
      currentActionTab: "SBAR_COMPLETE",
      canonicalSteps: [],
      visibleActionTabs: []
    },
    ...overrides
  } as QueueItem;
}

beforeEach(() => {
  updateItemContext.mockClear();
  moveItem.mockClear();
  previewTriageCompletion.mockReset().mockResolvedValue({ notePayload: "# default preview note", preview: true });
  compileTriageCompletion.mockReset();
  submitClinicalApproval.mockReset().mockResolvedValue(undefined);
});

describe("CompletionStage", () => {
  it("shows the persisted sbarNoteText directly for a completed call, without calling the preview endpoint", () => {
    const item = makeItem({ sbarNoteText: "# Real bilingual note\n...persisted content..." });
    render(<CompletionStage item={item} isReadOnly onCallCompleted={jest.fn()} />);

    expect(screen.getByText(/Real bilingual note/)).toBeInTheDocument();
    expect(previewTriageCompletion).not.toHaveBeenCalled();
  });

  it("fetches and displays a read-only preview for a completed call with no persisted note", async () => {
    previewTriageCompletion.mockResolvedValue({ notePayload: "# Generated preview note", preview: true });
    const item = makeItem({ sbarNoteText: undefined });
    render(<CompletionStage item={item} isReadOnly onCallCompleted={jest.fn()} />);

    expect(screen.getByText(/This call was closed before the SBAR note text was captured\./)).toBeInTheDocument();

    await waitFor(() => expect(previewTriageCompletion).toHaveBeenCalledTimes(1));
    expect(previewTriageCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        ist_staff_id: item.istStaffId,
        chief_complaint: item.reasonNarrative,
        final_disposition_code: item.dispositionCode,
        routing_destination: item.destinationName
      })
    );
    await waitFor(() => expect(screen.getByText(/Generated preview note/)).toBeInTheDocument());
  });

  it("never calls the non-idempotent /triage/complete path for a completed call review", () => {
    const item = makeItem({ sbarNoteText: undefined });
    render(<CompletionStage item={item} isReadOnly onCallCompleted={jest.fn()} />);
    expect(compileTriageCompletion).not.toHaveBeenCalled();
  });

  it("sends the correct snake_case field names to compileTriageCompletion when completing an active call, with no manual Copy SBAR step", async () => {
    compileTriageCompletion.mockResolvedValue({ notePayload: "# Active note", clipboardOptimized: true });
    const item = makeItem({
      status: "IN_PROCESS",
      sbarNoteText: undefined,
      sbarCopied: false,
      dispositionCode: "HMC_URGENT_REVIEW",
      destinationName: "HMC urgent review pathway",
      matchedProtocolId: "proto-ear",
      calculatedSeverity: "URGENT"
    });
    render(<CompletionStage item={item} isReadOnly={false} onCallCompleted={jest.fn()} />);

    expect(screen.queryByRole("button", { name: /Copy SBAR/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));

    const completeButton = screen.getByRole("button", { name: /Complete Call/ });
    completeButton.click();

    await waitFor(() => expect(compileTriageCompletion).toHaveBeenCalledTimes(1));
    expect(compileTriageCompletion).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({
        ist_staff_id: item.istStaffId,
        chief_complaint: item.reasonNarrative,
        final_disposition_code: item.dispositionCode,
        routing_destination: item.destinationName
      })
    );
  });

  it("does NOT auto-complete on mount even when disposition and destination are already set - the nurse must review and click Complete Call herself", async () => {
    const item = makeItem({
      status: "IN_PROCESS",
      sbarNoteText: undefined,
      sbarCopied: false,
      dispositionCode: "HMC_URGENT_REVIEW",
      destinationName: "HMC urgent review pathway"
    });
    render(<CompletionStage item={item} isReadOnly={false} onCallCompleted={jest.fn()} />);

    expect(screen.getByRole("button", { name: /Complete Call/ })).toBeDisabled(); // needs the nurse's confirmation first
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(moveItem).not.toHaveBeenCalled();
  });

  it("does not auto-complete (and shows the manual button) when disposition/destination are not yet set", () => {
    const item = makeItem({
      status: "IN_PROCESS",
      sbarNoteText: undefined,
      sbarCopied: false,
      dispositionCode: undefined,
      destinationName: undefined
    });
    render(<CompletionStage item={item} isReadOnly={false} onCallCompleted={jest.fn()} />);

    expect(moveItem).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Complete Call/ })).toBeDisabled();
  });

  describe("OI-49 signed clinical approval before the call closes", () => {
    const active = () =>
      makeItem({
        status: "IN_PROCESS",
        sbarNoteText: undefined,
        sbarCopied: false,
        matchedProtocolId: "proto-ear",
        calculatedSeverity: "URGENT",
        taqResponses: { q1: true }
      });

    it("keeps Complete Call disabled until the nurse confirms she reviewed the reasoning", () => {
      render(<CompletionStage item={active()} isReadOnly={false} onCallCompleted={jest.fn()} />);
      expect(screen.getByRole("button", { name: /Complete Call/ })).toBeDisabled();
      fireEvent.click(screen.getByRole("checkbox"));
      expect(screen.getByRole("button", { name: /Complete Call/ })).toBeEnabled();
    });

    it("cannot be confirmed when too little reasoning is recorded", () => {
      render(
        <CompletionStage
          item={makeItem({ status: "IN_PROCESS", sbarNoteText: undefined, sbarCopied: false, dispositionCode: undefined })}
          isReadOnly={false}
          onCallCompleted={jest.fn()}
        />
      );
      expect(screen.getByRole("checkbox")).toBeDisabled();
    });

    it("lets an emergency call with no matching protocol be approved, on its reason, severity and safety floor", () => {
      render(
        <CompletionStage
          item={makeItem({ status: "IN_PROCESS", sbarNoteText: undefined, sbarCopied: false, calculatedSeverity: "EMERGENCY", safetyFloorActive: true, safetyFloorSource: "symptom" })}
          isReadOnly={false}
          onCallCompleted={jest.fn()}
        />
      );
      expect(screen.getByRole("checkbox")).toBeEnabled();
    });

    it("records the approval under the saved encounter, then closes the call", async () => {
      compileTriageCompletion.mockResolvedValue({ notePayload: "# n", clipboardOptimized: true, persistence: { persisted: true, recordId: "enc-77" } });
      const done = jest.fn();
      render(<CompletionStage item={active()} isReadOnly={false} onCallCompleted={done} />);
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: /Complete Call/ }));
      await waitFor(() => expect(done).toHaveBeenCalled());
      expect(submitClinicalApproval).toHaveBeenCalledWith("enc-77", expect.objectContaining({ id: "queue-item-abc" }), { kind: "approve" });
      expect(submitClinicalApproval.mock.invocationCallOrder[0]).toBeLessThan(moveItem.mock.invocationCallOrder[0]);
    });

    it("lets the nurse raise the urgency with a reason, records it, and updates the call's severity", async () => {
      compileTriageCompletion.mockResolvedValue({ notePayload: "# n", clipboardOptimized: true, persistence: { persisted: true, recordId: "enc-77" } });
      const done = jest.fn();
      render(<CompletionStage item={active()} isReadOnly={false} onCallCompleted={done} />);
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.change(screen.getByLabelText("Your decision"), { target: { value: "raise" } });
      // Only higher levels than urgent are offered.
      expect(Array.from((screen.getByLabelText("Raise to") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["EMERGENCY"]);
      expect(screen.getByRole("button", { name: /Complete Call/ })).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Why you are changing it"), { target: { value: "short" } });
      expect(screen.getByRole("button", { name: /Complete Call/ })).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Why you are changing it"), { target: { value: "Caller sounds breathless on the line" } });
      fireEvent.click(screen.getByRole("button", { name: /Complete Call/ }));
      await waitFor(() => expect(done).toHaveBeenCalled());
      expect(submitClinicalApproval).toHaveBeenCalledWith("enc-77", expect.anything(), { kind: "raise", severity: "EMERGENCY", rationale: "Caller sounds breathless on the line" });
      expect(updateItemContext).toHaveBeenCalledWith("queue-item-abc", { calculatedSeverity: "EMERGENCY" });
    });

    it("never offers to lower the urgency, and cannot raise an emergency further", () => {
      render(<CompletionStage item={{ ...active(), calculatedSeverity: "EMERGENCY" }} isReadOnly={false} onCallCompleted={jest.fn()} />);
      expect(screen.getByRole("option", { name: "Raise the urgency" })).toBeDisabled();
      expect(screen.queryByRole("option", { name: /lower/i })).toBeNull();
    });

    it("lets the nurse add to the care plan with a reason, without changing the severity", async () => {
      compileTriageCompletion.mockResolvedValue({ notePayload: "# n", clipboardOptimized: true, persistence: { persisted: true, recordId: "enc-77" } });
      const done = jest.fn();
      render(<CompletionStage item={active()} isReadOnly={false} onCallCompleted={done} />);
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.change(screen.getByLabelText("Your decision"), { target: { value: "modify" } });
      fireEvent.change(screen.getByLabelText("Care plan note"), { target: { value: "Arrange a call back in one hour" } });
      fireEvent.change(screen.getByLabelText("Why you are changing it"), { target: { value: "Caller lives far from the clinic" } });
      fireEvent.click(screen.getByRole("button", { name: /Complete Call/ }));
      await waitFor(() => expect(done).toHaveBeenCalled());
      expect(submitClinicalApproval).toHaveBeenCalledWith("enc-77", expect.anything(), { kind: "modify", carePlan: "Arrange a call back in one hour", rationale: "Caller lives far from the clinic" });
      expect(updateItemContext).not.toHaveBeenCalledWith("queue-item-abc", expect.objectContaining({ calculatedSeverity: expect.anything() }));
    });

    it("leaves the call open when the approval is refused", async () => {
      compileTriageCompletion.mockResolvedValue({ notePayload: "# n", clipboardOptimized: true, persistence: { persisted: true, recordId: "enc-77" } });
      submitClinicalApproval.mockRejectedValue(new Error("Only the Remote Triage Nurse role can approve."));
      const done = jest.fn();
      render(<CompletionStage item={active()} isReadOnly={false} onCallCompleted={done} />);
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: /Complete Call/ }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Only the Remote Triage Nurse/));
      expect(moveItem).not.toHaveBeenCalled();
      expect(done).not.toHaveBeenCalled();
    });
  });
});
