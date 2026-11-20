import { publishEvent } from "../services/eventBus.js";

/**
 * Interface monitoring (NFR-111). Every call to another system records how long it took and whether it worked, per
 * integration, over a bounded recent window. A check compares each live integration with its thresholds and raises an
 * interface.degraded event when one is slow or failing, so the people who own that interface hear before the nurses do.
 */

const WINDOW = 200;
type Sample = { ms: number; ok: boolean; at: number };
const samples = new Map<string, Sample[]>();

export function recordInterfaceCall(integration: string, ms: number, ok: boolean, at = Date.now()): void {
  const list = samples.get(integration) ?? [];
  list.push({ ms, ok, at });
  if (list.length > WINDOW) list.splice(0, list.length - WINDOW);
  samples.set(integration, list);
}

export function resetInterfaceStatsForTests(): void {
  samples.clear();
}

export type InterfaceStat = { integration: string; calls: number; failures: number; errorRate: number; p50Ms: number; p95Ms: number; lastCallIso: string | null };

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

export function interfaceStats(): InterfaceStat[] {
  return [...samples.entries()].map(([integration, list]) => {
    const sorted = list.map((s) => s.ms).sort((a, b) => a - b);
    const failures = list.filter((s) => !s.ok).length;
    return { integration, calls: list.length, failures, errorRate: list.length ? Math.round((failures / list.length) * 1000) / 1000 : 0, p50Ms: pct(sorted, 50), p95Ms: pct(sorted, 95), lastCallIso: list.length ? new Date(list[list.length - 1].at).toISOString() : null };
  }).sort((a, b) => a.integration.localeCompare(b.integration));
}

export type InterfaceThresholds = { p95Ms: number; errorRate: number; minCalls: number };

export function interfaceThresholds(integration: string, env: NodeJS.ProcessEnv = process.env): InterfaceThresholds {
  const key = integration.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const num = (name: string, fallback: number) => {
    const v = Number(env[`INTERFACE_${key}_${name}`] ?? env[`INTERFACE_DEFAULT_${name}`] ?? fallback);
    return Number.isFinite(v) ? v : fallback;
  };
  return { p95Ms: num("P95_MS", 3000), errorRate: num("ERROR_RATE", 0.1), minCalls: num("MIN_CALLS", 5) };
}

export type InterfaceFinding = { integration: string; kind: "slow" | "failing"; value: number; threshold: number; calls: number };

export function evaluateInterfaces(stats = interfaceStats(), env: NodeJS.ProcessEnv = process.env): InterfaceFinding[] {
  const findings: InterfaceFinding[] = [];
  for (const s of stats) {
    const t = interfaceThresholds(s.integration, env);
    if (s.calls < t.minCalls) continue;
    if (s.p95Ms > t.p95Ms) findings.push({ integration: s.integration, kind: "slow", value: s.p95Ms, threshold: t.p95Ms, calls: s.calls });
    if (s.errorRate > t.errorRate) findings.push({ integration: s.integration, kind: "failing", value: s.errorRate, threshold: t.errorRate, calls: s.calls });
  }
  return findings;
}

export async function checkInterfaces(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; findings: InterfaceFinding[] }> {
  const findings = evaluateInterfaces(interfaceStats(), env);
  for (const f of findings) {
    await publishEvent({
      id: `interface-${f.integration}-${Date.now()}`, type: "interface.degraded", occurredAtIso: new Date().toISOString(), subject: f.integration, risk: "high", success: false,
      data: { integration: f.integration, problem: f.kind, value: f.value, threshold: f.threshold, calls: f.calls }
    });
  }
  return { ok: findings.length === 0, findings };
}
