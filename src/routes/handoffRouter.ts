import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { requirePermission, type AuthorizedRequest } from "../services/authorization.js";
import { buildAuditChange } from "../services/auditChange.js";
import { WorkError, getItem, listItems, type WorkItem } from "../services/clinicalWork.js";
import { HandoffInput, HandoffResponse, ReferralInput, acceptHandoff, approveHandoff, approveReferral, createReferral, proposeHandoff, referralPdf, respondToHandoff, sendReferral } from "../services/clinicalHandoff.js";
import { recordAuditEvent } from "../services/securityAdmin.js";
import type { AuthenticatedSession } from "../types/security.js";

/** Referral letters (F-017) and escalation to a teleconsultant physician (F-016). */

async function audit(session: AuthenticatedSession, action: string, resource: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  await recordAuditEvent({
    id: randomUUID(), timestampIso: new Date().toISOString(), userId: session.user.id, activeRole: session.activeRole, organization: session.user.organizationId ?? "", facility: "", department: "",
    action, module: "ClinicalHandoff", resource, ipAddress: "", device: "", success: true, risk: "high", metadata: { change: buildAuditChange(before, after) }
  });
}

function fail(res: Response, error: unknown, next: (e?: unknown) => void) {
  if (error instanceof WorkError) return res.status(error.status).json({ error: error.message, code: error.code });
  return next(error);
}

const referralView = (item: WorkItem) => ({ id: item.id, status: item.status, caseRef: item.caseRef ?? null, createdAtIso: item.createdAtIso, ...(item.payload.fields as object), sentTo: item.payload.sentTo ?? null });
const handoffView = (item: WorkItem) => ({ id: item.id, status: item.status, caseRef: item.caseRef ?? null, createdAtIso: item.createdAtIso, assignee: item.assignee ?? null, urgency: item.payload.urgency, question: item.payload.question, summary: item.payload.summary, nurseName: item.payload.nurseName, response: item.payload.response ?? null });

export const ReferralSendInput = z.object({ to: z.string().trim().email().max(200) });

export function createHandoffRouter(): Router {
  const router = Router();
  const nurse = requirePermission("triage.workspace.view");
  const physician = requirePermission("teleconsult.case.review");

  // ---- referral letters ----
  router.post("/referrals", nurse, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = ReferralInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid referral", details: parsed.error.flatten() });
      const item = await createReferral(parsed.data, req.securitySession!);
      await audit(req.securitySession!, "REFERRAL_DRAFTED", `ClinicalWorkItem:${item.id}`, null, { caseRef: item.caseRef ?? null, destination: parsed.data.destinationName });
      return res.status(201).json({ referral: referralView(item) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.get("/referrals/:id/pdf", nurse, async (req: AuthorizedRequest, res, next) => {
    try {
      const { item, pdf } = await referralPdf(String(req.params.id), req.securitySession!);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="referral-${item.id}.pdf"`);
      return res.send(pdf);
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/referrals/:id/approve", nurse, async (req: AuthorizedRequest, res, next) => {
    try {
      const item = await approveReferral(String(req.params.id), req.securitySession!);
      await audit(req.securitySession!, "REFERRAL_APPROVED", `ClinicalWorkItem:${item.id}`, { status: "draft" }, { status: "approved" });
      return res.json({ referral: referralView(item) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/referrals/:id/send", nurse, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = ReferralSendInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid recipient", details: parsed.error.flatten() });
      const item = await sendReferral(String(req.params.id), parsed.data.to, req.securitySession!);
      await audit(req.securitySession!, item.status === "sent" ? "REFERRAL_SENT" : "REFERRAL_SEND_FAILED", `ClinicalWorkItem:${item.id}`, { status: "approved" }, { status: item.status, recipientDomain: parsed.data.to.split("@")[1] });
      return res.json({ referral: referralView(item) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  // ---- teleconsultant escalation ----
  router.post("/teleconsult", nurse, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = HandoffInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid handoff", details: parsed.error.flatten() });
      const item = await proposeHandoff(parsed.data, req.securitySession!);
      await audit(req.securitySession!, "TELECONSULT_PROPOSED", `ClinicalWorkItem:${item.id}`, null, { caseRef: item.caseRef ?? null, urgency: parsed.data.urgency });
      return res.status(201).json({ handoff: handoffView(item) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/teleconsult/:id/approve", nurse, async (req: AuthorizedRequest, res, next) => {
    try {
      const item = await approveHandoff(String(req.params.id), req.securitySession!);
      await audit(req.securitySession!, "TELECONSULT_SENT", `ClinicalWorkItem:${item.id}`, { status: "awaiting_nurse_approval" }, { status: "queued", mode: (item.payload.delivery as { mode?: string } | undefined)?.mode ?? null });
      return res.json({ handoff: handoffView(item) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.get("/teleconsult/queue", physician, async (req: AuthorizedRequest, res, next) => {
    try {
      const org = req.securitySession!.user.organizationId;
      const open = [...(await listItems({ kind: "teleconsult", status: "queued" })), ...(await listItems({ kind: "teleconsult", status: "accepted" }))];
      return res.json({ items: open.filter((i) => !org || !i.organizationId || i.organizationId === org).map(handoffView) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.get("/teleconsult/:id", nurse, async (req: AuthorizedRequest, res, next) => {
    try {
      const item = await getItem(String(req.params.id), "teleconsult");
      if (!item || item.createdBy !== req.securitySession!.user.id) return res.status(404).json({ error: "Handoff not found." });
      return res.json({ handoff: handoffView(item) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/teleconsult/:id/accept", physician, async (req: AuthorizedRequest, res, next) => {
    try {
      const item = await acceptHandoff(String(req.params.id), req.securitySession!);
      await audit(req.securitySession!, "TELECONSULT_ACCEPTED", `ClinicalWorkItem:${item.id}`, { status: "queued" }, { status: "accepted" });
      return res.json({ handoff: handoffView(item) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/teleconsult/:id/respond", physician, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = HandoffResponse.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid response", details: parsed.error.flatten() });
      const item = await respondToHandoff(String(req.params.id), parsed.data, req.securitySession!);
      await audit(req.securitySession!, "TELECONSULT_ANSWERED", `ClinicalWorkItem:${item.id}`, { status: "accepted" }, { status: "answered", outcome: parsed.data.outcome });
      return res.json({ handoff: handoffView(item) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  return router;
}
