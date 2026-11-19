import { Router } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { shouldUseDatabasePersistence } from "../config/runtime.js";
import { listPersistedAuditEvents } from "../services/persistence.js";
import {
  assertExportEnabled,
  describeExport,
  ExportGovernanceError,
  inspectExportWithDlp,
  recordExportEvent
} from "../services/exportGovernance.js";
import { listActiveSessionsForUser, listAuditEvents } from "../services/securityAdmin.js";

// Closes NFR-192 (Data Portability) - a real, self-service "export all my
// data" capability, returning the caller's own profile, active sessions,
// and audit trail as a single downloadable JSON file in an open,
// non-proprietary format. No admin permission required - this only ever
// returns the caller's own data (req.securitySession.user.id), never
// another user's.
export function createMeRouter(): Router {
  const router = Router();

  router.get("/export", async (req: AuthenticatedRequest, res, next) => {
    try {
      const session = req.securitySession;
      if (!session) {
        return res.status(401).json({ error: "Authentication required" });
      }

      try {
        assertExportEnabled("self");
      } catch (error) {
        if (error instanceof ExportGovernanceError) {
          await recordExportEvent({ action: "EXPORT_DENIED", kind: "self", session, resourceId: session.user.id, success: false, metadata: { code: error.code } });
          return res.status(error.status).json({ error: error.message, code: error.code });
        }
        throw error;
      }

      const auditEvents = shouldUseDatabasePersistence()
        ? await listPersistedAuditEvents(500, { userId: session.user.id })
        : listAuditEvents({ userId: session.user.id });

      const exportBody = {
        exportedAtIso: new Date().toISOString(),
        format: "json",
        profile: session.user,
        activeSessions: listActiveSessionsForUser(session.user.id),
        auditEvents
      };

      const descriptor = describeExport("self", session, session.user.id, exportBody, auditEvents.length + 1);
      try {
        await inspectExportWithDlp(descriptor);
      } catch (error) {
        if (error instanceof ExportGovernanceError) {
          await recordExportEvent({ action: "EXPORT_DENIED", kind: "self", session, resourceId: session.user.id, success: false, metadata: { code: error.code } });
          return res.status(error.status).json({ error: error.message, code: error.code });
        }
        throw error;
      }
      await recordExportEvent({
        action: "EXPORT_COMPLETED",
        kind: "self",
        session,
        resourceId: session.user.id,
        success: true,
        metadata: { recordCount: descriptor.recordCount, bytes: descriptor.bytes, sha256: descriptor.sha256 }
      });
      res.setHeader("Content-Disposition", `attachment; filename="ist-health-my-data-${session.user.id}.json"`);
      return res.json(exportBody);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
