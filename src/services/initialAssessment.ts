import { z } from "zod";
import { createItem, listItems, updateItem, type WorkItem } from "./clinicalWork.js";

/**
 * The Initial Assessment (emergency rule-out) that opens every call (F-008). It is required by default; an
 * administrator can change that, with the change audited by the caller. Red-flag phrase detection reads the
 * caller's own words and warns the nurse: it never lowers or sets a disposition.
 */

export const InitialAssessmentPolicy = z.object({ required: z.boolean(), reason: z.string().trim().min(5).max(500).optional() });

const KEY = "initial_assessment_policy";
let cached: { at: number; required: boolean } | undefined;
export function resetInitialAssessmentPolicyForTests(): void {
  cached = undefined;
}

function envDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INITIAL_ASSESSMENT_REQUIRED !== "false";
}

async function stored(): Promise<WorkItem | undefined> {
  return (await listItems({ kind: "setting", caseRef: KEY, limit: 1 }))[0];
}

export async function initialAssessmentRequired(now = Date.now()): Promise<boolean> {
  if (cached && now - cached.at < 5000) return cached.required;
  let required = envDefault();
  try {
    const item = await stored();
    if (item) required = Boolean(item.payload.required);
  } catch {
    // The setting store being unavailable must not open the gate: fall back to the safe default.
  }
  cached = { at: now, required };
  return required;
}

export async function setInitialAssessmentPolicy(input: z.infer<typeof InitialAssessmentPolicy>, userId: string): Promise<{ before: boolean; after: boolean }> {
  const before = await initialAssessmentRequired(0);
  const current = await stored();
  const payload = { required: input.required, reason: input.reason ?? null, changedBy: userId, changedAtIso: new Date().toISOString() };
  if (current) await updateItem(current.id, { payload });
  else await createItem({ kind: "setting", status: "active", caseRef: KEY, createdBy: userId, payload });
  cached = { at: Date.now(), required: input.required };
  return { before, after: input.required };
}

// ---- red-flag phrases ---------------------------------------------------------------------------------

const RED_FLAGS: Array<{ id: string; label: string; patterns: RegExp[] }> = [
  { id: "chest_pain", label: "Chest pain or pressure", patterns: [/chest (pain|pressure|tightness)/i, /pain in (my |the )?chest/i, /ألم (في )?الصدر/, /ضيق (في )?الصدر/] },
  { id: "breathing", label: "Severe difficulty breathing", patterns: [/(can'?t|cannot|unable to) breathe/i, /(severe|extreme) (shortness of breath|difficulty breathing)/i, /gasping/i, /لا أستطيع التنفس/, /صعوبة (شديدة )?في التنفس/] },
  { id: "unconscious", label: "Unconscious or unresponsive", patterns: [/unconscious/i, /unresponsive/i, /passed out/i, /collapsed/i, /فاقد (الوعي)?/, /أغمي عليه/] },
  { id: "bleeding", label: "Severe bleeding", patterns: [/(severe|heavy|uncontrolled|won'?t stop) bleeding/i, /bleeding (heavily|badly|won'?t stop)/i, /نزيف (شديد|حاد)/] },
  { id: "stroke", label: "Stroke signs", patterns: [/face (is )?drooping/i, /slurred speech/i, /sudden (weakness|numbness) (on|in) (one|the) (side|arm|leg)/i, /تدلي الوجه/, /ثقل (في )?الكلام/] },
  { id: "seizure", label: "Seizure", patterns: [/seizure/i, /convuls/i, /fitting/i, /نوبة (صرع|تشنج)/, /تشنجات/] },
  { id: "self_harm", label: "Thoughts of self-harm", patterns: [/(kill|hurt|harm) (myself|himself|herself)/i, /suicid/i, /want(s)? to die/i, /انتحار/, /يؤذي نفسه/] },
  { id: "anaphylaxis", label: "Severe allergic reaction", patterns: [/anaphyla/i, /(throat|tongue|face) (is )?swelling/i, /تورم (الحلق|اللسان)/] },
  { id: "pregnancy_emergency", label: "Pregnancy emergency", patterns: [/(pregnant).*(bleeding|severe pain)/i, /(bleeding|severe pain).*(pregnant)/i, /no fetal movement/i, /لا (توجد|يوجد) حركة (للجنين)?/] }
];

export type RedFlagMatch = { id: string; label: string; matched: string };

export function detectRedFlags(text: string, extraKeywords: string[] = []): RedFlagMatch[] {
  const found: RedFlagMatch[] = [];
  const input = text.slice(0, 5000);
  for (const flag of RED_FLAGS) {
    for (const pattern of flag.patterns) {
      const hit = pattern.exec(input);
      if (hit) {
        found.push({ id: flag.id, label: flag.label, matched: hit[0] });
        break;
      }
    }
  }
  const lower = input.toLowerCase();
  for (const keyword of extraKeywords) {
    if (keyword && lower.includes(keyword.toLowerCase()) && !found.some((f) => f.matched.toLowerCase() === keyword.toLowerCase())) found.push({ id: "protocol_keyword", label: "Protocol emergency keyword", matched: keyword });
  }
  return found;
}
