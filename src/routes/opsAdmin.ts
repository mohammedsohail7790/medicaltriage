import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { shouldPersistPlatformInDatabase } from "../config/runtime.js";
import { prisma } from "../db.js";
import { buildAuditChange } from "../services/auditChange.js";
import { requireElevatedPermission, requirePermission, canPerformAction, type AuthorizedRequest } from "../services/authorization.js";
import { WorkError } from "../services/clinicalWork.js";
import { ScheduleInput, cancelRun, cancelSchedule, createSchedule, getRun, listRuns, listSchedules, runNow, schedulerHandlerNames, setScheduleEnabled } from "../services/jobScheduler.js";
import { listRules, ruleHistory, setRule } from "../services/businessRules.js";
import { flagHistory, listFlags, setFlag } from "../services/featureFlags.js";
import { databaseRoleReport } from "../services/databaseRole.js";
import { rotationReport } from "../services/secretRotation.js";
import { evaluateInterfaces, interfaceStats } from "../integration/interfaceStats.js";
import { callCreationTimes, volumeDip } from "../services/businessMetrics.js";
import { runbookFor } from "../services/jobRunbooks.js";
import { listUsers } from "../services/securityAdmin.js";
import { collectMetrics } from "../observability/metrics.js";
import { recentTraces, spansForTrace } from "../observability/tracing.js";
import { Thresholds, evaluate, getThresholds, setThresholds } from "../services/performanceMonitor.js";
import { runSyntheticChecks } from "../services/syntheticChecks.js";
import { usageInsights } from "../services/usageInsights.js";
import { resourceLimits, resourceStatus } from "../services/resourceGuard.js";
import { recordAuditEvent } from "../services/securityAdmin.js";
import type { AuthenticatedSession } from "../types/security.js";

export const ScheduleInputSchema = ScheduleInput;
export const ThresholdsSchema = Thresholds;
export const FlagChangeSchema = z.object({ value: z.boolean(), reason: z.string().trim().min(5).max(500) });

/**
 * Job scheduling and monitoring (NFR-041, 042, 043, 046, 039) and the status of asynchronous work (NFR-126).
 * Reading needs audit access; every change needs elevation and is audited with before and after values.
 */

async function audit(session: AuthenticatedSession, action: string, resource: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  await recordAuditEvent({
    id: randomUUID(), timestampIso: new Date().toISOString(), userId: session.user.id, activeRole: session.activeRole, organization: session.user.organizationId ?? "", facility: "", department: "",
    action, module: "Operations", resource, ipAddress: "", device: "", success: true, risk: "medium", metadata: { change: buildAuditChange(before, after) }
  });
}

function fail(res: Response, error: unknown, next: (e?: unknown) => void) {
  if (error instanceof WorkError) return res.status(error.status).json({ error: error.message, code: error.code });
  return next(error);
}

export function createOpsAdminRouter(): Router {
  const router = Router();
  const read = requirePermission("audit.events.view");
  const write = requireElevatedPermission("admin.users.manage");

  router.get("/handlers", read, (_req, res) => res.json({ handlers: schedulerHandlerNames(), runbooks: Object.fromEntries(schedulerHandlerNames().map((n) => [n, runbookFor(n) ?? null])) }));

  // NFR-111 interface monitoring, NFR-107 business volume
  router.get("/interfaces", read, (_req, res) => res.json({ interfaces: interfaceStats(), outsideThresholds: evaluateInterfaces() }));
  router.get("/volume", read, async (_req, res, next) => {
    try {
      // Reading the figure never raises an alert; the scheduled check does that.
      const now = new Date();
      return res.json(volumeDip(await callCreationTimes(new Date(now.getTime() - 29 * 86_400_000).toISOString()), now));
    } catch (error) {
      return fail(res, error, next);
    }
  });
  router.get("/resources", read, (_req, res) => res.json({ ...resourceStatus(), limits: resourceLimits() }));

  // ---- performance monitoring, thresholds, traces (NFR-131, 110, 132, 101) ----
  router.get("/metrics", read, async (_req, res, next) => {
    try {
      return res.json(await collectMetrics());
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.get("/thresholds", read, async (_req, res, next) => {
    try {
      return res.json({ thresholds: await getThresholds(), findings: evaluate(await getThresholds()) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.put("/thresholds", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = ThresholdsSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid thresholds", details: parsed.error.flatten() });
      const change = await setThresholds(parsed.data, req.securitySession!.user.id);
      await audit(req.securitySession!, "PERFORMANCE_THRESHOLDS_CHANGED", "PerformanceThresholds", change.before, change.after);
      return res.json({ thresholds: change.after });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.get("/traces", read, (req, res) => {
    const id = typeof req.query.traceId === "string" ? req.query.traceId : undefined;
    return res.json(id ? { traceId: id, spans: spansForTrace(id) } : { traces: recentTraces(Math.min(Number(req.query.limit) || 50, 200)) });
  });

  router.get("/usage-insights", read, async (req: AuthorizedRequest, res, next) => {
    try {
      const reveal = req.query.reveal === "true" && canPerformAction(req.securitySession, "privacy.reveal.approve");
      const insights = await usageInsights({ sinceIso: typeof req.query.since === "string" ? req.query.since : undefined, untilIso: typeof req.query.until === "string" ? req.query.until : undefined, organization: req.securitySession!.user.organizationId ?? undefined, revealUsers: reveal });
      if (reveal) await audit(req.securitySession!, "USAGE_INSIGHTS_IDENTITIES_VIEWED", "UsageInsights", null, null);
      return res.json({ ...insights, usersMasked: !reveal });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/synthetic", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const outcome = await runSyntheticChecks();
      await audit(req.securitySession!, "SYNTHETIC_CHECKS_RUN", "SyntheticChecks", null, { ok: outcome.ok, failed: outcome.results.filter((r) => !r.ok).length });
      return res.json(outcome);
    } catch (error) {
      return fail(res, error, next);
    }
  });

  // ---- configurable business rules (NFR-144) ----
  router.get("/rules", read, async (_req, res, next) => {
    try {
      return res.json({ rules: await listRules(), note: "Clinical safety floors are not configurable here; they change only through a clinical release." });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.get("/rules/:key/history", read, async (req, res, next) => {
    try {
      return res.json({ history: await ruleHistory(String(req.params.key)) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.put("/rules/:key", write, async (req: AuthorizedRequest, res, next) => {
    try {
      // contract: BusinessRuleChangeBodySchema
      const change = await setRule(String(req.params.key), req.body?.value, req.securitySession!.user.id, typeof req.body?.reason === "string" ? req.body.reason : "");
      await audit(req.securitySession!, "BUSINESS_RULE_CHANGED", `BusinessRule:${req.params.key}`, { value: change.before }, { value: change.after, version: change.version, reason: String(req.body.reason).slice(0, 200) });
      return res.json({ key: req.params.key, ...change });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  // ---- NFR-072 feature flags: optional integrations and aids, never a clinical safeguard ----
  router.get("/flags", read, async (_req, res, next) => {
    try {
      return res.json({ flags: await listFlags(), note: "Flags switch optional integrations and aids only. Clinical safeguards are not flags." });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.get("/flags/:key/history", read, async (req, res, next) => {
    try {
      return res.json({ history: await flagHistory(String(req.params.key)) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.put("/flags/:key", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = FlagChangeSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid feature flag change", details: parsed.error.flatten() });
      const change = await setFlag(String(req.params.key), parsed.data.value, req.securitySession!.user.id, parsed.data.reason);
      await audit(req.securitySession!, "FEATURE_FLAG_CHANGED", `FeatureFlag:${req.params.key}`, { value: change.before }, { value: change.after, version: change.version, reason: parsed.data.reason.slice(0, 200) });
      return res.json({ key: req.params.key, ...change });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  // ---- NFR-161 secret rotation, NFR-153 database role ----
  router.get("/secrets-rotation", read, (_req, res) => res.json(rotationReport()));

  router.get("/database-role", read, async (_req, res, next) => {
    try {
      return res.json(await databaseRoleReport());
    } catch (error) {
      return fail(res, error, next);
    }
  });

  // F-001: clinical-content licence usage. Named users with clinical roles against the number the licence covers.
  router.get("/licence-usage", read, (_req, res) => {
    const clinical = new Set(["remote_triage_nurse", "teleconsultant_physician", "clinical_safety_officer", "qa_reviewer"]);
    const { users } = listUsers({ limit: 10_000, offset: 0 });
    const named = users.filter((u) => u.accountStatus === "active" && u.roles.some((r) => clinical.has(r)));
    const licensed = Number(process.env.STCC_LICENSED_USERS);
    const known = Number.isFinite(licensed) && licensed > 0;
    return res.json({ namedClinicalUsers: named.length, licensedUsers: known ? licensed : null, status: !known ? "licence count not recorded" : named.length > licensed ? "over licence" : "within licence", note: "Counts active accounts holding a clinical role. The licence terms decide who counts; confirm them with the licensor." });
  });

  router.get("/schedules", read, async (_req, res, next) => {
    try {
      return res.json({ schedules: await listSchedules() });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/schedules", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = ScheduleInputSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid schedule", details: parsed.error.flatten() });
      const schedule = await createSchedule(parsed.data, req.securitySession!.user.id);
      await audit(req.securitySession!, "SCHEDULE_CREATED", `Schedule:${schedule.id}`, null, { name: schedule.name, handler: schedule.handler, mode: schedule.mode, cron: schedule.cron ?? null, priority: schedule.priority });
      return res.status(201).json({ schedule });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  for (const [verb, enabled] of [["enable", true], ["disable", false]] as const) {
    router.post(`/schedules/:id/${verb}`, write, async (req: AuthorizedRequest, res, next) => {
      try {
        const schedule = await setScheduleEnabled(String(req.params.id), enabled);
        await audit(req.securitySession!, enabled ? "SCHEDULE_ENABLED" : "SCHEDULE_DISABLED", `Schedule:${schedule.id}`, { status: enabled ? "paused" : "active" }, { status: schedule.status });
        return res.json({ schedule });
      } catch (error) {
        return fail(res, error, next);
      }
    });
  }

  router.delete("/schedules/:id", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const schedule = await cancelSchedule(String(req.params.id));
      await audit(req.securitySession!, "SCHEDULE_CANCELLED", `Schedule:${schedule.id}`, null, { status: "cancelled" });
      return res.json({ schedule });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  // User-triggered run. With ?async=true it returns at once with the run to poll.
  router.post("/schedules/:id/run", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const asynchronous = req.query.async === "true";
      const run = await runNow(String(req.params.id), { wait: !asynchronous });
      await audit(req.securitySession!, "SCHEDULE_RUN_TRIGGERED", `Schedule:${req.params.id}`, null, { runId: run.id, async: asynchronous });
      return res.status(asynchronous ? 202 : 200).json({ run });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.get("/runs", read, async (req, res, next) => {
    try {
      const scheduleId = typeof req.query.scheduleId === "string" ? req.query.scheduleId : undefined;
      return res.json({ runs: await listRuns(scheduleId, Math.min(Number(req.query.limit) || 100, 500)) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.get("/runs/:id", read, async (req, res, next) => {
    try {
      const run = await getRun(String(req.params.id));
      return run ? res.json({ run }) : res.status(404).json({ error: "Run not found." });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/runs/:id/cancel", write, async (req: AuthorizedRequest, res, next) => {
    try {
      const run = await cancelRun(String(req.params.id));
      await audit(req.securitySession!, "RUN_CANCELLED", `JobRun:${run.id}`, { status: "running" }, { status: run.status });
      return res.json({ run });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  return router;
}

/**
 * Status of asynchronous work the caller started (NFR-126): a queued integration job such as an EMR write-back,
 * or a scheduler run. The person who asked for it, or an administrator, can read it.
 */
export function createJobStatusRouter(): Router {
  const router = Router();
  router.get("/:id", requirePermission("triage.workspace.view"), async (req: AuthorizedRequest, res, next) => {
    try {
      const session = req.securitySession!;
      const id = String(req.params.id);
      const admin = canPerformAction(session, "audit.events.view");
      if (shouldPersistPlatformInDatabase()) {
        const job = await prisma.integrationJob.findUnique({ where: { id } });
        if (job) {
          const owner = (job.payload as { requestedBy?: string } | null)?.requestedBy;
          if (!admin && owner !== session.user.id) return res.status(404).json({ error: "Job not found." });
          return res.json({ job: { id: job.id, type: job.type, status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts, nextAttemptAtIso: job.nextAttemptAt.toISOString(), lastError: job.lastError, createdAtIso: job.createdAt.toISOString(), completedAtIso: job.completedAt?.toISOString() ?? null } });
        }
      }
      const run = admin ? await getRun(id) : undefined;
      return run ? res.json({ job: { id: run.id, type: "scheduled-run", status: run.status, attempts: run.attempts, maxAttempts: run.maxAttempts, lastError: run.error, createdAtIso: run.startedAtIso, completedAtIso: run.endedAtIso } }) : res.status(404).json({ error: "Job not found." });
    } catch (error) {
      return fail(res, error, next);
    }
  });
  return router;
}
