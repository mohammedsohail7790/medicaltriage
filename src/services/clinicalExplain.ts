import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getClinicalProtocolById, getCurrentClinicalContentPackage, searchClinicalProtocols } from "./clinicalContent.js";
import type { ClinicalContentProtocol } from "../types/clinicalContent.js";

/**
 * Why a protocol was suggested and where its content comes from (F-006, F-009, F-022, AI-023).
 * Everything here is derived from the protocol content and the search that produced the candidate; nothing is
 * generated. International guideline mappings (WHO, NICE, CDC) are shown only once the clinical team has
 * confirmed them: an entry without a confirmer and date in data/clinical/guidelineMappings.json is ignored.
 */

export const GuidelineMapping = z.object({
  protocolId: z.string().min(1),
  body: z.enum(["WHO", "NICE", "CDC", "OTHER"]),
  reference: z.string().min(3).max(500),
  url: z.string().url().max(2000).optional(),
  confirmedBy: z.string().min(2).max(200),
  confirmedAtIso: z.string().datetime()
});
export type GuidelineMappingType = z.infer<typeof GuidelineMapping>;

export function loadGuidelineMappings(file = path.resolve(process.cwd(), "data", "clinical", "guidelineMappings.json")): GuidelineMappingType[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown[];
    return raw.flatMap((entry) => {
      const parsed = GuidelineMapping.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

export type SourceInfo = {
  protocolId: string;
  title: string;
  release: { name: string; version: string; sourceType: string };
  contentStatus: { clinicalStatus: string | null; usageStatus: string | null; productionEligible: boolean | null; notice: string | null };
  review: { author: string | null; expertReviewer: string | null; lastRevisedIso: string | null; lastReviewedIso: string | null };
  references: Array<{ id: string; title: string; sourceName: string | null; citation: string | null; url: string | null; type: string }>;
  guidelineMappings: GuidelineMappingType[];
  guidelineMappingNote: string;
};

export function sourceInfo(protocol: ClinicalContentProtocol, mappings = loadGuidelineMappings()): SourceInfo {
  const release = getCurrentClinicalContentPackage().release;
  const mine = mappings.filter((m) => m.protocolId === protocol.id);
  return {
    protocolId: protocol.id,
    title: protocol.titleEn,
    release: { name: release.name, version: release.version, sourceType: release.sourceType },
    contentStatus: {
      clinicalStatus: protocol.provenance?.clinicalStatus ?? null,
      usageStatus: protocol.provenance?.usageStatus ?? null,
      productionEligible: protocol.provenance?.productionEligible ?? null,
      notice: protocol.provenance?.contentNotice ?? null
    },
    review: {
      author: protocol.authorship?.authorEn ?? null, expertReviewer: protocol.authorship?.expertReviewerEn ?? null,
      lastRevisedIso: protocol.authorship?.lastRevisedIso ?? null, lastReviewedIso: protocol.authorship?.lastReviewedIso ?? null
    },
    references: [...protocol.references].sort((a, b) => a.displayOrder - b.displayOrder).map((r) => ({ id: r.id, title: r.title, sourceName: r.sourceName ?? null, citation: r.citationText ?? null, url: r.url ?? null, type: r.referenceType })),
    guidelineMappings: mine,
    guidelineMappingNote: mine.length ? "Mappings confirmed by the clinical team." : "No WHO, NICE or CDC mapping has been confirmed for this protocol yet; none is shown."
  };
}

export type Explanation = {
  protocolId: string;
  title: string;
  score: number | null;
  reasons: Array<{ kind: "matched_term" | "definition" | "patient_fit" | "urgency" | "triggering_question"; text: string; detail?: Record<string, unknown> }>;
  triggeringQuestions: Array<{ id: string; text: string; severity: string; dispositionCode: string; redFlag: boolean; rationale: string }>;
  source: SourceInfo;
  basis: string;
};

/** Reasons for one candidate, from the search that ranked it and (optionally) the questions answered yes. */
export function explainCandidate(protocolId: string, input: { q?: string; ageYears?: number; positiveQuestionIds?: string[] }): Explanation | undefined {
  const protocol = getClinicalProtocolById(protocolId);
  if (!protocol) return undefined;
  const hit = input.q ? searchClinicalProtocols({ q: input.q, ageYears: input.ageYears, mode: "both", limit: 20 }).find((r) => r.id === protocolId) : undefined;
  const reasons: Explanation["reasons"] = [];
  for (const term of hit?.matchedTerms ?? []) reasons.push({ kind: "matched_term", text: `The caller's words include "${term}", which this protocol lists.`, detail: { term } });
  if (protocol.clinicalDefinitionEn) reasons.push({ kind: "definition", text: protocol.clinicalDefinitionEn.slice(0, 280) });
  if (input.ageYears !== undefined) {
    const fits = (protocol.ageMin === undefined || input.ageYears >= protocol.ageMin) && (protocol.ageMax === undefined || input.ageYears <= protocol.ageMax);
    reasons.push({ kind: "patient_fit", text: fits ? `Patient age ${input.ageYears} is within this protocol's range.` : `Patient age ${input.ageYears} is outside this protocol's range (${protocol.ageMin ?? 0} to ${protocol.ageMax ?? "any"}).`, detail: { fits } });
  }
  if (protocol.acuity !== undefined) reasons.push({ kind: "urgency", text: `Protocol urgency level ${protocol.acuity} of 5 (1 is most urgent).`, detail: { acuity: protocol.acuity } });
  const triggering = (input.positiveQuestionIds ?? []).flatMap((id) => {
    const q = protocol.questions.find((candidate) => candidate.id === id);
    return q ? [{ id: q.id, text: q.questionTextEn, severity: q.severity, dispositionCode: q.dispositionCode, redFlag: q.redFlag, rationale: q.rationaleEn }] : [];
  });
  for (const q of triggering) reasons.push({ kind: "triggering_question", text: `Answered yes to: ${q.text}`, detail: { questionId: q.id, redFlag: q.redFlag } });
  return {
    protocolId, title: protocol.titleEn, score: hit?.score ?? null, reasons, triggeringQuestions: triggering, source: sourceInfo(protocol),
    basis: "Derived from the protocol content and the search that ranked it. No model generated this explanation; the rules engine alone decides the disposition."
  };
}

export type PossibleConditions = { enabled: boolean; message: string; protocolId?: string; conditions?: Array<{ name: string; basis: string }>; disclaimer?: string };

export function symptomCheckerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SYMPTOM_CHECKER_ENABLED === "true";
}

/**
 * A possible-conditions view built only from the protocol's own content (title variants, synonyms and index entries).
 * Off until Qatar Airways' clinical and regulatory review of how it is presented (SYMPTOM_CHECKER_ENABLED=true).
 */
export function possibleConditions(protocolId: string, env: NodeJS.ProcessEnv = process.env): PossibleConditions {
  if (!symptomCheckerEnabled(env)) return { enabled: false, message: "The possible-conditions view is switched off until its presentation has been reviewed and approved clinically and by the regulator." };
  const protocol = getClinicalProtocolById(protocolId);
  if (!protocol) return { enabled: true, message: "Protocol not found." };
  const seen = new Set<string>();
  const conditions: Array<{ name: string; basis: string }> = [];
  const add = (name: string, basis: string) => {
    const key = name.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      conditions.push({ name: name.trim(), basis });
    }
  };
  add(protocol.titleEn, "Protocol title");
  for (const variant of protocol.titleVariants) add(variant, "Alternative title in the protocol");
  for (const t of protocol.taxonomy.filter((x) => /condition|diagnos|problem|disease/i.test(x.category))) add(t.value, `Protocol index (${t.category})`);
  return { enabled: true, message: "Conditions listed in the protocol content.", protocolId, conditions: conditions.slice(0, 12), disclaimer: "These are topics covered by the protocol, not a diagnosis. The nurse decides." };
}
