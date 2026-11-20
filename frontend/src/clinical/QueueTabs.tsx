import { useEffect, useState } from "react";
import { fetchJson, postJson } from "../admin/shared/adminApi";
import { useAction } from "./useAction";

// Quality reviewer (F-020) and teleconsultant physician (F-016) work queues.

type QaItem = { id: string; caseRef: string; severity: string | null; dispositionCode: string | null; department: string | null; sampledAtIso: string };

export function QaReviewTab() {
  const [items, setItems] = useState<QaItem[]>([]);
  const [open, setOpen] = useState<string | undefined>();
  const [score, setScore] = useState("4");
  const [findings, setFindings] = useState("");
  const [followUp, setFollowUp] = useState("none");
  const { busy, error, run } = useAction();
  const load = () => run(async () => setItems((await fetchJson<{ items: QaItem[] }>("/api/v1/safety/qa/queue")).items));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function submit(id: string) {
    const done = await run(async () => {
      await postJson(`/api/v1/safety/qa/${id}/review`, { score: Number(score), findings, followUp });
      return true;
    });
    if (done) {
      setOpen(undefined);
      setFindings("");
      await load();
    }
  }
  return (
    <div className="clinical-card">
      <h2>Calls waiting for review</h2>
      <p>Details that identify the caller are hidden. You are never shown a call you handled.</p>
      {error && <p className="clinical-error" role="alert">{error}</p>}
      <div className="clinical-list">
        {items.length === 0 && <p>Nothing is waiting.</p>}
        {items.map((i) => (
          <div key={i.id}>
            <strong>Case {i.caseRef}</strong>
            <span>{i.severity ?? "severity not recorded"} | {i.dispositionCode ?? "no disposition"} | {i.department ?? "no department"}</span>
            {open === i.id ? (
              <>
                <div className="clinical-row">
                  <label>Score <select value={score} onChange={(e) => setScore(e.target.value)}>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select></label>
                  <label>Follow-up <select value={followUp} onChange={(e) => setFollowUp(e.target.value)}><option value="none">None</option><option value="coaching">Coaching</option><option value="incident">Raise an incident</option></select></label>
                </div>
                <div className="clinical-row"><textarea aria-label="Findings" placeholder="What went well, what to improve" value={findings} onChange={(e) => setFindings(e.target.value)} /></div>
                <button className="clinical-btn" disabled={busy || findings.trim().length < 5} onClick={() => submit(i.id)}>Submit review</button>{" "}
                <button className="clinical-btn secondary" onClick={() => setOpen(undefined)}>Cancel</button>
              </>
            ) : (
              <button className="clinical-btn secondary" onClick={() => setOpen(i.id)}>Review</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

type Handoff = { id: string; status: string; caseRef: string | null; urgency: string; question: string; summary: string; nurseName: string; assignee: string | null };

export function TeleconsultTab() {
  const [items, setItems] = useState<Handoff[]>([]);
  const [advice, setAdvice] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  const load = () => run(async () => setItems((await fetchJson<{ items: Handoff[] }>("/api/v1/handoff/teleconsult/queue")).items));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="clinical-card">
      <h2>Cases from triage nurses</h2>
      {error && <p className="clinical-error" role="alert">{error}</p>}
      <div className="clinical-list">
        {items.length === 0 && <p>No cases are waiting.</p>}
        {items.map((h) => (
          <div key={h.id}>
            <strong>{h.urgency.toUpperCase()} | case {h.caseRef ?? "not linked"} | from {h.nurseName}</strong>
            <span>Question: {h.question}</span>
            <span>{h.summary}</span>
            {h.status === "queued" && <button className="clinical-btn" disabled={busy} onClick={() => run(async () => { await postJson(`/api/v1/handoff/teleconsult/${h.id}/accept`); await load(); })}>Accept this case</button>}
            {h.status === "accepted" && (
              <>
                <div className="clinical-row">
                  <select aria-label={`Outcome for ${h.id}`} value={outcome[h.id] ?? "agree_with_nurse"} onChange={(e) => setOutcome({ ...outcome, [h.id]: e.target.value })}>
                    <option value="agree_with_nurse">Agree with the nurse</option><option value="change_disposition">Change the disposition</option><option value="needs_call_back">Needs a call back</option><option value="needs_emergency_services">Needs emergency services</option>
                  </select>
                </div>
                <div className="clinical-row"><textarea aria-label={`Advice for ${h.id}`} placeholder="Your advice to the nurse" value={advice[h.id] ?? ""} onChange={(e) => setAdvice({ ...advice, [h.id]: e.target.value })} /></div>
                <button className="clinical-btn" disabled={busy || (advice[h.id] ?? "").trim().length < 5} onClick={() => run(async () => { await postJson(`/api/v1/handoff/teleconsult/${h.id}/respond`, { advice: advice[h.id], outcome: outcome[h.id] ?? "agree_with_nurse" }); await load(); })}>Send answer</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
