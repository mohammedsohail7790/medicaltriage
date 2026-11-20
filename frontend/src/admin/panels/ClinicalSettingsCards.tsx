import { useEffect, useState } from "react";
import { fetchJson, postJson, putJson, deleteJson } from "../shared/adminApi";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

// Clinical settings an administrator or clinical lead maintains: the Initial Assessment rule (F-008) and the
// reusable note templates (F-005). Each change is audited by the server.

export function InitialAssessmentPolicyCard() {
  const [required, setRequired] = useState<boolean | undefined>();
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState("Loading.");
  useEffect(() => {
    fetchJson<{ required: boolean }>("/api/v1/safety/initial-assessment-policy")
      .then((r) => { setRequired(r.required); setStatus(""); })
      .catch(() => setStatus("Unable to load the setting."));
  }, []);
  async function change(next: boolean) {
    try {
      const r = await putJson<{ required: boolean }>("/api/v1/safety/initial-assessment-policy", next ? { required: true } : { required: false, reason });
      setRequired(r.required);
      setReason("");
      setStatus("Saved and recorded in the audit trail.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The setting could not be saved.");
    }
  }
  return (
    <article className="help-card help-card-wide">
      <h3 className="help-title">Initial Assessment</h3>
      <p>The emergency rule-out at the start of every call. When required, a call cannot reach disposition until it has an answer.</p>
      <p>Currently: <strong>{required === undefined ? "unknown" : required ? "required" : "optional"}</strong></p>
      <div className="admin-inline-form">
        {required === false ? (
          <Button onClick={() => change(true)}>Make it required</Button>
        ) : (
          <>
            <Input type="text" placeholder="Reason for making it optional" value={reason} onChange={(e) => setReason(e.target.value)} className="flex-1" />
            <Button onClick={() => change(false)} disabled={reason.trim().length < 5}>Make it optional</Button>
          </>
        )}
      </div>
      <small>{status}</small>
    </article>
  );
}

type Template = { id: string; name: string; section: string; language: string; body: string; status: string; version: number };

export function NoteTemplatesCard({ canApprove }: { canApprove: boolean }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [name, setName] = useState("");
  const [section, setSection] = useState("plan");
  const [language, setLanguage] = useState("en");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("Loading templates.");
  async function load() {
    try {
      const r = await fetchJson<{ templates: Template[] }>("/api/v1/note-templates/all");
      setTemplates(r.templates);
      setStatus(`${r.templates.length} template(s).`);
    } catch {
      setStatus("Unable to load templates.");
    }
  }
  useEffect(() => { void load(); }, []);
  async function act(action: () => Promise<unknown>) {
    try {
      await action();
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The change could not be saved.");
    }
  }
  return (
    <article className="help-card help-card-wide">
      <h3 className="help-title">Note templates</h3>
      <p>Reusable wording for nurses. Use {"{{patient}}"}, {"{{age}}"}, {"{{destination}}"}, {"{{complaint}}"}, {"{{nurse}}"} and {"{{disposition}}"}. A template reaches nurses only after someone other than its author approves it, and editing it sends it back for approval.</p>
      <div className="admin-inline-form">
        <Input type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
        <select aria-label="Section" value={section} onChange={(e) => setSection(e.target.value)}>{["subjective", "objective", "assessment", "plan", "advice"].map((s) => <option key={s}>{s}</option>)}</select>
        <select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)}><option value="en">English</option><option value="ar">Arabic</option></select>
        <Input type="text" placeholder="Wording" value={body} onChange={(e) => setBody(e.target.value)} className="flex-1" />
        <Button onClick={() => act(async () => { await postJson("/api/v1/note-templates", { name, section, language, body }); setName(""); setBody(""); })} disabled={name.length < 3 || body.length < 5}>Add template</Button>
      </div>
      <small>{status}</small>
      <div className="admin-list">
        {templates.map((t) => (
          <div key={t.id}>
            <strong>{t.name}</strong> ({t.section}, {t.language}, v{t.version}, {t.status})
            <span>{t.body}</span>
            <small>
              {canApprove && t.status === "draft" && <Button onClick={() => act(() => postJson(`/api/v1/note-templates/${t.id}/approve`))}>Approve</Button>}{" "}
              <Button onClick={() => act(() => putJson(`/api/v1/note-templates/${t.id}`, { name: t.name, section: t.section, language: t.language, body: body || t.body }))} disabled={!body}>Replace wording with the box above</Button>{" "}
              <Button onClick={() => act(() => deleteJson(`/api/v1/note-templates/${t.id}`))}>Retire</Button>
            </small>
          </div>
        ))}
      </div>
    </article>
  );
}
