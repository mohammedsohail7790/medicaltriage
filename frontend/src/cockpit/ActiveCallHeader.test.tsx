// OI-36: the escalate-now button must appear for the nurse role, which holds triage.workspace.view
// but not triage.queue.manage.
import { render, screen } from "@testing-library/react";
import { ActiveCallHeader } from "./ActiveCallHeader";
import type { QueueItem } from "../QueueContext";
import type { AuthenticatedSession } from "../auth/session";

jest.mock("../QueueContext", () => ({
  useQueue: () => ({ connectCall: jest.fn() })
}));
jest.mock("./FitToFlyBadge", () => ({ FitToFlyBadge: () => null }));
jest.mock("../utils/CallTimer", () => ({ CallTimer: () => null }));

function makeItem(): QueueItem {
  return {
    id: "queue-item-1",
    istStaffId: "IST-000042",
    status: "IN_PROCESS",
    currentStage: "REASON",
    priorityScore: 0,
    patientType: "Staff",
    channel: "Phone",
    summary: "Chest tightness",
    identityValidated: true,
    safetyFloorActive: false,
    sbarCopied: false
  } as unknown as QueueItem;
}

function sessionWith(permissions: string[]): AuthenticatedSession {
  return {
    sessionId: "s1",
    user: {
      id: "usr_nurse_10001",
      fullName: "Layla Hassan",
      email: "layla@irisstar.tech",
      department: "Tele-triage",
      facility: "Doha",
      roles: ["remote_triage_nurse"],
      accountStatus: "active",
      mfaStatus: "verified"
    },
    activeRole: "remote_triage_nurse",
    permissions,
    expiresAtIso: "2099-01-01T00:00:00Z",
    mfaVerified: true
  };
}

function renderHeader(permissions: string[]) {
  render(
    <ActiveCallHeader
      item={makeItem()}
      session={sessionWith(permissions)}
      isHeld={false}
      isReadOnly={false}
      isEscalated={false}
      onEscalate={jest.fn()}
    />
  );
}

describe("ActiveCallHeader escalate-now", () => {
  it("shows the escalate-now button for a nurse with the workspace permission only", () => {
    renderHeader(["triage.workspace.view", "triage.recommendation.view", "privacy.reveal.request"]);
    expect(screen.getByRole("button", { name: /escalate now/i })).toBeEnabled();
  });

  it("hides the button for a user without the workspace permission", () => {
    renderHeader(["triage.queue.manage"]);
    expect(screen.queryByRole("button", { name: /escalate now/i })).not.toBeInTheDocument();
  });
});
