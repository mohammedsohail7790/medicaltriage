/**
 * Before and after values for audit entries (M-007).
 *
 * The result is stored under `metadata.change` of an audit event. Metadata is part
 * of the hash-chained payload, so the values are tamper-evident like every other
 * field, and entries written before this existed keep verifying unchanged.
 */

export const AUDIT_CHANGE_SCHEMA = "before-after/v1";

const SENSITIVE_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|credential|otp|mfa|signature|ciphertext/i;
const MAX_STRING = 500;

export type AuditChange = {
  schema: typeof AUDIT_CHANGE_SCHEMA;
  fields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

function sanitize(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (value === undefined) return null;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated]` : value;
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") {
    try {
      const text = JSON.stringify(value, (k, v) => (k && SENSITIVE_KEY.test(k) ? "[redacted]" : v));
      return text.length > MAX_STRING * 4 ? `[${Array.isArray(value) ? "list" : "object"} of ${text.length} characters]` : JSON.parse(text);
    } catch {
      return "[unserialisable]";
    }
  }
  return value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Builds a change record from two snapshots. Only fields that differ are kept, so a
 * create (before = null) lists every field and an update lists just what moved.
 * Pass `fields` to limit the comparison to an agreed set of attributes.
 */
export function buildAuditChange(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  fields?: readonly string[]
): AuditChange {
  const b = before ?? null;
  const a = after ?? null;
  const keys = fields ? [...fields] : [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])].sort();
  const changed = keys.filter((key) => !same(b?.[key], a?.[key]));
  const pick = (source: Record<string, unknown> | null) =>
    source === null ? null : Object.fromEntries(changed.map((key) => [key, sanitize(key, source[key])]));
  return { schema: AUDIT_CHANGE_SCHEMA, fields: changed, before: pick(b), after: pick(a) };
}
