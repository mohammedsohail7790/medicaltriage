import { useEffect, useState } from "react";
import { apiBase, fetchJson, postJson } from "../admin/shared/adminApi";
import { useAction } from "../clinical/useAction";
import "../clinical/clinical.css";

// What a triage nurse can do about the open call beyond the note (F-016, F-017, F-021, F-022, F-008):
// check for red flags, see why a protocol was suggested, report an incident, prepare and send a referral letter,
// and escalate to a teleconsultant physician. Nothing is sent without the nurse's own approval click.

type CaseFields = { caseRef: string; istStaffId?: string; reason?: string; protocolId?: string; disposition?: string; destination?: string };

type RedFlags = { matches: Array<{ id: string; label: string; matched: string }>; escalateNowSuggested: boolean };
type Explanation = { title: string; reasons: Array<{ kind: string; text: string }>; source: { release: { version: string }; review: { expertReviewer: string | null; lastReviewedIso: string | null }; guidelineMappingNote: string }; basis: string };

export function RedFlagAndExplain({ c }: { c: CaseFields }) {
  const [flags, setFlags] = useState<RedFlags | undefined>();
  const [why, setWhy] = useState<Explanation | undefined>();
  const { busy, error, run } = useAction();
  return (
    <div className="clinical-card">
      <h2>Safety check and explanation</h2>
      <div className="clinical-row">
        <button className="clinical-btn secondary" disabled={busy || !c.reason} onClick={() => run(async () => setFlags(await postJson<RedFlags>("/api/v1/safety/red-flags", { text: c.reason })))}>Check the caller's words for red flags</button>
        <button className="clinical-btn secondary" disabled={busy || !c.protocolId} onClick={() => run(async () => setWhy(await fetchJson<Explanation>(`/api/v1/protocols/${encodeURIComponent(c.protocolId!)}/explain?q=${encodeURIComponent(c.reason ?? "")}`)))}>Why this protocol?</button>
      </div>
      {error && <p className="clinical-error" role="alert">{error}</p>}
      {flags && (flags.matches.length === 0 ? <p>No red-flag phrases found. This does not rule anything out.</p> : <div className="clinical-note" role="alert">Possible red flags: {flags.matches.map((m) => `${m.label} ("${m.matched}")`).join("; ")}. Consider escalating now.</div>)}
      {why && (
        <div className="clinical-list">
          <div><strong>{why.title}</strong>{why.reasons.map((r, i) => <span key={i}>{r.text}</span>)}</div>
          <div><span>Content release {why.source.release.version}. Reviewer: {why.source.review.expertReviewer ?? "not recorded"}. {why.source.guidelineMappingNote}</span><span>{why.basis}</span></div>
        </div>
      )}
    </div>
  );
}

export function IncidentForm({ c }: { c: CaseFields }) {
  const [type, setType] = useState("near_miss");
  const [severity, setSeverity] = useState("low");
  const [description, setDescription] = useState("");
  const [done, setDone] = useState("");
  const { busy, error, run } = useAction();
  return (
    <div className="clinical-card">
      <h2>Report an incident or near miss</h2>
      <div className="clinical-row">
        <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}><option value="near_miss">Near miss</option><option value="incident">Incident</option></select>
        <select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="low">Low</option><option value="moderate">Moderate</option><option value="high">High</option><option value="critical">Critical</option></select>
      </div>
      <div className="clinical-row"><textarea aria-label="What happened" placeholder="What happened (no patient names needed; it is linked to this call)" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      <button className="clinical-btn" disabled={busy || description.trim().length < 10} onClick={async () => { const r = await run(() => postJson("/api/v1/safety/incidents", { type, severity, caseRef: c.caseRef, description })); if (r) { setDone("Reported to the Clinical Safety Officer."); setDescription(""); } }}>Report</button>
      {done && <p role="status">{done}</p>}
      {error && <p className="clinical-error" role="alert">{error}</p>}
    </div>
  );
}

type Referral = { id: string; status: string; reference: string };

export function ReferralLetter({ c }: { c: CaseFields }) {
  const [destination, setDestination] = useState(c.destination ?? "");
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState(c.reason ?? "");
  const [assessment, setAssessment] = useState(c.disposition ?? "");
  const [recommendation, setRecommendation] = useState(c.destination ? `Review at ${c.destination}` : "");
  const [to, setTo] = useState("");
  const [referral, setReferral] = useState<Referral | undefined>();
  const { busy, error, run } = useAction();
  async function viewPdf() {
    await run(async () => {
      const response = await fetch(`${apiBase}/api/v1/handoff/referrals/${referral!.id}/pdf`, { credentials: "include" });
      if (!response.ok) throw new Error(`Could not open the letter (${response.status}).`);
      window.open(URL.createObjectURL(await response.blob()), "_blank", "noopener");
    });
  }
  return (
    <div className="clinical-card">
      <h2>Referral letter (English and Arabic)</h2>
      {!referral ? (
        <>
          <div className="clinical-row"><input aria-label="Referred to" placeholder="Referred to" value={destination} onChange={(e) => setDestination(e.target.value)} /><input aria-label="Telephone" placeholder="Telephone" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="clinical-row"><textarea aria-label="Reason for referral" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="clinical-row"><textarea aria-label="Assessment" placeholder="Assessment" value={assessment} onChange={(e) => setAssessment(e.target.value)} /></div>
          <div className="clinical-row"><textarea aria-label="Recommendation" placeholder="Recommendation" value={recommendation} onChange={(e) => setRecommendation(e.target.value)} /></div>
          <button className="clinical-btn" disabled={busy || destination.trim().length < 2 || reason.trim().length < 3 || assessment.trim().length < 3 || recommendation.trim().length < 3} onClick={() => run(async () => setReferral((await postJson<{ referral: Referral }>("/api/v1/handoff/referrals", { caseRef: c.caseRef, istStaffId: c.istStaffId, destinationName: destination, destinationPhone: phone || undefined, reason, assessment, recommendation })).referral))}>Prepare draft</button>
        </>
      ) : (
        <>
          <p>Letter {referral.reference}: <strong>{referral.status}</strong></p>
          <div className="clinical-row">
            <button className="clinical-btn secondary" disabled={busy} onClick={viewPdf}>View PDF</button>
            {referral.status === "draft" && <button className="clinical-btn" disabled={busy} onClick={() => run(async () => setReferral((await postJson<{ referral: Referral }>(`/api/v1/handoff/referrals/${referral.id}/approve`)).referral))}>I have checked it: approve</button>}
          </div>
          {referral.status === "approved" && (
            <div className="clinical-row">
              <input type="email" aria-label="Send to" placeholder="Recipient email" value={to} onChange={(e) => setTo(e.target.value)} />
              <button className="clinical-btn" disabled={busy || !to} onClick={() => run(async () => setReferral((await postJson<{ referral: Referral }>(`/api/v1/handoff/referrals/${referral.id}/send`, { to })).referral))}>Send by email</button>
            </div>
          )}
        </>
      )}
      {error && <p className="clinical-error" role="alert">{error}</p>}
    </div>
  );
}

type Handoff = { id: string; status: string; response?: { advice: string; outcome: string } | null };

export function TeleconsultEscalation({ c }: { c: CaseFields }) {
  const [urgency, setUrgency] = useState("urgent");
  const [question, setQuestion] = useState("");
  const [summary, setSummary] = useState(c.reason ?? "");
  const [handoff, setHandoff] = useState<Handoff | undefined>();
  const { busy, error, run } = useAction();
  const refresh = () => run(async () => setHandoff((await fetchJson<{ handoff: Handoff }>(`/api/v1/handoff/teleconsult/${handoff!.id}`)).handoff));
  return (
    <div className="clinical-card">
      <h2>Escalate to a teleconsultant physician</h2>
      {!handoff ? (
        <>
          <div className="clinical-row"><select aria-label="Urgency" value={urgency} onChange={(e) => setUrgency(e.target.value)}><option value="routine">Routine</option><option value="urgent">Urgent</option><option value="emergency">Emergency</option></select></div>
          <div className="clinical-row"><input aria-label="Question for the physician" placeholder="Your question" size={60} value={question} onChange={(e) => setQuestion(e.target.value)} /></div>
          <div className="clinical-row"><textarea aria-label="Summary" placeholder="Summary of the case" value={summary} onChange={(e) => setSummary(e.target.value)} /></div>
          <button className="clinical-btn" disabled={busy || question.trim().length < 5 || summary.trim().length < 5} onClick={() => run(async () => setHandoff((await postJson<{ handoff: Handoff }>("/api/v1/handoff/teleconsult", { caseRef: c.caseRef, urgency, question, summary })).handoff))}>Prepare escalation</button>
        </>
      ) : (
        <>
          <p>Status: <strong>{handoff.status.replace(/_/g, " ")}</strong></p>
          {handoff.status === "awaiting_nurse_approval" && <button className="clinical-btn" disabled={busy} onClick={() => run(async () => setHandoff((await postJson<{ handoff: Handoff }>(`/api/v1/handoff/teleconsult/${handoff.id}/approve`)).handoff))}>Approve and send to the physician</button>}
          {handoff.status !== "awaiting_nurse_approval" && <button className="clinical-btn secondary" disabled={busy} onClick={refresh}>Check for an answer</button>}
          {handoff.response && <div className="clinical-note">Physician: {handoff.response.advice} ({handoff.response.outcome.replace(/_/g, " ")})</div>}
        </>
      )}
      {error && <p className="clinical-error" role="alert">{error}</p>}
    </div>
  );
}

type Template = { id: string; name: string; section: string; language: string };

/** Approved, clinician-written wording the nurse can fill in and copy into the note (F-005). */
export function TemplatePicker({ c }: { c: CaseFields }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [text, setText] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const { busy, error, run } = useAction();
  useEffect(() => {
    fetchJson<{ templates: Template[] }>("/api/v1/note-templates").then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));
  }, []);
  if (templates.length === 0) return null;
  return (
    <div className="clinical-card">
      <h2>Note wording</h2>
      <div className="clinical-row">
        <select aria-label="Template" defaultValue="" onChange={(e) => e.target.value && run(async () => { const r = await postJson<{ text: string; missing: string[] }>(`/api/v1/note-templates/${e.target.value}/render`, { destination: c.destination, complaint: c.reason, disposition: c.disposition }); setText(r.text); setMissing(r.missing); })}>
          <option value="">Choose approved wording</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.section}, {t.language})</option>)}
        </select>
      </div>
      {text && (
        <>
          <div className="clinical-note" dir="auto">{text}</div>
          {missing.length > 0 && <p>Fill in: {missing.join(", ")}.</p>}
          <button className="clinical-btn secondary" disabled={busy} onClick={() => navigator.clipboard?.writeText(text)}>Copy</button>
        </>
      )}
      {error && <p className="clinical-error" role="alert">{error}</p>}
    </div>
  );
}

export function ClinicalActionsPanel({ c }: { c: CaseFields }) {
  return (
    <details className="clinical-actions">
      <summary>More clinical actions for this call</summary>
      <RedFlagAndExplain c={c} />
      <TemplatePicker c={c} />
      <TeleconsultEscalation c={c} />
      <ReferralLetter c={c} />
      <IncidentForm c={c} />
    </details>
  );
}
