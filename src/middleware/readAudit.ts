import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { recordAuditEvent } from "../services/securityAdmin.js";
import type { AuditEvent, AuthenticatedSession } from "../types/security.js";

/**
 * Read-access auditing (NFR-012). Viewing confidential data is itself recorded: who looked at which
 * screen or record, when, and from where. The event holds no data from the screen, only a reference.
 *
 * Which screens are audited is a list, not scattered code: SCREENS below. Qatar Airways agrees the
 * list; AUDIT_READ_SCREENS can replace it (comma-separated screen names, or "none" is refused:
 * auditing cannot be switched off) without a release.
 */

export type ScreenName = "queue-list" | "queue-item" | "user-directory" | "user-record" | "audit-trail" | "staff-profile" | "data-catalogue";

export const SCREENS: Record<ScreenName, { resource: string; label: string }> = {
  "queue-list": { resource: "TriageQueue", label: "Queue listing" },
  "queue-item": { resource: "TriageQueueItem", label: "Queue item (call record)" },
  "user-directory": { resource: "UserDirectory", label: "User directory" },
  "user-record": { resource: "UserAccount", label: "User record" },
  "audit-trail": { resource: "AuditTrail", label: "Audit trail" },
  "staff-profile": { resource: "StaffProfile", label: "Staff profile" },
  "data-catalogue": { resource: "DataCatalogue", label: "Data catalogue" }
};

export function auditedScreens(env: Record<string, string | undefined> = process.env): Set<ScreenName> {
  const raw = env.AUDIT_READ_SCREENS?.trim();
  if (!raw) return new Set(Object.keys(SCREENS) as ScreenName[]);
  const named = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const unknown = named.filter((name) => !(name in SCREENS));
  if (unknown.length > 0) throw new Error(`AUDIT_READ_SCREENS names unknown screens: ${unknown.join(", ")}.`);
  if (named.length === 0) throw new Error("AUDIT_READ_SCREENS cannot be empty: read auditing cannot be switched off.");
  return new Set(named as ScreenName[]);
}

type SessionRequest = Request & { securitySession?: AuthenticatedSession };

// A screen that refreshes itself (the queue listing polls every 20 seconds) would write an entry per
// refresh. The same user viewing the same screen or record again within this window is one entry.
const recentReads = new Map<string, number>();

function dedupeWindowMs(screen: ScreenName): number {
  const configured = Number(process.env.AUDIT_READ_DEDUP_SECONDS);
  if (Number.isFinite(configured) && configured >= 0) return configured * 1000;
  return screen === "queue-list" ? 5 * 60_000 : 60_000;
}

function alreadyRecorded(key: string, windowMs: number): boolean {
  const now = Date.now();
  for (const [k, at] of recentReads) if (now - at > 10 * 60_000) recentReads.delete(k);
  if (windowMs > 0 && now - (recentReads.get(key) ?? 0) < windowMs) return true;
  recentReads.set(key, now);
  return false;
}

export function resetReadAuditForTests(): void {
  recentReads.clear();
}

/** Records a DATA_READ event after a successful read of `screen`. `recordParam` names the route parameter that identifies a record. */
export function auditRead(screen: ScreenName, recordParam?: string) {
  return (req: SessionRequest, res: Response, next: NextFunction) => {
    res.on("finish", () => {
      if (res.statusCode >= 300 || !auditedScreens().has(screen)) return;
      const session = req.securitySession;
      if (!session) return;
      if (alreadyRecorded(`${session.user.id}|${screen}|${recordParam ? req.params[recordParam] : ""}`, dedupeWindowMs(screen))) return;
      const event: AuditEvent = {
        id: randomUUID(),
        timestampIso: new Date().toISOString(),
        userId: session.user.id,
        activeRole: session.activeRole,
        organization: session.user.organizationId ?? "",
        facility: "",
        department: "",
        action: "DATA_READ",
        module: "DataAccess",
        resource: SCREENS[screen].resource,
        recordReference: recordParam ? req.params[recordParam] : undefined,
        purpose: `Viewed ${SCREENS[screen].label}`,
        ipAddress: req.ip ?? "",
        device: String(req.headers["user-agent"] ?? ""),
        success: true,
        risk: "low",
        metadata: { screen, path: req.baseUrl + req.path, query: Object.keys(req.query).sort() }
      };
      void recordAuditEvent(event).catch(() => undefined);
    });
    next();
  };
}
