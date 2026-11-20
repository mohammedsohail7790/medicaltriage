import { randomUUID } from "node:crypto";
import type { AuditEvent } from "../types/security.js";

/**
 * The platform event bus (NFR-166, NFR-092, NFR-093). Business and security activity is published as
 * events; webhook subscriptions, alert rules and the message broker are subscribers. Events are derived
 * from the audit trail, so everything that is audited can be subscribed to, and every event carries
 * references and the names of changed fields, never the data itself.
 *
 * Events use the CloudEvents 1.0 structure, an open standard (NFR-076).
 */

export type PlatformEvent = {
  id: string;
  type: string;
  occurredAtIso: string;
  subject?: string;
  risk: AuditEvent["risk"];
  success: boolean;
  data: Record<string, unknown>;
};

export const TYPE_PREFIX = "com.irisstar.aimltriage.";

// Friendly names for the events subscribers most often want; every other audit action is published as
// audit.<action in lower case>.
const FRIENDLY: Record<string, string> = {
  QUEUE_ITEM_CREATE: "queue.item.created",
  QUEUE_ITEM_CLAIM: "queue.item.claimed",
  QUEUE_ITEM_MOVE: "queue.item.moved",
  QUEUE_ITEM_COMPLETE: "queue.item.completed",
  QUEUE_ITEM_DELETE: "queue.item.deleted",
  QUEUE_CONTEXT_UPDATE: "queue.item.updated",
  CLINICAL_APPROVAL_REVIEW: "approval.recorded",
  EXPORT_COMPLETED: "export.completed",
  EXPORT_DENIED: "export.denied",
  INTEGRITY_CHECK_FAILED: "integrity.failed",
  SECURITY_ANOMALY_DETECTED: "security.anomaly",
  SESSION_CONTEXT_MISMATCH: "security.session_mismatch",
  FAILED_LOGIN: "auth.login_failed",
  PASSWORD_CHANGED: "auth.password_changed",
  RETENTION_PURGE_EXECUTED: "retention.purged",
  ARCHIVE_HANDOFF_FAILED: "archive.handoff_failed",
  PERFORMANCE_DEGRADED: "performance.degraded"
};

export function knownEventTypes(): string[] {
  return Object.values(FRIENDLY).sort();
}

export function eventTypeFor(action: string): string {
  return FRIENDLY[action] ?? `audit.${action.toLowerCase()}`;
}

/** Audit events written by the delivery machinery itself are not republished, which would loop. */
const NOT_REPUBLISHED_MODULES = new Set(["EventDelivery", "DataAccess"]);

export function auditToEvent(event: AuditEvent): PlatformEvent | undefined {
  if (NOT_REPUBLISHED_MODULES.has(event.module)) return undefined;
  const change = (event.metadata as { change?: { fields?: string[] } } | undefined)?.change;
  return {
    id: event.id || randomUUID(),
    type: eventTypeFor(event.action),
    occurredAtIso: event.timestampIso,
    subject: event.recordReference ?? event.resource,
    risk: event.risk,
    success: event.success,
    data: {
      action: event.action,
      module: event.module,
      resource: event.resource,
      recordReference: event.recordReference ?? null,
      userId: event.userId,
      activeRole: event.activeRole,
      organization: event.organization,
      changedFields: change?.fields ?? []
    }
  };
}

export type CloudEvent = {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  time: string;
  subject?: string;
  datacontenttype: "application/json";
  data: Record<string, unknown>;
};

export function toCloudEvent(event: PlatformEvent): CloudEvent {
  return {
    specversion: "1.0",
    id: event.id,
    source: "/aimltriage",
    type: TYPE_PREFIX + event.type,
    time: event.occurredAtIso,
    ...(event.subject ? { subject: event.subject } : {}),
    datacontenttype: "application/json",
    data: { ...event.data, risk: event.risk, success: event.success }
  };
}

/** True when `pattern` selects `type`: "*" for everything, a trailing * for a prefix, otherwise an exact match. */
export function eventMatches(pattern: string, type: string, action?: string): boolean {
  const candidates = [type, ...(action ? [action, action.toLowerCase()] : [])];
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1).toLowerCase();
    return candidates.some((c) => c.toLowerCase().startsWith(prefix));
  }
  return candidates.some((c) => c.toLowerCase() === pattern.toLowerCase());
}

type Subscriber = { name: string; handle: (event: PlatformEvent) => Promise<void> };
const subscribers = new Map<string, Subscriber>();

export function subscribe(subscriber: Subscriber): void {
  subscribers.set(subscriber.name, subscriber);
}
export function clearSubscribersForTests(): void {
  subscribers.clear();
}

/** Delivers to every subscriber. A failing subscriber never affects the others or the code that published. */
export async function publishEvent(event: PlatformEvent): Promise<void> {
  await Promise.all(
    [...subscribers.values()].map((subscriber) =>
      subscriber.handle(event).catch((error) => console.error(JSON.stringify({ type: "event_subscriber_failed", subscriber: subscriber.name, error: error instanceof Error ? error.name : "error" })))
    )
  );
}

export function publishAuditEvent(event: AuditEvent): void {
  const platformEvent = auditToEvent(event);
  if (platformEvent) void publishEvent(platformEvent);
}
