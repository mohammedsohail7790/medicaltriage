import { useEffect, useState } from "react";
import { deleteJson, fetchJson, postJson, putJson } from "../shared/adminApi";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

// NFR-092: administrators configure event and alert rules here, with no code change. Each change is audited
// by the server with before and after values.

export type AlertRule = {
  id: string;
  name: string;
  enabled: boolean;
  eventPattern: string;
  minRisk?: string;
  channel: "log" | "email" | "webhook";
  recipients: string[];
  cooldownSeconds: number;
};

type Props = { runElevated: (action: () => Promise<void>) => Promise<void> };

const PATH = "/api/v1/admin/integrations/event-rules";

export function AlertRulesCard({ runElevated }: Props) {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [status, setStatus] = useState("Loading rules.");
  const [name, setName] = useState("");
  const [eventPattern, setEventPattern] = useState("");
  const [minRisk, setMinRisk] = useState("");
  const [channel, setChannel] = useState<AlertRule["channel"]>("log");
  const [recipients, setRecipients] = useState("");
  const [cooldown, setCooldown] = useState("300");

  async function load() {
    try {
      const result = await fetchJson<{ rules: AlertRule[] }>(PATH);
      setRules(result.rules);
      setStatus(`${result.rules.length} rule(s).`);
    } catch {
      setStatus("Unable to load rules.");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const body = (override: Partial<AlertRule> = {}) => ({
    name,
    eventPattern,
    ...(minRisk ? { minRisk } : {}),
    channel,
    recipients: recipients.split(",").map((r) => r.trim()).filter(Boolean),
    cooldownSeconds: Number(cooldown) || 0,
    enabled: true,
    ...override
  });

  async function create() {
    await runElevated(async () => {
      try {
        await postJson(PATH, body());
        setName("");
        setEventPattern("");
        setRecipients("");
        await load();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "The rule could not be saved.");
      }
    });
  }

  async function toggle(rule: AlertRule) {
    await runElevated(async () => {
      await putJson(`${PATH}/${rule.id}`, { name: rule.name, eventPattern: rule.eventPattern, minRisk: rule.minRisk, channel: rule.channel, recipients: rule.recipients, cooldownSeconds: rule.cooldownSeconds, enabled: !rule.enabled });
      await load();
    });
  }

  async function remove(rule: AlertRule) {
    await runElevated(async () => {
      await deleteJson(`${PATH}/${rule.id}`);
      await load();
    });
  }

  async function fire(rule: AlertRule) {
    await runElevated(async () => {
      await postJson(`${PATH}/test-event`, { type: rule.eventPattern.replace(/\*$/, "test"), risk: rule.minRisk ?? "high" });
      setStatus(`A test event was published for "${rule.name}". If the rule matches, the alert is sent.`);
    });
  }

  return (
    <article className="help-card help-card-wide">
      <h3 className="help-title">Event and alert rules</h3>
      <p>Choose which events raise an alert, how serious they must be, and who is told. Changes take effect within seconds and are recorded in the audit trail.</p>
      <div className="admin-inline-form">
        <Input type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
        <Input type="text" placeholder="Event (e.g. auth.login_failed, queue.*)" value={eventPattern} onChange={(e) => setEventPattern(e.target.value)} className="flex-1" />
        <select aria-label="Minimum risk" value={minRisk} onChange={(e) => setMinRisk(e.target.value)}>
          <option value="">Any risk</option>
          <option value="medium">Medium or higher</option>
          <option value="high">High or higher</option>
          <option value="critical">Critical only</option>
        </select>
        <select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as AlertRule["channel"])}>
          <option value="log">Alert log (SIEM)</option>
          <option value="email">Email</option>
          <option value="webhook">Webhook</option>
        </select>
        <Input type="text" placeholder={channel === "email" ? "Email addresses, comma separated" : channel === "webhook" ? "Webhook subscription ids" : "Label (e.g. siem)"} value={recipients} onChange={(e) => setRecipients(e.target.value)} className="flex-1" />
        <Input type="number" aria-label="Cooldown in seconds" value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
        <Button onClick={create} disabled={!name || !eventPattern || !recipients}>Add rule</Button>
      </div>
      <small>{status}</small>
      <div className="admin-list">
        {rules.map((rule) => (
          <div key={rule.id}>
            <strong>{rule.name}</strong> {rule.enabled ? "" : "(off)"}
            <span>
              {rule.eventPattern} | {rule.minRisk ?? "any risk"} | {rule.channel} to {rule.recipients.join(", ")} | wait {rule.cooldownSeconds}s
            </span>
            <small>
              <Button onClick={() => toggle(rule)}>{rule.enabled ? "Turn off" : "Turn on"}</Button> <Button onClick={() => fire(rule)}>Send a test event</Button> <Button onClick={() => remove(rule)}>Delete</Button>
            </small>
          </div>
        ))}
      </div>
    </article>
  );
}
