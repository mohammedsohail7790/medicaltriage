import { shouldPersistPlatformInDatabase } from "../config/runtime.js";
import { basePrisma } from "../db.js";
import { getCurrentClinicalContentPackage, searchClinicalProtocols } from "./clinicalContent.js";
import { renderReferralPdf } from "./referralLetter.js";
import { compileBilingualSoapSbarMarkdown } from "./triageNoteCompiler.js";
import { TriageCompleteRequestSchema } from "../types/triage.js";

/**
 * Synthetic transactions (NFR-106): the critical flows run end to end with invented data and no patient, so a
 * fault is found before a nurse meets it. Each check is timed and passes or fails on its own.
 */

export type SyntheticResult = { name: string; ok: boolean; ms: number; detail?: string };

const CHECKS: Array<{ name: string; run: () => Promise<string | void> }> = [
  {
    name: "clinical content loads and answers a search",
    run: async () => {
      const release = getCurrentClinicalContentPackage().release.version;
      const hits = searchClinicalProtocols({ q: "fever", mode: "both", limit: 3 });
      if (hits.length === 0) throw new Error("A search for a common complaint returned nothing.");
      return `release ${release}, ${hits.length} result(s)`;
    }
  },
  {
    name: "bilingual note compiles",
    run: async () => {
      const note = compileBilingualSoapSbarMarkdown(TriageCompleteRequestSchema.parse({ chief_complaint: "Synthetic check", final_disposition_code: "HMC_URGENT_CARE", routing_destination: "Synthetic destination", nurse_id: "synthetic" }));
      if (!note.includes("SBAR") || !/[؀-ۿ]/.test(note)) throw new Error("The note is missing a section or the Arabic text.");
    }
  },
  {
    name: "referral letter renders as a PDF",
    run: async () => {
      const pdf = await renderReferralPdf({ destinationName: "Synthetic clinic", reason: "Synthetic", assessment: "تقييم تجريبي", recommendation: "Synthetic", nurseName: "Synthetic", issuedAtIso: new Date().toISOString(), reference: "SYN-1" }, { approved: false });
      if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("The letter is not a PDF.");
    }
  },
  {
    name: "database answers",
    run: async () => {
      if (!shouldPersistPlatformInDatabase()) return "skipped: no database in this mode";
      await basePrisma.$queryRaw`SELECT 1`;
    }
  }
];

export async function runSyntheticChecks(extra: Array<{ name: string; run: () => Promise<string | void> }> = []): Promise<{ ok: boolean; results: SyntheticResult[] }> {
  const results: SyntheticResult[] = [];
  for (const check of [...CHECKS, ...extra]) {
    const started = Date.now();
    try {
      const detail = await check.run();
      results.push({ name: check.name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) });
    } catch (error) {
      results.push({ name: check.name, ok: false, ms: Date.now() - started, detail: error instanceof Error ? error.message.slice(0, 200) : "failed" });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}
