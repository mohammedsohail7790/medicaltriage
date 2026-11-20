import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("../shared/adminApi", () => ({
  fetchJson: jest.fn(),
  postJson: jest.fn(),
  putJson: jest.fn(),
  deleteJson: jest.fn()
}));

import { AlertRulesCard } from "./AlertRulesCard";
import { deleteJson, fetchJson, postJson, putJson } from "../shared/adminApi";

const runElevated = async (action: () => Promise<void>) => action();
const rule = { id: "r1", name: "Failed sign-ins", enabled: true, eventPattern: "auth.login_failed", minRisk: "high", channel: "log", recipients: ["siem"], cooldownSeconds: 300 };

describe("alert rules screen (NFR-092)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchJson as jest.Mock).mockResolvedValue({ rules: [rule] });
  });

  it("lists the rules with what they match and where they send", async () => {
    render(<AlertRulesCard runElevated={runElevated} />);
    expect(await screen.findByText("Failed sign-ins")).toBeTruthy();
    expect(screen.getByText(/auth\.login_failed \| high \| log to siem \| wait 300s/)).toBeTruthy();
  });

  it("creates a rule from the form, with recipients split into a list", async () => {
    render(<AlertRulesCard runElevated={runElevated} />);
    await screen.findByText("Failed sign-ins");
    fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Exports" } });
    fireEvent.change(screen.getByPlaceholderText(/Event \(e\.g\./), { target: { value: "export.completed" } });
    fireEvent.change(screen.getByLabelText("Channel"), { target: { value: "email" } });
    fireEvent.change(screen.getByPlaceholderText(/Email addresses/), { target: { value: "a@irisstar.tech, b@irisstar.tech" } });
    fireEvent.click(screen.getByText("Add rule"));
    await waitFor(() => expect(postJson).toHaveBeenCalled());
    expect((postJson as jest.Mock).mock.calls[0][1]).toMatchObject({ name: "Exports", eventPattern: "export.completed", channel: "email", recipients: ["a@irisstar.tech", "b@irisstar.tech"], enabled: true });
  });

  it("turns a rule off, sends a test event and deletes a rule", async () => {
    render(<AlertRulesCard runElevated={runElevated} />);
    await screen.findByText("Failed sign-ins");
    fireEvent.click(screen.getByText("Turn off"));
    await waitFor(() => expect(putJson).toHaveBeenCalledWith("/api/v1/admin/integrations/event-rules/r1", expect.objectContaining({ enabled: false })));
    fireEvent.click(screen.getByText("Send a test event"));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith("/api/v1/admin/integrations/event-rules/test-event", expect.objectContaining({ risk: "high" })));
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(deleteJson).toHaveBeenCalledWith("/api/v1/admin/integrations/event-rules/r1"));
  });

  it("does not offer to add a rule until the name, event and recipients are filled in", async () => {
    render(<AlertRulesCard runElevated={runElevated} />);
    await screen.findByText("Failed sign-ins");
    expect((screen.getByText("Add rule") as HTMLButtonElement).disabled).toBe(true);
  });
});
