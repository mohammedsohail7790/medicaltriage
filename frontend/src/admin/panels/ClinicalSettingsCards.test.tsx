import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("../shared/adminApi", () => ({ fetchJson: jest.fn(), postJson: jest.fn(), putJson: jest.fn(), deleteJson: jest.fn() }));

import { deleteJson, fetchJson, postJson, putJson } from "../shared/adminApi";
import { InitialAssessmentPolicyCard, NoteTemplatesCard } from "./ClinicalSettingsCards";

beforeEach(() => jest.clearAllMocks());

describe("Initial Assessment setting (F-008)", () => {
  it("needs a reason before it can be made optional", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ required: true });
    (putJson as jest.Mock).mockResolvedValue({ required: false });
    render(<InitialAssessmentPolicyCard />);
    expect(await screen.findByText("required")).toBeTruthy();
    const button = screen.getByText("Make it optional") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Reason for making it optional"), { target: { value: "Pilot approved by clinical lead" } });
    fireEvent.click(button);
    await waitFor(() => expect(putJson).toHaveBeenCalledWith("/api/v1/safety/initial-assessment-policy", { required: false, reason: "Pilot approved by clinical lead" }));
  });
});

describe("note templates (F-005)", () => {
  const draft = { id: "t1", name: "Plan", section: "plan", language: "en", body: "Refer {{patient}}", status: "draft", version: 1 };

  it("shows Approve only to someone allowed to approve, and sends the approval", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ templates: [draft] });
    (postJson as jest.Mock).mockResolvedValue({});
    const { unmount } = render(<NoteTemplatesCard canApprove={false} />);
    await screen.findByText("Plan");
    expect(screen.queryByText("Approve")).toBeNull();
    unmount();
    render(<NoteTemplatesCard canApprove />);
    fireEvent.click(await screen.findByText("Approve"));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith("/api/v1/note-templates/t1/approve"));
  });

  it("adds and retires templates", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ templates: [draft] });
    (postJson as jest.Mock).mockResolvedValue({});
    (deleteJson as jest.Mock).mockResolvedValue({});
    render(<NoteTemplatesCard canApprove />);
    await screen.findByText("Plan");
    fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "New plan" } });
    fireEvent.change(screen.getByPlaceholderText("Wording"), { target: { value: "Review {{destination}} today" } });
    fireEvent.click(screen.getByText("Add template"));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith("/api/v1/note-templates", { name: "New plan", section: "plan", language: "en", body: "Review {{destination}} today" }));
    fireEvent.click(screen.getByText("Retire"));
    await waitFor(() => expect(deleteJson).toHaveBeenCalledWith("/api/v1/note-templates/t1"));
  });
});
