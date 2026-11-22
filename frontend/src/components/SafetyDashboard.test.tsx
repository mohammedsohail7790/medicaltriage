// F-019: the safety dashboard must say when its figures are fixed examples, and must not draw a manual baseline
// it does not have.
import { render, screen, waitFor } from "@testing-library/react";
import SafetyDashboard from "./SafetyDashboard";

jest.mock("../auth/apiBase", () => ({ apiBase: "" }));

const baseKpis = {
  averageHandlingTimeAiSeconds: 390,
  averageHandlingTimeManualSeconds: 540,
  overtriageRate: 6.8,
  undertriageRate: 0,
  medsafeDxPassRate: 98.7,
  pendingApprovals: 2,
  safetyFloorOverrides: 14,
  clinicianOverrides: 3
};

function mockPayload(payload: unknown) {
  (global as unknown as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => payload });
}

describe("SafetyDashboard", () => {
  it("shows a demonstration-data notice when the server marks the figures as examples", async () => {
    mockPayload({ demonstrationData: true, kpis: baseKpis, trends: [], explainabilityLog: [] });
    render(<SafetyDashboard />);
    await waitFor(() => expect(screen.getByText(/Safety scorecard loaded/)).toBeInTheDocument());
    expect(screen.getByRole("note")).toHaveTextContent(/Demonstration data/);
    expect(screen.getByText(/Manual baseline/)).toBeInTheDocument();
    // The figure is the share of calls without a critical breach, so it must not carry a benchmark name.
    expect(screen.getByText("Calls without a critical breach")).toBeInTheDocument();
    expect(screen.queryByText(/MedSafe-Dx/)).not.toBeInTheDocument();
  });

  it("shows no notice for live figures and no manual baseline when none is recorded", async () => {
    mockPayload({ demonstrationData: false, kpis: { ...baseKpis, averageHandlingTimeManualSeconds: null }, trends: [], explainabilityLog: [] });
    render(<SafetyDashboard />);
    await waitFor(() => expect(screen.getByText(/Safety scorecard loaded/)).toBeInTheDocument());
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.getByText(/No manual handling time is recorded/)).toBeInTheDocument();
    expect(screen.queryByText(/Manual baseline/)).not.toBeInTheDocument();
  });
});
