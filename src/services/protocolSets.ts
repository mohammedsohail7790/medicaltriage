import { createItem, listItems, updateItem, WorkError } from "./clinicalWork.js";
import { listClinicalProtocols } from "./clinicalContent.js";

/**
 * Organisation protocol set (NFR-072). Which licensed protocols this organisation's nurses are offered in the protocol
 * list and search. The default is every protocol.
 *
 * Guardrails, because hiding a protocol can leave a nurse without the right one:
 *  - It only hides a protocol from the list and search. A protocol is still reachable by its identifier, and any
 *    protocol the safety floors or the matching panel select still applies. Clinical content itself changes only through
 *    a clinical release.
 *  - At most half of the library can be hidden, and at least one protocol must stay.
 *  - The change needs a clinical governance approver and a written reason, and is audited with before and after values.
 */

const KEY = "protocol-set";
export const MAX_HIDDEN_SHARE = 0.5;

let cache: { hidden: Set<string>; version: number } | undefined;
let loadedAt = 0;
let loading: Promise<void> | undefined;
const TTL_MS = Number(process.env.PROTOCOL_SET_TTL_MS ?? 5000);

export async function refreshProtocolSet(): Promise<void> {
  const item = (await listItems({ kind: "setting", caseRef: KEY, limit: 1 }))[0];
  const hidden = Array.isArray(item?.payload.hiddenProtocolIds) ? (item!.payload.hiddenProtocolIds as unknown[]).map(String) : [];
  cache = { hidden: new Set(hidden), version: Number(item?.payload.version ?? 0) };
  loadedAt = Date.now();
}

export function hiddenProtocolIds(): Set<string> {
  if (Date.now() - loadedAt > TTL_MS && !loading) {
    loading = refreshProtocolSet().catch(() => undefined).finally(() => { loading = undefined; });
  }
  return cache?.hidden ?? new Set();
}

export function resetProtocolSetCacheForTests(): void {
  cache = undefined;
  loadedAt = Date.now() + 3_600_000;
}

export function isOffered(protocolId: string): boolean {
  return !hiddenProtocolIds().has(protocolId);
}

export async function protocolSetView(): Promise<{ hiddenProtocolIds: string[]; offered: number; total: number; version: number; maxHidden: number }> {
  await refreshProtocolSet();
  const total = listClinicalProtocols().length;
  const hidden = [...cache!.hidden].filter((id) => listClinicalProtocols().some((p) => p.id === id));
  return { hiddenProtocolIds: hidden, offered: total - hidden.length, total, version: cache!.version, maxHidden: Math.floor(total * MAX_HIDDEN_SHARE) };
}

export async function setProtocolSet(hiddenIds: unknown, userId: string, reason: string): Promise<{ before: string[]; after: string[]; version: number }> {
  if (!Array.isArray(hiddenIds) || hiddenIds.some((id) => typeof id !== "string")) throw new WorkError(400, "hiddenProtocolIds must be a list of protocol identifiers.", "PROTOCOL_SET_INVALID");
  if (reason.trim().length < 5) throw new WorkError(400, "Say why the protocol set is being changed.", "PROTOCOL_SET_REASON_REQUIRED");
  const all = listClinicalProtocols();
  const known = new Set(all.map((p) => p.id));
  const unique = [...new Set(hiddenIds as string[])];
  const unknown = unique.filter((id) => !known.has(id));
  if (unknown.length) throw new WorkError(400, `Unknown protocol: ${unknown.join(", ")}.`, "PROTOCOL_SET_UNKNOWN");
  if (unique.length > Math.floor(all.length * MAX_HIDDEN_SHARE) || unique.length >= all.length) throw new WorkError(400, `At most ${Math.floor(all.length * MAX_HIDDEN_SHARE)} protocols can be hidden, and at least one must stay.`, "PROTOCOL_SET_TOO_MANY_HIDDEN");
  const existing = (await listItems({ kind: "setting", caseRef: KEY, limit: 1 }))[0];
  const before = Array.isArray(existing?.payload.hiddenProtocolIds) ? (existing!.payload.hiddenProtocolIds as unknown[]).map(String) : [];
  const version = Number(existing?.payload.version ?? 0) + 1;
  const payload = { hiddenProtocolIds: unique, version, changedBy: userId, changedAtIso: new Date().toISOString(), reason: reason.trim() };
  if (existing) await updateItem(existing.id, { payload });
  else await createItem({ kind: "setting", status: "active", caseRef: KEY, createdBy: userId, payload });
  cache = { hidden: new Set(unique), version };
  loadedAt = Date.now();
  return { before, after: unique, version };
}
