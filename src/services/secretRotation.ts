import { publishEvent } from "./eventBus.js";

/**
 * Secret rotation (NFR-161). Qatar Airways sets the interval; the deployment records when each secret was last rotated
 * (NAME_ROTATED_AT, an ISO date, written by the rotation procedure). This reports which are current, due soon or overdue and,
 * on a schedule, raises an event for an overdue one so an alert rule can tell the owner. Values are never read or shown.
 */

export const ROTATED_SECRETS = [
  "AUTH_JWT_SECRET", "AUDIT_HMAC_SECRET", "FIELD_ENCRYPTION_KEY", "MFA_ENCRYPTION_KEY", "LOGIN_ENCRYPTION_KEY", "AUDIT_FORWARD_SECRET",
  "LOG_FORWARD_SECRET", "ARCHIVE_HANDOFF_SECRET", "CAPTCHA_SECRET", "TWILIO_AUTH_TOKEN", "MSGRAPH_CLIENT_SECRET", "TELECONSULT_TOKEN",
  "GATEWAY_SHARED_SECRET", "METRICS_TOKEN", "DATABASE_URL"
] as const;

export type RotationItem = { name: string; rotatedAtIso: string | null; ageDays: number | null; dueInDays: number | null; status: "ok" | "due_soon" | "overdue" | "unknown" };

export function rotationIntervalDays(env: NodeJS.ProcessEnv = process.env): number {
  const days = Number(env.SECRET_ROTATION_DAYS ?? 90);
  return Number.isFinite(days) && days > 0 ? days : 90;
}

export function rotationReport(env: NodeJS.ProcessEnv = process.env, now = new Date()): { intervalDays: number; secrets: RotationItem[] } {
  const interval = rotationIntervalDays(env);
  const warnDays = Number(env.SECRET_ROTATION_WARN_DAYS ?? 14);
  const secrets: RotationItem[] = [];
  for (const name of ROTATED_SECRETS) {
    if (!env[name]?.trim()) continue; // not in use in this deployment
    const raw = env[`${name}_ROTATED_AT`];
    const when = raw ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(when)) {
      secrets.push({ name, rotatedAtIso: null, ageDays: null, dueInDays: null, status: "unknown" });
      continue;
    }
    const age = Math.floor((now.getTime() - when) / 86_400_000);
    const due = interval - age;
    secrets.push({ name, rotatedAtIso: new Date(when).toISOString(), ageDays: age, dueInDays: due, status: due < 0 ? "overdue" : due <= warnDays ? "due_soon" : "ok" });
  }
  return { intervalDays: interval, secrets };
}

export async function checkSecretRotation(env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<{ ok: boolean; overdue: string[]; unknown: string[] }> {
  const report = rotationReport(env, now);
  const overdue = report.secrets.filter((s) => s.status === "overdue").map((s) => s.name);
  const unknown = report.secrets.filter((s) => s.status === "unknown").map((s) => s.name);
  if (overdue.length > 0) {
    await publishEvent({ id: `rotation-${now.getTime()}`, type: "secret.rotation_overdue", occurredAtIso: now.toISOString(), subject: "secrets", risk: "high", success: false, data: { overdue, intervalDays: report.intervalDays } });
  }
  return { ok: overdue.length === 0, overdue, unknown };
}
