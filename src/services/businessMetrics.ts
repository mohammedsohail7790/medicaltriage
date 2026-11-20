import { publishEvent } from "./eventBus.js";
import { listPersistedAuditEvents } from "./persistence.js";
import { listAuditEvents } from "./securityAdmin.js";

/**
 * Business KPI alerts (NFR-107): a fall in call volume. The baseline for an hour is the median count of the same hour of
 * the same weekday in earlier weeks, so a quiet Friday night is compared with earlier Friday nights, not with a busy
 * Monday. No alert is raised until two full weeks of traffic exist and the baseline is large enough to mean something,
 * which is why Qatar Airways' agreed baselines apply after two weeks of live traffic.
 */

export type VolumeOptions = { baselineWeeks: number; minHistoryDays: number; minBaseline: number; dropRatio: number };
export const DEFAULT_VOLUME: VolumeOptions = { baselineWeeks: 4, minHistoryDays: 14, minBaseline: 5, dropRatio: 0.5 };

export type VolumeResult = { status: "ok" | "dip" | "baseline_not_ready"; hourStartIso: string; observed: number; baseline: number | null; historyDays: number; reason?: string };

const HOUR = 3_600_000;
const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** `timestamps` are call-creation times (ms). The hour assessed is the last complete hour before `now`. */
export function volumeDip(timestamps: number[], now: Date, options: VolumeOptions = DEFAULT_VOLUME): VolumeResult {
  const hourEnd = Math.floor(now.getTime() / HOUR) * HOUR;
  const hourStart = hourEnd - HOUR;
  const count = (start: number) => timestamps.filter((t) => t >= start && t < start + HOUR).length;
  const observed = count(hourStart);
  const earliest = timestamps.length ? Math.min(...timestamps) : hourStart;
  const historyDays = Math.floor((hourStart - earliest) / (24 * HOUR));
  const hourStartIso = new Date(hourStart).toISOString();
  if (historyDays < options.minHistoryDays) return { status: "baseline_not_ready", hourStartIso, observed, baseline: null, historyDays, reason: `Only ${Math.max(0, historyDays)} day(s) of traffic; ${options.minHistoryDays} are needed.` };
  const samples: number[] = [];
  for (let w = 1; w <= options.baselineWeeks; w += 1) {
    const start = hourStart - w * 7 * 24 * HOUR;
    if (start >= earliest) samples.push(count(start));
  }
  if (samples.length < 2) return { status: "baseline_not_ready", hourStartIso, observed, baseline: null, historyDays, reason: "Fewer than two earlier weeks have this hour." };
  const baseline = median(samples);
  if (baseline < options.minBaseline) return { status: "ok", hourStartIso, observed, baseline, historyDays, reason: "The usual volume at this hour is too small to judge a fall." };
  return observed < baseline * options.dropRatio ? { status: "dip", hourStartIso, observed, baseline, historyDays } : { status: "ok", hourStartIso, observed, baseline, historyDays };
}

export async function callCreationTimes(sinceIso: string): Promise<number[]> {
  const persisted = await listPersistedAuditEvents(50_000, { action: "QUEUE_ITEM_CREATE", since: sinceIso }).catch(() => []);
  const events = persisted.length > 0 ? persisted : listAuditEvents({ action: "QUEUE_ITEM_CREATE", since: sinceIso, limit: 50_000 });
  return events.map((e) => Date.parse(e.timestampIso)).filter(Number.isFinite);
}

export async function checkCallVolume(now = new Date(), options: VolumeOptions = DEFAULT_VOLUME): Promise<VolumeResult> {
  const since = new Date(now.getTime() - (options.baselineWeeks * 7 + 1) * 24 * HOUR).toISOString();
  const result = volumeDip(await callCreationTimes(since), now, options);
  if (result.status === "dip") {
    await publishEvent({ id: `volume-${result.hourStartIso}`, type: "business.volume_dip", occurredAtIso: now.toISOString(), subject: "call-volume", risk: "medium", success: false, data: { hourStartIso: result.hourStartIso, observed: result.observed, baseline: result.baseline } });
  }
  return result;
}
