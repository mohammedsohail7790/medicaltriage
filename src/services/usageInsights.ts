import { listPersistedAuditEvents } from "./persistence.js";
import { listAuditEvents } from "./securityAdmin.js";
import type { AuditEvent } from "../types/security.js";

/**
 * Usage insights (NFR-115): who uses the system and how, from the audit trail. By user, role, department, feature
 * (module and action), errors and peak times. People are shown by a masked reference unless the caller may see identities,
 * and nothing about a patient or a case appears: only counts.
 */

export type InsightsQuery = { sinceIso?: string; untilIso?: string; organization?: string; revealUsers?: boolean };

export type Insights = {
  window: { sinceIso: string | null; untilIso: string | null; events: number };
  users: { total: number; top: Array<{ user: string; events: number; failures: number }> };
  byRole: Record<string, number>;
  byDepartment: Record<string, number>;
  byFeature: Array<{ feature: string; events: number; failures: number }>;
  errors: { total: number; rate: number; topActions: Array<{ action: string; count: number }> };
  peakHours: Array<{ hourUtc: number; events: number }>;
  daily: Array<{ day: string; events: number; activeUsers: number }>;
};

/** A stable, masked label for a user: the first characters and a short hash, never the full identifier. */
export function maskUser(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${id.slice(0, 3)}***${h.toString(16).slice(0, 4)}`;
}

const NOISE = new Set(["DATA_READ"]);

export function computeInsights(events: AuditEvent[], query: InsightsQuery = {}): Insights {
  const since = query.sinceIso ? Date.parse(query.sinceIso) : 0;
  const until = query.untilIso ? Date.parse(query.untilIso) : Number.MAX_SAFE_INTEGER;
  const inWindow = events.filter((e) => {
    const t = Date.parse(e.timestampIso);
    return Number.isFinite(t) && t >= since && t <= until && (!query.organization || e.organization === query.organization);
  });
  const count = (key: (e: AuditEvent) => string, source = inWindow) => source.reduce<Record<string, number>>((acc, e) => ({ ...acc, [key(e)]: (acc[key(e)] ?? 0) + 1 }), {});
  const perUser = new Map<string, { events: number; failures: number }>();
  const perFeature = new Map<string, { events: number; failures: number }>();
  const hours = new Array<number>(24).fill(0);
  const days = new Map<string, { events: number; users: Set<string> }>();
  for (const e of inWindow) {
    const u = perUser.get(e.userId) ?? { events: 0, failures: 0 };
    u.events += 1;
    if (!e.success) u.failures += 1;
    perUser.set(e.userId, u);
    const feature = `${e.module}`;
    const f = perFeature.get(feature) ?? { events: 0, failures: 0 };
    f.events += 1;
    if (!e.success) f.failures += 1;
    perFeature.set(feature, f);
    const t = new Date(e.timestampIso);
    hours[t.getUTCHours()] += 1;
    const day = e.timestampIso.slice(0, 10);
    const d = days.get(day) ?? { events: 0, users: new Set<string>() };
    d.events += 1;
    d.users.add(e.userId);
    days.set(day, d);
  }
  const failures = inWindow.filter((e) => !e.success);
  return {
    window: { sinceIso: query.sinceIso ?? null, untilIso: query.untilIso ?? null, events: inWindow.length },
    users: { total: perUser.size, top: [...perUser.entries()].sort((a, b) => b[1].events - a[1].events).slice(0, 10).map(([id, v]) => ({ user: query.revealUsers ? id : maskUser(id), ...v })) },
    byRole: count((e) => e.activeRole || "unknown"),
    byDepartment: count((e) => e.department || "not recorded"),
    byFeature: [...perFeature.entries()].map(([feature, v]) => ({ feature, ...v })).sort((a, b) => b.events - a.events),
    errors: { total: failures.length, rate: inWindow.length ? Math.round((failures.length / inWindow.length) * 1000) / 1000 : 0, topActions: Object.entries(count((e) => e.action, failures.filter((e) => !NOISE.has(e.action)))).map(([action, n]) => ({ action, count: n })).sort((a, b) => b.count - a.count).slice(0, 10) },
    peakHours: hours.map((n, hourUtc) => ({ hourUtc, events: n })).sort((a, b) => b.events - a.events).slice(0, 5),
    daily: [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, events: v.events, activeUsers: v.users.size }))
  };
}

export async function usageInsights(query: InsightsQuery = {}): Promise<Insights> {
  const persisted = await listPersistedAuditEvents(5000, { since: query.sinceIso, until: query.untilIso, organization: query.organization }).catch(() => []);
  const events = persisted.length > 0 ? persisted : listAuditEvents({ since: query.sinceIso, until: query.untilIso, limit: 5000 });
  return computeInsights(events, query);
}
