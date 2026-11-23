import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { requireAnyPermission, requirePermission, type AuthorizedRequest } from "../services/authorization.js";
import { buildAuditChange } from "../services/auditChange.js";
import { BranchRuleInput, draftRule, listRules, nextQuestion, retireRule, signOffRule } from "../services/adaptiveQuestions.js";
import { WorkError } from "../services/clinicalWork.js";
import { recordAuditEvent } from "../services/securityAdmin.js";
import {
  getCareAdviceForProtocol,
  getClinicalProtocolById,
  getCurrentClinicalContentPackage,
  listClinicalProtocols,
  searchClinicalProtocols
} from "../services/clinicalContent.js";
import { cacheGetOrSet } from "../services/sharedCache.js";
import { hiddenProtocolIds, protocolSetView, setProtocolSet } from "../services/protocolSets.js";
import { explainCandidate, possibleConditions, sourceInfo } from "../services/clinicalExplain.js";
import { DispositionCodeSchema } from "../types/triage.js";
import { ProtocolSearchQuerySchema } from "../types/clinicalContent.js";

export const BranchRuleInputSchema = BranchRuleInput;
export const ProtocolSetChangeSchema = z.object({ hiddenProtocolIds: z.array(z.string().min(1).max(200)).max(500), reason: z.string().trim().min(5).max(500) });

function parsePositiveQuestionIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  return [];
}

async function auditRule(req: AuthorizedRequest, action: string, resource: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const session = req.securitySession!;
  await recordAuditEvent({
    id: randomUUID(), timestampIso: new Date().toISOString(), userId: session.user.id, activeRole: session.activeRole, organization: session.user.organizationId ?? "", facility: "", department: "",
    action, module: "ClinicalContent", resource, ipAddress: "", device: "", success: true, risk: "high", metadata: { change: buildAuditChange(before, after) }
  });
}

function ruleFail(res: Response, error: unknown, next: (e?: unknown) => void) {
  if (error instanceof WorkError) return res.status(error.status).json({ error: error.message, code: error.code });
  return next(error);
}

export function createProtocolsRouter(): Router {
  const router = Router();

  router.get("/releases/current", (_req, res) => {
    const contentPackage = getCurrentClinicalContentPackage();
    res.json({
      release: contentPackage.release,
      protocolCount: contentPackage.protocols.length,
      localizedDispositionCount: contentPackage.localizedDispositions.length,
      warning:
        "Synthetic Phase 1 content is for software wiring only. Replace with licensed STCC content before clinical production use."
    });
  });

  router.get("/search", (req, res) => {
    const parsed = ProtocolSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid protocol search query", details: parsed.error.flatten() });
    }

    return res.json({
      release: getCurrentClinicalContentPackage().release,
      results: searchClinicalProtocols(parsed.data).filter((result) => !hiddenProtocolIds().has(result.id))
    });
  });

  router.get("/", async (req, res, next) => {
    try {
    const hidden = hiddenProtocolIds();
    // NFR-121 / NFR-076: the prepared protocol summary is reference data, shared between instances when a Redis-protocol cache is configured.
    const release = getCurrentClinicalContentPackage().release;
    const summary = await cacheGetOrSet(`protocols:summary:${String(release)}`, 300_000, () =>
      listClinicalProtocols().map((protocol) => ({
        id: protocol.id,
        titleEn: protocol.titleEn,
        clinicalDefinitionEn: protocol.clinicalDefinitionEn,
        ageMin: protocol.ageMin,
        ageMax: protocol.ageMax,
        mode: protocol.mode,
        questionCount: protocol.questions.length
      }))
    );
    const all = summary.filter((protocol) => !hidden.has(protocol.id));

    // Opt-in only (closes the remainder of R-03's pagination recommendation,
    // docs/load-test-baseline-2026-08-04.md) - omitted, response is the full
    // unpaginated list exactly as before.
    const limit = Number(req.query.limit);
    const offset = Number(req.query.offset) || 0;
    const hasLimit = Number.isInteger(limit) && limit > 0;
    const protocols = hasLimit ? all.slice(offset, offset + limit) : all;

    // Closes NFR-140 (caching for master/seed/configuration data) - protocol
    // metadata changes only on a new STCC content release, not per request.
    // `private` since this is behind session auth, not a shared/CDN cache.
    res.set("Cache-Control", "private, max-age=300");
    return res.json({
      release: getCurrentClinicalContentPackage().release,
      protocols,
      totalCount: all.length
    });
    } catch (error) {
      return next(error);
    }
  });

  // NFR-072: the protocol set offered to this organisation's nurses. Hides from the list and search only; see services/protocolSets.ts.
  router.get("/set", requireAnyPermission("protocol.library.manage", "clinical.governance.approve"), async (_req, res, next) => {
    try {
      return res.json(await protocolSetView());
    } catch (error) {
      return ruleFail(res, error, next);
    }
  });

  router.put("/set", requirePermission("clinical.governance.approve"), async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = ProtocolSetChangeSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid protocol set change", details: parsed.error.flatten() });
      const change = await setProtocolSet(parsed.data.hiddenProtocolIds, req.securitySession!.user.id, parsed.data.reason);
      await auditRule(req, "PROTOCOL_SET_CHANGED", "ProtocolSet", { hidden: change.before }, { hidden: change.after, version: change.version, reason: parsed.data.reason.slice(0, 200) });
      return res.json(change);
    } catch (error) {
      return ruleFail(res, error, next);
    }
  });

  // F-007: adaptive question layer. Only signed-off branches are used; the reasoning is returned with each question.
  router.get("/:protocolId/next-question", async (req, res, next) => {
    try {
      const answers = String(req.query.answers ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((pair) => {
        const [questionId, answer] = pair.split(":");
        return { questionId, answer: answer === "yes" ? ("yes" as const) : answer === "no" ? ("no" as const) : undefined };
      });
      if (answers.some((a) => !a.questionId || !a.answer)) return res.status(400).json({ error: "answers must look like questionId:yes,questionId:no" });
      return res.json(await nextQuestion(req.params.protocolId, answers as Array<{ questionId: string; answer: "yes" | "no" }>));
    } catch (error) {
      return ruleFail(res, error, next);
    }
  });

  router.get("/:protocolId/branch-rules", requireAnyPermission("protocol.library.manage", "clinical.governance.approve"), async (req, res, next) => {
    try {
      return res.json({ rules: await listRules(req.params.protocolId) });
    } catch (error) {
      return ruleFail(res, error, next);
    }
  });

  router.post("/:protocolId/branch-rules", requirePermission("protocol.library.manage"), async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = BranchRuleInputSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid branch rule", details: parsed.error.flatten() });
      const rule = await draftRule(req.params.protocolId, parsed.data, req.securitySession!.user.id);
      await auditRule(req, "BRANCH_RULE_DRAFTED", `BranchRule:${rule.id}`, null, { protocolId: rule.protocolId, from: rule.fromQuestionId, answer: rule.answer, next: rule.nextQuestionId });
      return res.status(201).json({ rule });
    } catch (error) {
      return ruleFail(res, error, next);
    }
  });

  router.post("/branch-rules/:ruleId/sign-off", requirePermission("clinical.governance.approve"), async (req: AuthorizedRequest, res, next) => {
    try {
      const rule = await signOffRule(req.params.ruleId, req.securitySession!.user.id);
      await auditRule(req, "BRANCH_RULE_SIGNED_OFF", `BranchRule:${rule.id}`, { status: "draft" }, { status: "signed_off" });
      return res.json({ rule });
    } catch (error) {
      return ruleFail(res, error, next);
    }
  });

  router.delete("/branch-rules/:ruleId", requirePermission("protocol.library.manage"), async (req: AuthorizedRequest, res, next) => {
    try {
      await retireRule(req.params.ruleId);
      await auditRule(req, "BRANCH_RULE_RETIRED", `BranchRule:${req.params.ruleId}`, { status: "active" }, { status: "retired" });
      return res.json({ retired: true });
    } catch (error) {
      return ruleFail(res, error, next);
    }
  });

  // F-006: where a protocol's content comes from and who reviewed it.
  router.get("/:protocolId/source", (req, res) => {
    const protocol = getClinicalProtocolById(req.params.protocolId);
    if (!protocol) return res.status(404).json({ error: "Protocol not found" });
    return res.json(sourceInfo(protocol));
  });

  // F-022 / AI-023: why this protocol was suggested, from the search and the questions answered.
  router.get("/:protocolId/explain", (req, res) => {
    const age = req.query.ageYears === undefined ? undefined : Number(req.query.ageYears);
    const explanation = explainCandidate(req.params.protocolId, {
      q: typeof req.query.q === "string" ? req.query.q.slice(0, 240) : undefined,
      ageYears: age !== undefined && Number.isInteger(age) && age >= 0 && age <= 120 ? age : undefined,
      positiveQuestionIds: parsePositiveQuestionIds(req.query.positiveQuestionIds)
    });
    if (!explanation) return res.status(404).json({ error: "Protocol not found" });
    return res.json(explanation);
  });

  // F-009: possible-conditions view, off until clinically and regulatorily reviewed.
  router.get("/:protocolId/possible-conditions", (req, res) => {
    const result = possibleConditions(req.params.protocolId);
    return res.status(result.enabled && !result.protocolId ? 404 : 200).json(result);
  });

  router.get("/:protocolId", (req, res) => {
    const protocol = getClinicalProtocolById(req.params.protocolId);
    if (!protocol) {
      return res.status(404).json({ error: "Protocol not found" });
    }

    return res.json({
      release: getCurrentClinicalContentPackage().release,
      protocol
    });
  });

  router.get("/:protocolId/care-advice", (req, res) => {
    const protocol = getClinicalProtocolById(req.params.protocolId);
    if (!protocol) {
      return res.status(404).json({ error: "Protocol not found" });
    }

    const positiveQuestionIds = parsePositiveQuestionIds(req.query.positiveQuestionIds);
    const dispositionCode = req.query.dispositionCode
      ? DispositionCodeSchema.safeParse(req.query.dispositionCode)
      : undefined;

    if (dispositionCode && !dispositionCode.success) {
      return res.status(400).json({ error: "Invalid dispositionCode" });
    }

    if (positiveQuestionIds.length === 0) {
      return res.status(422).json({
        error: "Exact protocol question lineage is required for care advice",
        code: "CARE_ADVICE_QUESTION_REQUIRED"
      });
    }

    const protocolQuestionIds = new Set(protocol.questions.map((question) => question.id));
    const unknownQuestionIds = positiveQuestionIds.filter((questionId) => !protocolQuestionIds.has(questionId));
    if (unknownQuestionIds.length > 0) {
      return res.status(422).json({
        error: "One or more questions do not belong to the selected protocol",
        code: "CARE_ADVICE_PROTOCOL_MISMATCH",
        unknownQuestionIds
      });
    }

    return res.json({
      release: getCurrentClinicalContentPackage().release,
      protocolId: protocol.id,
      questionIds: positiveQuestionIds,
      selectionMode: "EXACT_QUESTION",
      careAdvice: getCareAdviceForProtocol(protocol.id, positiveQuestionIds)
    });
  });

  return router;
}
