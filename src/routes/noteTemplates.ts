import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { requirePermission, type AuthorizedRequest } from "../services/authorization.js";
import { buildAuditChange } from "../services/auditChange.js";
import { WorkError } from "../services/clinicalWork.js";
import { PLACEHOLDERS, TemplateInput, approveTemplate, createTemplate, editTemplate, listTemplates, renderTemplate, retireTemplate } from "../services/noteTemplates.js";
import { recordAuditEvent } from "../services/securityAdmin.js";

export const TemplateInputSchema = TemplateInput;

async function audit(req: AuthorizedRequest, action: string, resource: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const s = req.securitySession!;
  await recordAuditEvent({ id: randomUUID(), timestampIso: new Date().toISOString(), userId: s.user.id, activeRole: s.activeRole, organization: s.user.organizationId ?? "", facility: "", department: "", action, module: "ClinicalContent", resource, ipAddress: "", device: "", success: true, risk: "medium", metadata: { change: buildAuditChange(before, after) } });
}

function fail(res: Response, error: unknown, next: (e?: unknown) => void) {
  if (error instanceof WorkError) return res.status(error.status).json({ error: error.message, code: error.code });
  return next(error);
}

/** Note templates (F-005): nurses use approved ones; clinicians write them and a second person approves. */
export function createNoteTemplatesRouter(): Router {
  const router = Router();
  const nurse = requirePermission("triage.workspace.view");
  const author = requirePermission("protocol.library.manage");
  const approver = requirePermission("clinical.governance.approve");

  router.get("/", nurse, async (req, res, next) => {
    try {
      return res.json({ placeholders: PLACEHOLDERS, templates: await listTemplates({ status: "approved", section: typeof req.query.section === "string" ? req.query.section : undefined, language: typeof req.query.language === "string" ? req.query.language : undefined }) });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.get("/all", author, async (_req, res, next) => {
    try {
      return res.json({ templates: await listTemplates() });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/", author, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = TemplateInputSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid template", details: parsed.error.flatten() });
      const t = await createTemplate(parsed.data, req.securitySession!.user.id);
      await audit(req, "NOTE_TEMPLATE_CREATED", `NoteTemplate:${t.id}`, null, { name: t.name, section: t.section, language: t.language });
      return res.status(201).json({ template: t });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.put("/:id", author, async (req: AuthorizedRequest, res, next) => {
    try {
      const parsed = TemplateInputSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid template", details: parsed.error.flatten() });
      const t = await editTemplate(String(req.params.id), parsed.data, req.securitySession!.user.id);
      await audit(req, "NOTE_TEMPLATE_EDITED", `NoteTemplate:${t.id}`, null, { version: t.version, status: t.status });
      return res.json({ template: t });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/:id/approve", approver, async (req: AuthorizedRequest, res, next) => {
    try {
      const t = await approveTemplate(String(req.params.id), req.securitySession!.user.id);
      await audit(req, "NOTE_TEMPLATE_APPROVED", `NoteTemplate:${t.id}`, { status: "draft" }, { status: "approved", version: t.version });
      return res.json({ template: t });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.delete("/:id", author, async (req: AuthorizedRequest, res, next) => {
    try {
      await retireTemplate(String(req.params.id));
      await audit(req, "NOTE_TEMPLATE_RETIRED", `NoteTemplate:${req.params.id}`, null, { status: "retired" });
      return res.json({ retired: true });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/:id/render", nurse, async (req, res, next) => {
    try {
      // contract: NoteTemplateRenderBodySchema
      const values = typeof req.body === "object" && req.body ? (req.body as Record<string, unknown>) : {};
      const clean: Record<string, string> = {};
      for (const key of PLACEHOLDERS) if (typeof values[key] === "string") clean[key] = String(values[key]).slice(0, 300);
      return res.json(await renderTemplate(String(req.params.id), clean));
    } catch (error) {
      return fail(res, error, next);
    }
  });

  return router;
}
