import { z } from "zod";
import { WorkError, createItem, getItem, listItems, updateItem, type WorkItem } from "./clinicalWork.js";

/**
 * Clinician-editable note templates (F-005). Wording that nurses reuse in the Plan, Assessment or advice sections
 * is written by clinicians, signed off by a second person, and then offered to nurses. A template is text with
 * {{placeholders}} filled from the case; it is a convenience for writing the note, not generated content.
 */

export const SECTIONS = ["subjective", "objective", "assessment", "plan", "advice"] as const;
export const PLACEHOLDERS = ["patient", "age", "destination", "complaint", "nurse", "disposition"] as const;

export const TemplateInput = z.object({
  name: z.string().trim().min(3).max(120),
  section: z.enum(SECTIONS),
  language: z.enum(["en", "ar"]).default("en"),
  body: z.string().trim().min(5).max(2000)
}).superRefine((value, ctx) => {
  for (const match of value.body.matchAll(/\{\{\s*([a-z]+)\s*\}\}/g)) {
    if (!(PLACEHOLDERS as readonly string[]).includes(match[1])) ctx.addIssue({ code: "custom", message: `Unknown placeholder {{${match[1]}}}. Allowed: ${PLACEHOLDERS.join(", ")}.`, path: ["body"] });
  }
});

export type NoteTemplate = { id: string; name: string; section: string; language: string; body: string; status: "draft" | "approved" | "retired"; version: number; authoredBy: string; approvedBy?: string };

const view = (item: WorkItem): NoteTemplate => ({ id: item.id, name: String(item.payload.name), section: String(item.payload.section), language: String(item.payload.language), body: String(item.payload.body), status: item.status as NoteTemplate["status"], version: Number(item.payload.version ?? 1), authoredBy: item.createdBy, approvedBy: item.payload.approvedBy as string | undefined });

export async function listTemplates(filter: { status?: string; section?: string; language?: string } = {}): Promise<NoteTemplate[]> {
  const items = await listItems({ kind: "note_template", status: filter.status, limit: 500 });
  return items.map(view).filter((t) => t.status !== "retired" && (!filter.section || t.section === filter.section) && (!filter.language || t.language === filter.language));
}

export async function createTemplate(input: z.infer<typeof TemplateInput>, userId: string): Promise<NoteTemplate> {
  return view(await createItem({ kind: "note_template", status: "draft", createdBy: userId, payload: { ...input, version: 1 } }));
}

/** Editing an approved template returns it to draft: the new wording needs its own sign-off. */
export async function editTemplate(id: string, input: z.infer<typeof TemplateInput>, userId: string): Promise<NoteTemplate> {
  const item = await getItem(id, "note_template");
  if (!item) throw new WorkError(404, "Template not found.", "TEMPLATE_NOT_FOUND");
  return view(await updateItem(id, { status: "draft", assignee: null, payload: { ...input, version: Number(item.payload.version ?? 1) + 1, approvedBy: null, lastEditedBy: userId } }));
}

export async function approveTemplate(id: string, userId: string): Promise<NoteTemplate> {
  const item = await getItem(id, "note_template");
  if (!item) throw new WorkError(404, "Template not found.", "TEMPLATE_NOT_FOUND");
  if (item.status === "approved") throw new WorkError(409, "Already approved.", "TEMPLATE_STATE");
  const lastEditor = (item.payload.lastEditedBy as string | undefined) ?? item.createdBy;
  if (lastEditor === userId) throw new WorkError(403, "A template is approved by someone other than the person who last wrote it.", "TEMPLATE_SELF_APPROVAL");
  return view(await updateItem(id, { status: "approved", assignee: userId, payload: { approvedBy: userId, approvedAtIso: new Date().toISOString() } }));
}

export async function retireTemplate(id: string): Promise<void> {
  if (!(await getItem(id, "note_template"))) throw new WorkError(404, "Template not found.", "TEMPLATE_NOT_FOUND");
  await updateItem(id, { status: "retired" });
}

export async function renderTemplate(id: string, values: Partial<Record<(typeof PLACEHOLDERS)[number], string>>): Promise<{ text: string; missing: string[] }> {
  const item = await getItem(id, "note_template");
  if (!item || item.status !== "approved") throw new WorkError(404, "Template not found.", "TEMPLATE_NOT_FOUND");
  const missing: string[] = [];
  const text = String(item.payload.body).replace(/\{\{\s*([a-z]+)\s*\}\}/g, (_m, key: string) => {
    const value = values[key as (typeof PLACEHOLDERS)[number]];
    if (!value) missing.push(key);
    return value ?? `[${key}]`;
  });
  return { text, missing };
}
