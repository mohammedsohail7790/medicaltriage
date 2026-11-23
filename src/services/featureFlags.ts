import { createItem, listItems, updateItem, WorkError } from "./clinicalWork.js";

/**
 * Feature flags (NFR-072). Switches an administrator turns on or off for this organisation's deployment without a code
 * change. Every flag has a default, a description and an owner-visible history of who changed it and why.
 *
 * Deliberately NOT here: anything clinical. Safety floors, dispositions and the approval requirement are not flags and
 * cannot be turned off. Each flag below switches an optional integration or aid, never a clinical safeguard.
 */

export type FlagDefinition = { key: string; description: string; default: boolean };

export const FLAG_DEFINITIONS: FlagDefinition[] = [
  { key: "webhooks.delivery", description: "Queue and send outbound webhook notifications to subscribed systems. When off, events are not queued for webhooks; nothing already queued is lost.", default: true },
  { key: "voice.assessment", description: "The voice-assisted assessment aid. When off, its routes answer 404. Nurse-led triage is unaffected.", default: true }
];

const definition = (key: string) => FLAG_DEFINITIONS.find((d) => d.key === key);
const cache = new Map<string, { value: boolean; version: number }>();
let loadedAt = 0;
let loading: Promise<void> | undefined;
const TTL_MS = Number(process.env.FEATURE_FLAGS_TTL_MS ?? 5000);

export async function refreshFlags(): Promise<void> {
  const items = await listItems({ kind: "setting", limit: 500 });
  cache.clear();
  for (const item of items) {
    const key = String(item.caseRef ?? "");
    if (key.startsWith("flag:") && definition(key.slice(5)) && typeof item.payload.value === "boolean") cache.set(key.slice(5), { value: item.payload.value, version: Number(item.payload.version ?? 1) });
  }
  loadedAt = Date.now();
}

/** The value now in force. Synchronous so it can sit in hot code; the cache refreshes in the background. */
export function flagEnabled(key: string): boolean {
  const def = definition(key);
  if (!def) throw new Error(`Unknown feature flag ${key}`);
  if (Date.now() - loadedAt > TTL_MS && !loading) {
    loading = refreshFlags().catch(() => undefined).finally(() => { loading = undefined; });
  }
  return cache.get(key)?.value ?? def.default;
}

export function resetFlagsCacheForTests(): void {
  cache.clear();
  loadedAt = Date.now() + 3_600_000;
}

export type FlagView = FlagDefinition & { value: boolean; version: number; isDefault: boolean };

export async function listFlags(): Promise<FlagView[]> {
  await refreshFlags();
  return FLAG_DEFINITIONS.map((d) => {
    const current = cache.get(d.key);
    return { ...d, value: current?.value ?? d.default, version: current?.version ?? 0, isDefault: (current?.value ?? d.default) === d.default };
  });
}

export async function setFlag(key: string, value: unknown, userId: string, reason: string): Promise<{ before: boolean; after: boolean; version: number }> {
  const def = definition(key);
  if (!def) throw new WorkError(404, "Unknown feature flag.", "FLAG_UNKNOWN");
  if (typeof value !== "boolean") throw new WorkError(400, `${key} must be true or false.`, "FLAG_VALUE_INVALID");
  if (reason.trim().length < 5) throw new WorkError(400, "Say why the flag is being changed.", "FLAG_REASON_REQUIRED");
  const existing = (await listItems({ kind: "setting", caseRef: `flag:${key}`, limit: 1 }))[0];
  const before = typeof existing?.payload.value === "boolean" ? existing.payload.value : def.default;
  const version = Number(existing?.payload.version ?? 0) + 1;
  const payload = { value, version, changedBy: userId, changedAtIso: new Date().toISOString() };
  if (existing) await updateItem(existing.id, { payload });
  else await createItem({ kind: "setting", status: "active", caseRef: `flag:${key}`, createdBy: userId, payload });
  await createItem({ kind: "rule_version", status: "recorded", caseRef: `flag:${key}`, createdBy: userId, payload: { version, value, previous: before, reason: reason.trim(), atIso: new Date().toISOString() } });
  cache.set(key, { value, version });
  loadedAt = Date.now();
  return { before, after: value, version };
}

export async function flagHistory(key: string): Promise<Array<{ version: number; value: boolean; previous: boolean; reason: string; by: string; atIso: string }>> {
  if (!definition(key)) throw new WorkError(404, "Unknown feature flag.", "FLAG_UNKNOWN");
  return (await listItems({ kind: "rule_version", caseRef: `flag:${key}`, limit: 200 })).map((i) => ({ version: Number(i.payload.version), value: Boolean(i.payload.value), previous: Boolean(i.payload.previous), reason: String(i.payload.reason), by: i.createdBy, atIso: String(i.payload.atIso) }));
}
