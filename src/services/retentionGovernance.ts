export const APPROVED_RETENTION_DAYS = 365;
export const APPROVED_RETENTION_DECISION = "PR-011-2026-08-17";
export const LEGAL_HOLD_MUTATION_LOCK_ID = 1_096_520_211_011n;

export type ActiveRetentionPolicy = {
  code: string;
  status: string;
  retentionPeriod: unknown;
  deletionMode: string;
  legalBasis?: string | null;
};

export function approvedRetentionDays(policy: ActiveRetentionPolicy | null, execute: boolean, cliOverride?: number): {
  days: number;
  source: string;
} {
  if (cliOverride !== undefined && (!Number.isFinite(cliOverride) || cliOverride < 1)) {
    throw new Error("retention-days must be a positive number");
  }
  if (execute && cliOverride !== undefined) {
    throw new Error("Execute mode rejects --retention-days overrides; use the approved active RetentionPolicy.");
  }
  if (cliOverride !== undefined) return { days: cliOverride, source: "--retention-days dry-run override" };

  const period = policy?.retentionPeriod as { days?: unknown; decisionReference?: unknown } | null;
  const isApproved =
    policy?.status === "active" &&
    period?.days === APPROVED_RETENTION_DAYS &&
    period?.decisionReference === APPROVED_RETENTION_DECISION &&
    Boolean(policy.legalBasis?.trim());
  if (isApproved) {
    return { days: APPROVED_RETENTION_DAYS, source: `approved RetentionPolicy row (${policy!.code})` };
  }
  if (execute) {
    throw new Error(
      `Execute mode requires an active ${APPROVED_RETENTION_DAYS}-day RetentionPolicy with decisionReference=${APPROVED_RETENTION_DECISION} and legalBasis.`
    );
  }
  return { days: APPROVED_RETENTION_DAYS, source: "approved 365-day dry-run baseline; active policy not installed" };
}

export function excludeLegallyHeld<T extends { id: string; organizationId?: string | null }>(
  records: T[],
  heldRecordIds: ReadonlySet<string>,
  heldOrganizationIds: ReadonlySet<string>
): { eligible: T[]; excluded: T[] } {
  const eligible: T[] = [];
  const excluded: T[] = [];
  for (const record of records) {
    if (heldRecordIds.has(record.id) || Boolean(record.organizationId && heldOrganizationIds.has(record.organizationId))) {
      excluded.push(record);
    } else {
      eligible.push(record);
    }
  }
  return { eligible, excluded };
}

// ---------------------------------------------------------------------------
// Audit event retention (M-008)
//
// Audit events are kept for the life of the contract unless Qatar Airways sets
// another period. The database already rejects UPDATE and DELETE on
// audit_events, and no job in this codebase removes them. This policy makes the
// rule explicit and configurable: AUDIT_RETENTION_DAYS unset means "life of the
// contract" and nothing is ever eligible for removal.
// ---------------------------------------------------------------------------

export type AuditRetentionPolicy =
  | { mode: "contract-life"; days: null; source: string }
  | { mode: "fixed-days"; days: number; source: string };

export function auditRetentionPolicy(env: Record<string, string | undefined> = process.env): AuditRetentionPolicy {
  const raw = env.AUDIT_RETENTION_DAYS?.trim();
  if (!raw) return { mode: "contract-life", days: null, source: "default: life of the contract" };
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error("AUDIT_RETENTION_DAYS must be a positive whole number of days, or unset to keep audit events for the life of the contract.");
  }
  return { mode: "fixed-days", days: Number(raw), source: "AUDIT_RETENTION_DAYS set by agreement with Qatar Airways" };
}

/**
 * The instant before which audit events may be removed, or null when they must be
 * kept. Informational: it reports what the agreed period would allow. Removal needs
 * a separate, approved, audited procedure because audit_events is append-only.
 */
export function auditEventsEligibleBefore(policy: AuditRetentionPolicy, now: Date = new Date()): Date | null {
  return policy.mode === "fixed-days" ? new Date(now.getTime() - policy.days * 24 * 60 * 60 * 1000) : null;
}

// ---------------------------------------------------------------------------
// Per-data-type retention policies (NFR-055, NFR-057)
//
// Each data type has its own policy row (RetentionPolicy.code): its own period, deletion mode and
// schedule. A policy can purge only when it is active, names a positive period, a legal basis and the
// reference of the decision that approved it. Without that, a run only reports what it would do.
// ---------------------------------------------------------------------------

export type DeletionMode = "archive_then_delete" | "hard_delete";

export type RetentionPolicyDetails = {
  code: string;
  status: string;
  retentionPeriod: unknown;
  deletionMode: string;
  legalBasis?: string | null;
};

export function policyRetentionDays(
  policy: RetentionPolicyDetails | null,
  execute: boolean,
  cliOverride?: number
): { days: number | null; source: string; approved: boolean } {
  if (cliOverride !== undefined) {
    if (!Number.isFinite(cliOverride) || cliOverride < 1) throw new Error("retention-days must be a positive number");
    if (execute) throw new Error("Execute mode rejects --retention-days overrides; use the approved active RetentionPolicy.");
    return { days: cliOverride, source: "--retention-days dry-run override", approved: false };
  }
  const period = policy?.retentionPeriod as { days?: unknown; decisionReference?: unknown; schedule?: unknown } | null;
  const days = typeof period?.days === "number" && Number.isInteger(period.days) && period.days > 0 ? period.days : null;
  const approved =
    policy?.status === "active" && days !== null && typeof period?.decisionReference === "string" && period.decisionReference.trim().length > 0 && Boolean(policy.legalBasis?.trim());
  if (approved) return { days, source: `approved RetentionPolicy ${policy!.code}`, approved: true };
  if (execute) {
    throw new Error(
      `Execute mode needs an active RetentionPolicy ${policy?.code ?? ""} with a positive days value, a decisionReference and a legalBasis.`
    );
  }
  return { days, source: days ? "policy present but not approved (dry run only)" : "no policy: nothing is purged", approved: false };
}

export function isDeletionMode(value: string): value is DeletionMode {
  return value === "archive_then_delete" || value === "hard_delete";
}
