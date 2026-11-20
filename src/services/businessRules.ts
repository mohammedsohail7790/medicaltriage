import { createItem, listItems, updateItem, WorkError } from "./clinicalWork.js";

/**
 * Configurable business rules (NFR-144). Operational rules that used to be numbers in the code, such as how the queue
 * ranks calls and how long a nurse holds a call, are values an administrator edits without a deployment. Each rule has a
 * default, a permitted range and a description; every change is validated, versioned with who changed it and why, and
 * audited by the caller. Rules take effect within seconds on every instance.
 *
 * Deliberately NOT here: the clinical safety floors (vital-sign limits, emergency rules, dispositions). They are fixed in
 * code and change only through a clinical release with its own sign-off.
 */

export type RuleDefinition = { key: string; description: string; default: number; min: number; max: number; integer: boolean };

export const RULE_DEFINITIONS: RuleDefinition[] = [
  { key: "queue.priority.emergency", description: "Ranking points for an emergency or a safety-floor case.", default: 10_000, min: 0, max: 100_000, integer: true },
  { key: "queue.priority.sla_overdue", description: "Ranking points when a call has passed its response target.", default: 2_500, min: 0, max: 100_000, integer: true },
  { key: "queue.priority.sla_base", description: "Starting ranking points for a call that is not yet overdue.", default: 1_500, min: 0, max: 100_000, integer: true },
  { key: "queue.priority.sla_per_minute", description: "Points taken off for each minute left before the response target.", default: 25, min: 0, max: 1_000, integer: true },
  { key: "queue.priority.dependent", description: "Ranking points when the patient is a dependent.", default: 600, min: 0, max: 100_000, integer: true },
  { key: "queue.priority.flight_deck", description: "Ranking points for a pilot or flight-deck crew member.", default: 350, min: 0, max: 100_000, integer: true },
  { key: "queue.priority.cabin", description: "Ranking points for cabin crew.", default: 250, min: 0, max: 100_000, integer: true },
  { key: "queue.lock_minutes", description: "How long a nurse holds a call before the hold lapses without activity.", default: 5, min: 1, max: 60, integer: true }
];

const definition = (key: string) => RULE_DEFINITIONS.find((d) => d.key === key);

const cache = new Map<string, { value: number; version: number }>();
let loadedAt = 0;
let loading: Promise<void> | undefined;
const TTL_MS = Number(process.env.BUSINESS_RULES_TTL_MS ?? 5000);

export async function refreshRules(): Promise<void> {
  const items = await listItems({ kind: "setting", limit: 500 });
  cache.clear();
  for (const item of items) {
    const key = String(item.caseRef ?? "");
    if (key.startsWith("rule:") && definition(key.slice(5)) && typeof item.payload.value === "number") cache.set(key.slice(5), { value: item.payload.value, version: Number(item.payload.version ?? 1) });
  }
  loadedAt = Date.now();
}

/** The value now in force. Synchronous, so it can sit in hot code; the cache refreshes in the background. */
export function rule(key: string): number {
  const def = definition(key);
  if (!def) throw new Error(`Unknown rule ${key}`);
  if (Date.now() - loadedAt > TTL_MS && !loading) {
    loading = refreshRules().catch(() => undefined).finally(() => { loading = undefined; });
  }
  return cache.get(key)?.value ?? def.default;
}

export function resetRulesCacheForTests(): void {
  cache.clear();
  loadedAt = Date.now() + 3_600_000; // do not hit the store until a test asks
}

export type RuleView = RuleDefinition & { value: number; version: number; isDefault: boolean };

export async function listRules(): Promise<RuleView[]> {
  await refreshRules();
  return RULE_DEFINITIONS.map((d) => {
    const current = cache.get(d.key);
    return { ...d, value: current?.value ?? d.default, version: current?.version ?? 0, isDefault: current === undefined || current.value === d.default };
  });
}

export async function setRule(key: string, value: unknown, userId: string, reason: string): Promise<{ before: number; after: number; version: number }> {
  const def = definition(key);
  if (!def) throw new WorkError(404, "Unknown rule.", "RULE_UNKNOWN");
  if (typeof value !== "number" || !Number.isFinite(value) || (def.integer && !Number.isInteger(value))) throw new WorkError(400, `${key} must be ${def.integer ? "a whole number" : "a number"}.`, "RULE_VALUE_INVALID");
  if (value < def.min || value > def.max) throw new WorkError(400, `${key} must be between ${def.min} and ${def.max}.`, "RULE_VALUE_RANGE");
  if (reason.trim().length < 5) throw new WorkError(400, "Say why the rule is being changed.", "RULE_REASON_REQUIRED");
  const existing = (await listItems({ kind: "setting", caseRef: `rule:${key}`, limit: 1 }))[0];
  const before = typeof existing?.payload.value === "number" ? existing.payload.value : def.default;
  const version = Number(existing?.payload.version ?? 0) + 1;
  const payload = { value, version, changedBy: userId, changedAtIso: new Date().toISOString() };
  if (existing) await updateItem(existing.id, { payload });
  else await createItem({ kind: "setting", status: "active", caseRef: `rule:${key}`, createdBy: userId, payload });
  await createItem({ kind: "rule_version", status: "recorded", caseRef: key, createdBy: userId, payload: { version, value, previous: before, reason: reason.trim(), atIso: new Date().toISOString() } });
  cache.set(key, { value, version });
  loadedAt = Date.now();
  return { before, after: value, version };
}

export async function ruleHistory(key: string): Promise<Array<{ version: number; value: number; previous: number; reason: string; by: string; atIso: string }>> {
  if (!definition(key)) throw new WorkError(404, "Unknown rule.", "RULE_UNKNOWN");
  return (await listItems({ kind: "rule_version", caseRef: key, limit: 200 })).map((i) => ({ version: Number(i.payload.version), value: Number(i.payload.value), previous: Number(i.payload.previous), reason: String(i.payload.reason), by: i.createdBy, atIso: String(i.payload.atIso) }));
}
