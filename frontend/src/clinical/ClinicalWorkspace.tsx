import { useMemo, useState, type ReactElement } from "react";
import type { AuthenticatedSession } from "../auth/session";
import { IncidentsTab, QaSamplingTab, SafetyDashboardTab } from "./SafetyTabs";
import { QaReviewTab, TeleconsultTab } from "./QueueTabs";
import "./clinical.css";

type Tab = { key: string; label: string; render: () => ReactElement };

export function clinicalTabsFor(activeRole: string): Tab[] {
  if (activeRole === "clinical_safety_officer") {
    return [
      { key: "dashboard", label: "Safety dashboard", render: () => <SafetyDashboardTab /> },
      { key: "incidents", label: "Incidents", render: () => <IncidentsTab /> },
      { key: "sampling", label: "Review sampling", render: () => <QaSamplingTab /> }
    ];
  }
  if (activeRole === "qa_reviewer") return [{ key: "review", label: "Calls to review", render: () => <QaReviewTab /> }];
  if (activeRole === "teleconsultant_physician") return [{ key: "cases", label: "Cases", render: () => <TeleconsultTab /> }];
  return [];
}

type Props = { session: AuthenticatedSession; onLogout: () => void };

/** One page for the three clinical oversight roles; the tabs shown follow the active role. */
export function ClinicalWorkspace({ session, onLogout }: Props) {
  const tabs = useMemo(() => clinicalTabsFor(session.activeRole), [session.activeRole]);
  const [active, setActive] = useState(tabs[0]?.key);
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  return (
    <div className="clinical-shell">
      <header className="clinical-header">
        <div><h1>Clinical workspace</h1><small>{session.user.fullName} | {session.activeRole.replace(/_/g, " ")}</small></div>
        <span className="spacer" />
        <button className="clinical-btn secondary" onClick={onLogout}>Sign out</button>
      </header>
      <nav className="clinical-tabs" role="tablist" aria-label="Clinical workspace">
        {tabs.map((t) => <button key={t.key} role="tab" aria-selected={current?.key === t.key} onClick={() => setActive(t.key)}>{t.label}</button>)}
      </nav>
      <main className="clinical-main">{current ? current.render() : <p>Your role has no screens in this workspace.</p>}</main>
    </div>
  );
}
