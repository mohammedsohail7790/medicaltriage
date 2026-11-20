import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("../admin/shared/adminApi", () => ({
  apiBase: "",
  fetchJson: jest.fn(),
  postJson: jest.fn(),
  putJson: jest.fn(),
  deleteJson: jest.fn()
}));

import { fetchJson, postJson } from "../admin/shared/adminApi";
import { ClinicalWorkspace, clinicalTabsFor } from "./ClinicalWorkspace";
import { QaReviewTab, TeleconsultTab } from "./QueueTabs";
import { IncidentsTab, QaSamplingTab, SafetyDashboardTab } from "./SafetyTabs";
import { IncidentForm, ReferralLetter, TeleconsultEscalation } from "../cockpit/ClinicalActionsPanel";
import { canAccessClinicalWorkspace } from "../cockpit/roles";

const session = (role: string) => ({ sessionId: "s", user: { id: "u", fullName: "Test User", email: "", department: "", facility: "", roles: [role], accountStatus: "active", mfaStatus: "enabled" }, activeRole: role, permissions: [], expiresAtIso: "", mfaVerified: true });
const c = { caseRef: "case-1", reason: "Ankle pain", destination: "Urgent care", disposition: "HMC_URGENT_CARE" };

beforeEach(() => jest.clearAllMocks());

describe("clinical workspace", () => {
  it("shows tabs that follow the role, and nothing for other roles", () => {
    expect(clinicalTabsFor("clinical_safety_officer").map((t) => t.key)).toEqual(["dashboard", "incidents", "sampling"]);
    expect(clinicalTabsFor("qa_reviewer")).toHaveLength(1);
    expect(clinicalTabsFor("teleconsultant_physician")).toHaveLength(1);
    expect(clinicalTabsFor("remote_triage_nurse")).toEqual([]);
    expect(canAccessClinicalWorkspace("qa_reviewer")).toBe(true);
    expect(canAccessClinicalWorkspace("remote_triage_nurse")).toBe(false);
  });

  it("renders the workspace for a safety officer and switches tabs", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ live: false, message: "No database connected.", incidents: [] });
    render(<ClinicalWorkspace session={session("clinical_safety_officer")} onLogout={() => undefined} />);
    expect(await screen.findByText("No database connected.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Incidents" }));
    expect(await screen.findByText("No reports.")).toBeTruthy();
  });
});

describe("safety officer screens", () => {
  it("shows live figures only when the server says they are live", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ live: true, kpis: { pendingApprovals: 3 }, quality: { incidents: { total: 2, byStatus: {}, bySeverity: {}, nearMisses: 1 }, qualityReview: { sampled: 4, reviewed: 1, pending: 3, averageScore: 4.5 }, trainingNeeds: { coachingByNurse: {} } } });
    render(<SafetyDashboardTab />);
    expect(await screen.findByText("3")).toBeTruthy();
    expect(screen.getByText("4.5")).toBeTruthy();
  });

  it("closes an incident that is under review, with an outcome", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ incidents: [{ id: "i1", status: "under_review", type: "incident", severity: "high", caseRef: "c1", description: "Delay in escalation", createdAtIso: new Date().toISOString() }] });
    (postJson as jest.Mock).mockResolvedValue({});
    render(<IncidentsTab />);
    fireEvent.change(await screen.findByLabelText("Outcome for i1"), { target: { value: "Reviewed with the team" } });
    fireEvent.click(screen.getByText("Close"));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith("/api/v1/safety/incidents/i1/close", { outcome: "Reviewed with the team", correctiveActions: [] }));
  });

  it("draws a sample and lists what was selected", async () => {
    (postJson as jest.Mock).mockResolvedValue({ eligible: 9, selected: [{ id: "a", caseRef: "case-7", severity: "URGENT", dispositionCode: "X", department: "Cabin" }] });
    render(<QaSamplingTab />);
    fireEvent.click(screen.getByText("Draw sample"));
    expect(await screen.findByText(/1 drawn from 9 eligible/)).toBeTruthy();
    expect(postJson).toHaveBeenCalledWith("/api/v1/safety/qa/samples", { count: 5 });
  });
});

describe("reviewer and physician queues", () => {
  it("submits a review only with findings written", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ items: [{ id: "q1", caseRef: "case-1", severity: "URGENT", dispositionCode: null, department: null, sampledAtIso: "" }] });
    (postJson as jest.Mock).mockResolvedValue({});
    render(<QaReviewTab />);
    fireEvent.click(await screen.findByText("Review"));
    const submit = screen.getByText("Submit review") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Findings"), { target: { value: "Clear questions asked" } });
    fireEvent.click(submit);
    await waitFor(() => expect(postJson).toHaveBeenCalledWith("/api/v1/safety/qa/q1/review", { score: 4, findings: "Clear questions asked", followUp: "none" }));
  });

  it("lets a physician accept a queued case", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ items: [{ id: "h1", status: "queued", caseRef: "c9", urgency: "urgent", question: "Same day?", summary: "Ankle", nurseName: "Layla", assignee: null }] });
    (postJson as jest.Mock).mockResolvedValue({});
    render(<TeleconsultTab />);
    fireEvent.click(await screen.findByText("Accept this case"));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith("/api/v1/handoff/teleconsult/h1/accept"));
  });
});

describe("nurse actions", () => {
  it("reports an incident linked to the call", async () => {
    (postJson as jest.Mock).mockResolvedValue({});
    render(<IncidentForm c={c} />);
    fireEvent.change(screen.getByLabelText("What happened"), { target: { value: "The wrong protocol was suggested." } });
    fireEvent.click(screen.getByText("Report"));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith("/api/v1/safety/incidents", { type: "near_miss", severity: "low", caseRef: "case-1", description: "The wrong protocol was suggested." }));
    expect(await screen.findByText(/Reported to the Clinical Safety Officer/)).toBeTruthy();
  });

  it("prepares a referral draft, then offers approval and only then sending", async () => {
    (postJson as jest.Mock).mockResolvedValueOnce({ referral: { id: "r1", status: "draft", reference: "REF-1" } }).mockResolvedValueOnce({ referral: { id: "r1", status: "approved", reference: "REF-1" } });
    render(<ReferralLetter c={c} />);
    fireEvent.change(screen.getByLabelText("Assessment"), { target: { value: "Likely sprain" } });
    fireEvent.change(screen.getByLabelText("Recommendation"), { target: { value: "Review today" } });
    fireEvent.click(screen.getByText("Prepare draft"));
    expect(await screen.findByText("draft")).toBeTruthy();
    expect(screen.queryByText("Send by email")).toBeNull();
    fireEvent.click(screen.getByText("I have checked it: approve"));
    expect(await screen.findByText("Send by email")).toBeTruthy();
  });

  it("holds an escalation until the nurse approves it", async () => {
    (postJson as jest.Mock).mockResolvedValueOnce({ handoff: { id: "h1", status: "awaiting_nurse_approval" } }).mockResolvedValueOnce({ handoff: { id: "h1", status: "queued" } });
    render(<TeleconsultEscalation c={c} />);
    fireEvent.change(screen.getByLabelText("Question for the physician"), { target: { value: "Same-day review needed?" } });
    fireEvent.click(screen.getByText("Prepare escalation"));
    fireEvent.click(await screen.findByText("Approve and send to the physician"));
    expect(await screen.findByText("queued")).toBeTruthy();
  });
});
