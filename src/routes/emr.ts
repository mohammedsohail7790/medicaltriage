import { enqueueJob } from "../services/integrationQueue.js";
import { Router } from "express";
import { z } from "zod";
import { executeWriteback } from "../integration/fhirWriteback.js";
import { requirePermission, type AuthorizedRequest } from "../services/authorization.js";
import type { RequestWithId } from "../middleware/requestId.js";

export const ExecuteWritebackRequestSchema = z
  .object({
    isDraft: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    patientId: z.string().min(1).max(120).optional(),
    practitionerId: z.string().min(1).max(120).optional()
  })
  .default({});

export function createEmrRouter(): Router {
  const router = Router();

  router.post("/writeback/:encounterId", requirePermission("triage.workspace.view"), async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = ExecuteWritebackRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid EMR/FHIR writeback payload", details: parsed.error.flatten() });
      }

      // NFR-094: with ?async=true (or EMR_WRITEBACK_ASYNC=true) the write-back is queued and done by a worker, so an
      // unavailable EMR never holds up the nurse. The job is retried and dead-lettered like any integration job.
      const asynchronous = req.query.async === "true" || (req.query.async === undefined && process.env.EMR_WRITEBACK_ASYNC === "true");
      if (asynchronous) {
        const jobId = await enqueueJob({
          type: "emr.writeback",
          payload: { encounterId: req.params.encounterId, requestedBy: req.securitySession?.user.id ?? null, organizationId: req.securitySession?.user.organizationId ?? null, options: { isDraft: parsed.data.isDraft, dryRun: parsed.data.dryRun, patientId: parsed.data.patientId, practitionerId: parsed.data.practitionerId } },
          correlationId: (req as AuthorizedRequest & RequestWithId).requestId
        });
        return res.status(202).json({ queued: true, jobId });
      }
      const result = await executeWriteback(
        req.params.encounterId,
        {
          isDraft: parsed.data.isDraft,
          dryRun: parsed.data.dryRun,
          patientId: parsed.data.patientId,
          practitionerId: parsed.data.practitionerId,
          requestId: (req as AuthorizedRequest & RequestWithId).requestId
        },
        req.securitySession
      );
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

