import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { shouldUseDatabasePersistence } from "../config/runtime.js";
import { requireAnyPermission, requirePermission, type AuthorizedRequest } from "../services/authorization.js";
import { buildAuditChange } from "../services/auditChange.js";
import { QueueOrchestrationError } from "../services/queueOrchestration.js";
import {
  IncidentClosure, IncidentInput, QaReviewInput, SamplingInput, WorkError, closeIncident, getItem, listItems, listQaQueue, maskedReviewView, reportIncident, sampleCalls, submitQaReview, takeIncidentForReview, type WorkItem
} from "../services/clinicalWork.js";
import { InitialAssessmentPolicy, detectRedFlags, initialAssessmentRequired, setInitialAssessmentPolicy } from "../services/initialAssessment.js";
import { recordAuditEvent } from "../services/securityAdmin.js";
import type { AuthenticatedSession } from "../types/security.js";
import { liveSafetyDashboard } from "./approvalRouter.js";

/**
 * Clinical safety and quality (F-019, F-020, F-021, F-023). Everything here reads live records: where there
 * is no database the dashboard says so instead of showing sample figures.
 */

async function audit(session: AuthenticatedSession, action: string, resource: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  await recordAuditEvent({
    id: randomUUID(), timestampIso: new Date().toISOString(), userId: session.user.id, activeRole: session.activeRole, organization: session.user.organizationId ?? "", facility: "", department: "",
    action, module: "ClinicalSafety", resource, ipAddress: "", device: "", success: true, risk: "medium", metadata: { change: buildAuditChange(before, after) }
  });
}

function fail(res: Response, error: unknown, next: (e?: unknown) => void) {
  if (error instanceof WorkError) return res.status(error.status).json({ error: error.message, code: error.code });
  if (error instanceof QueueOrchestrationError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
  return next(error);
}

const incidentView = (item: WorkItem) => ({ id: item.id, status: item.status, caseRef: item.caseRef ?? null, createdAtIso: item.createdAtIso, assignee: item.assignee ?? null, ...item.payload });

export async function qualityMetrics() {
  const incidents = await listItems({ kind: "incident", limit: 1000 });
  const reviews = await listItems({ kind: "qa_review", limit: 1000 });
  const reviewed = reviews.filter((r) => r.status === "reviewed");
  const scores = reviewed.map((r) => Number((r.payload.review as { score?: number } | undefined)?.score)).filter(Number.isFinite);
  const count = <T>(rows: T[], key: (row: T) => string) => rows.reduce<Record<string, number>>((acc, row) => ({ ...acc, [key(row)]: (acc[key(row)] ?? 0) + 1 }), {});
  // Training needs are counted per nurse, so a coach can see where to spend time; scores are not ranked.
  const coaching = count(reviewed.filter((r) => (r.payload.review as { followUp?: string } | undefined)?.followUp === "coaching"), (r) => String(r.payload.handlingNurseId ?? "unknown"));
  return {
    incidents: { total: incidents.length, byStatus: count(incidents, (i) => i.status), bySeverity: count(incidents, (i) => String(i.payload.severity)), nearMisses: incidents.filter((i) => i.payload.type === "near_miss").length },
    qualityReview: { sampled: reviews.length, reviewed: reviewed.length, pending: reviews.length - reviewed.length, averageScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null, scoreDistribution: count(reviewed, (r) => String((r.payload.review as { score?: number }).score)) },
    trainingNeeds: { coachingByNurse: coaching }
  };
}

export function createSafetyRouter(): Router {
  const router = Router();
  const officer = requirePermission("safety.dashboard.view");
  const manage = requirePermission("safety.incidents.manage");
  const reportAccess = requireAnyPermission("triage.workspace.view", "safety.incidents.manage");
  const sampleAccess = requireAnyPermission("safety.incidents.manage", "qa.review.perform");

  // ---- F-023 / F-019 dashboard: live data only ----
  router.get("/dashboard", officer, async (req: AuthorizedRequest, res, next) => {
    try {
      if (!shouldUseDatabasePersistence()) {
        return res.json({ live: false, message: "The safety dashboard shows live records only, and this deployment has no database connected." });
      }
      const [safety, quality] = await Promise.all([liveSafetyDashboard(req.securitySession), qualityMetrics()]);
      await audit(req.securitySession!, "SAFETY_DASHBOARD_VIEWED", "SafetyDashboard", null, null);
      return res.json({ live: true, generatedAtIso: new Date().toISOString(), ...safety, quality });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  // ---- F-008 Initial Assessment policy and red-flag check ----
  router.get("/initial-assessment-policy", requireAnyPermission("safety.dashboard.view", "admin.users.manage", "triage.workspace.view"), async (_req, res, next) => {
    try {
      return res.json({ required: await initialAssessmentRequired(0) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.put("/initial-assessment-policy", requireAnyPermission("admin.users.manage"), async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = InitialAssessmentPolicy.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid policy", details: parsed.error.flatten() });
      // Switching the rule-out off is a clinical-risk decision and needs a stated reason.
      if (!parsed.data.required && !parsed.data.reason) return res.status(400).json({ error: "A reason is required to make the Initial Assessment optional." });
      const change = await setInitialAssessmentPolicy(parsed.data, req.securitySession!.user.id);
      await audit(req.securitySession!, "INITIAL_ASSESSMENT_POLICY_CHANGED", "InitialAssessmentPolicy", { required: change.before }, { required: change.after, reason: parsed.data.reason ?? null });
      return res.json({ required: change.after });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/red-flags", requireAnyPermission("triage.workspace.view"), (req: AuthorizedRequest, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim() || text.length > 5000) return res.status(400).json({ error: "Give the caller's words, up to 5000 characters." });
    const extra = Array.isArray(req.body?.emergencyKeywords) ? req.body.emergencyKeywords.filter((k: unknown): k is string => typeof k === "string").slice(0, 50) : [];
    const matches = detectRedFlags(text, extra);
    return res.json({ matches, escalateNowSuggested: matches.length > 0, note: "A prompt for the nurse. It never sets or lowers a disposition." });
  });

  // ---- F-021 incidents ----
  router.post("/incidents", reportAccess, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = IncidentInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid incident report", details: parsed.error.flatten() });
      const item = await reportIncident(parsed.data, req.securitySession!);
      await audit(req.securitySession!, "INCIDENT_REPORTED", `ClinicalWorkItem:${item.id}`, null, { type: parsed.data.type, severity: parsed.data.severity, caseRef: parsed.data.caseRef ?? null });
      return res.status(201).json({ incident: incidentView(item) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.get("/incidents", manage, async (req: AuthorizedRequest, res, next) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const items = await listItems({ kind: "incident", status, organizationId: req.securitySession!.user.organizationId ?? undefined });
      return res.json({ incidents: items.map(incidentView) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/incidents/:id/review", manage, async (req: AuthorizedRequest, res, next) => {
    try {
      const item = await takeIncidentForReview(String(req.params.id), req.securitySession!);
      await audit(req.securitySession!, "INCIDENT_REVIEW_STARTED", `ClinicalWorkItem:${item.id}`, { status: "reported" }, { status: "under_review" });
      return res.json({ incident: incidentView(item) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/incidents/:id/close", manage, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = IncidentClosure.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid closure", details: parsed.error.flatten() });
      const before = await getItem(String(req.params.id), "incident");
      const item = await closeIncident(String(req.params.id), parsed.data, req.securitySession!);
      await audit(req.securitySession!, "INCIDENT_CLOSED", `ClinicalWorkItem:${item.id}`, { status: before?.status ?? null }, { status: "closed", actions: parsed.data.correctiveActions.length });
      return res.json({ incident: incidentView(item) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  // ---- F-020 sampling and review ----
  router.post("/qa/samples", sampleAccess, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = SamplingInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid sampling request", details: parsed.error.flatten() });
      const result = await sampleCalls(parsed.data, req.securitySession!);
      await audit(req.securitySession!, "QA_SAMPLE_DRAWN", `QaSelection:${result.selectionId}`, null, { eligible: result.eligible, selected: result.selected.length, count: parsed.data.count ?? null, percent: parsed.data.percent ?? null });
      return res.status(201).json({ selectionId: result.selectionId, eligible: result.eligible, selected: result.selected.map(maskedReviewView) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.get("/qa/queue", requirePermission("qa.review.perform"), async (req: AuthorizedRequest, res, next) => {
    try {
      return res.json({ items: (await listQaQueue(req.securitySession!)).map(maskedReviewView) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/qa/:id/review", requirePermission("qa.review.perform"), async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = QaReviewInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid review", details: parsed.error.flatten() });
      const item = await submitQaReview(String(req.params.id), parsed.data, req.securitySession!);
      await audit(req.securitySession!, "QA_REVIEW_SUBMITTED", `ClinicalWorkItem:${item.id}`, { status: "pending" }, { status: "reviewed", score: parsed.data.score, followUp: parsed.data.followUp });
      return res.json({ item: maskedReviewView(item) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  return router;
}

export const IncidentReportSchema = IncidentInput;
export const QaReviewSchema = QaReviewInput;
export const SamplingRequestSchema = SamplingInput;
export const IncidentClosureSchema = IncidentClosure;
