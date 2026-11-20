import { useEffect, useState } from "react";
import { fetchJson, postJson } from "../admin/shared/adminApi";
import { useAction } from "./useAction";

// Screens for the Clinical Safety Officer (F-019, F-021, F-023, F-020): the live safety dashboard, incident review,
// and quality-review sampling. Everything shown is read from the server; nothing is sample data.

type Dashboard = {
  live: boolean;
  message?: string;
  kpis?: Record<string, number>;
  quality?: {
    incidents: { total: number; byStatus: Record<string, number>; bySeverity: Record<string, number>; nearMisses: number };
    qualityReview: { sampled: number; reviewed: number; pending: number; averageScore: number | null };
    trainingNeeds: { coachingByNurse: Record<string, number> };
  };
};

export function SafetyDashboardTab() {
  const [data, setData] = useState<Dashboard | undefined>();
  const { error, run } = useAction();
  useEffect(() => {
    void run(async () => setData(await fetchJson<Dashboard>("/api/v1/safety/dashboard")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (error) return <p className="clinical-error" role="alert">{error}</p>;
  if (!data) return <p>Loading the safety dashboard.</p>;
  if (!data.live) return <div className="clinical-note">{data.message}</div>;
  const q = data.quality;
  return (
    <>
      <div className="clinical-card">
        <h2>Clinical safety (live)</h2>
        <div className="clinical-kpis">
          {Object.entries(data.kpis ?? {}).slice(0, 8).map(([key, value]) => (
            <div key={key}><b>{value}</b><span>{key.replace(/([A-Z])/g, " $1").toLowerCase()}</span></div>
          ))}
        </div>
      </div>
      {q && (
        <div className="clinical-card">
          <h2>Incidents and quality review</h2>
          <div className="clinical-kpis">
            <div><b>{q.incidents.total}</b><span>incidents and near misses</span></div>
            <div><b>{q.incidents.nearMisses}</b><span>near misses</span></div>
            <div><b>{q.qualityReview.reviewed} / {q.qualityReview.sampled}</b><span>sampled calls reviewed</span></div>
            <div><b>{q.qualityReview.averageScore ?? "none yet"}</b><span>average review score</span></div>
          </div>
          <p>Coaching follow-ups by nurse: {Object.keys(q.trainingNeeds.coachingByNurse).length === 0 ? "none" : Object.entries(q.trainingNeeds.coachingByNurse).map(([n, c]) => `${n} (${c})`).join(", ")}</p>
        </div>
      )}
    </>
  );
}

type Incident = { id: string; status: string; type: string; severity: string; caseRef: string | null; description: string; createdAtIso: string; outcome?: string };

export function IncidentsTab() {
  const [items, setItems] = useState<Incident[]>([]);
  const [filter, setFilter] = useState("");
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  const load = () => run(async () => setItems((await fetchJson<{ incidents: Incident[] }>(`/api/v1/safety/incidents${filter ? `?status=${filter}` : ""}`)).incidents));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);
  return (
    <div className="clinical-card">
      <h2>Incident and near-miss reports</h2>
      <div className="clinical-row">
        <select aria-label="Status" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All</option><option value="reported">Reported</option><option value="under_review">Under review</option><option value="closed">Closed</option>
        </select>
      </div>
      {error && <p className="clinical-error" role="alert">{error}</p>}
      <div className="clinical-list">
        {items.length === 0 && <p>No reports.</p>}
        {items.map((i) => (
          <div key={i.id}>
            <strong>{i.type === "near_miss" ? "Near miss" : "Incident"} | {i.severity} | {i.status.replace("_", " ")}</strong>
            <span>{i.description}</span>
            <span>Case {i.caseRef ?? "not linked"} | {new Date(i.createdAtIso).toLocaleString()}</span>
            {i.status === "reported" && <button className="clinical-btn secondary" disabled={busy} onClick={() => run(async () => { await postJson(`/api/v1/safety/incidents/${i.id}/review`); await load(); })}>Take for review</button>}
            {i.status === "under_review" && (
              <div className="clinical-row">
                <input aria-label={`Outcome for ${i.id}`} placeholder="Outcome and learning" value={outcome[i.id] ?? ""} onChange={(e) => setOutcome({ ...outcome, [i.id]: e.target.value })} size={50} />
                <button className="clinical-btn" disabled={busy || (outcome[i.id] ?? "").trim().length < 5} onClick={() => run(async () => { await postJson(`/api/v1/safety/incidents/${i.id}/close`, { outcome: outcome[i.id], correctiveActions: [] }); await load(); })}>Close</button>
              </div>
            )}
            {i.status === "closed" && i.outcome && <span>Outcome: {i.outcome}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

type Sample = { id: string; caseRef: string; severity: string | null; dispositionCode: string | null; department: string | null };

export function QaSamplingTab() {
  const [mode, setMode] = useState<"count" | "percent">("count");
  const [value, setValue] = useState("5");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [result, setResult] = useState<{ eligible: number; selected: Sample[] } | undefined>();
  const { busy, error, run } = useAction();
  const draw = () =>
    run(async () => {
      const body: Record<string, unknown> = mode === "count" ? { count: Number(value) } : { percent: Number(value) };
      if (from) body.fromIso = new Date(from).toISOString();
      if (to) body.toIso = new Date(to).toISOString();
      setResult(await postJson<{ eligible: number; selected: Sample[] }>("/api/v1/safety/qa/samples", body));
    });
  return (
    <div className="clinical-card">
      <h2>Randomised call review sample</h2>
      <p>Draws completed calls at random, never the same call twice. The selection is recorded in the audit trail.</p>
      <div className="clinical-row">
        <select aria-label="Sample by" value={mode} onChange={(e) => setMode(e.target.value as "count" | "percent")}><option value="count">Number of calls</option><option value="percent">Percent of eligible calls</option></select>
        <input type="number" aria-label="Amount" value={value} onChange={(e) => setValue(e.target.value)} min={1} />
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="clinical-btn" disabled={busy || !Number(value)} onClick={draw}>Draw sample</button>
      </div>
      {error && <p className="clinical-error" role="alert">{error}</p>}
      {result && (
        <div className="clinical-list">
          <p>{result.selected.length} drawn from {result.eligible} eligible completed calls.</p>
          {result.selected.map((s) => <div key={s.id}><strong>{s.caseRef}</strong><span>{s.severity ?? "severity not recorded"} | {s.dispositionCode ?? "no disposition"} | {s.department ?? "no department"}</span></div>)}
        </div>
      )}
    </div>
  );
}
