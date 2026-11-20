import { z } from "zod";
import { WorkError, createItem, listItems, updateItem, type WorkItem } from "./clinicalWork.js";
import { getClinicalProtocolById } from "./clinicalContent.js";

/**
 * Adaptive question layer (F-007). A branch rule says: in this protocol, when question A is answered yes (or no),
 * ask question B next. Rules are drafted by one person and signed off by another; only signed-off rules are used,
 * and every question the engine chooses carries the reasoning, so the nurse sees why. With no matching rule the
 * protocol's own order applies, so the layer can only reorder questions, never remove one or change a disposition.
 */

export const BranchRuleInput = z.object({
  fromQuestionId: z.string().min(1).max(120),
  answer: z.enum(["yes", "no"]),
  nextQuestionId: z.string().min(1).max(120),
  reasoning: z.string().trim().min(10).max(500)
});

export type BranchRule = { id: string; protocolId: string; fromQuestionId: string; answer: "yes" | "no"; nextQuestionId: string; reasoning: string; status: "draft" | "signed_off"; draftedBy: string; signedOffBy?: string; signedOffAtIso?: string };

const toRule = (item: WorkItem): BranchRule => ({ id: item.id, protocolId: String(item.payload.protocolId), fromQuestionId: String(item.payload.fromQuestionId), answer: item.payload.answer as "yes" | "no", nextQuestionId: String(item.payload.nextQuestionId), reasoning: String(item.payload.reasoning), status: item.status === "signed_off" ? "signed_off" : "draft", draftedBy: item.createdBy, signedOffBy: item.payload.signedOffBy as string | undefined, signedOffAtIso: item.payload.signedOffAtIso as string | undefined });

export async function listRules(protocolId: string): Promise<BranchRule[]> {
  const items = await listItems({ kind: "branch_rule", caseRef: protocolId, limit: 500 });
  return items.filter((i) => i.status !== "retired").map(toRule);
}

export async function draftRule(protocolId: string, input: z.infer<typeof BranchRuleInput>, userId: string): Promise<BranchRule> {
  const protocol = getClinicalProtocolById(protocolId);
  if (!protocol) throw new WorkError(404, "Protocol not found.", "PROTOCOL_NOT_FOUND");
  const ids = new Set(protocol.questions.map((q) => q.id));
  if (!ids.has(input.fromQuestionId) || !ids.has(input.nextQuestionId)) throw new WorkError(400, "Both questions must belong to the protocol.", "BRANCH_QUESTION_UNKNOWN");
  if (input.fromQuestionId === input.nextQuestionId) throw new WorkError(400, "A question cannot branch to itself.", "BRANCH_SELF");
  const existing = (await listRules(protocolId)).find((r) => r.fromQuestionId === input.fromQuestionId && r.answer === input.answer);
  if (existing) throw new WorkError(409, "A rule already exists for that question and answer.", "BRANCH_DUPLICATE");
  const item = await createItem({ kind: "branch_rule", status: "draft", caseRef: protocolId, createdBy: userId, payload: { protocolId, ...input } });
  return toRule(item);
}

export async function signOffRule(ruleId: string, userId: string): Promise<BranchRule> {
  const all = await listItems({ kind: "branch_rule", limit: 1000 });
  const item = all.find((i) => i.id === ruleId);
  if (!item) throw new WorkError(404, "Rule not found.", "BRANCH_NOT_FOUND");
  if (item.status === "signed_off") throw new WorkError(409, "The rule is already signed off.", "BRANCH_STATE");
  if (item.createdBy === userId) throw new WorkError(403, "A rule is signed off by someone other than its author.", "BRANCH_SELF_SIGNOFF");
  return toRule(await updateItem(ruleId, { status: "signed_off", assignee: userId, payload: { signedOffBy: userId, signedOffAtIso: new Date().toISOString() } }));
}

export async function retireRule(ruleId: string): Promise<void> {
  const item = (await listItems({ kind: "branch_rule", limit: 1000 })).find((i) => i.id === ruleId);
  if (!item) throw new WorkError(404, "Rule not found.", "BRANCH_NOT_FOUND");
  await updateItem(ruleId, { status: "retired" });
}

export type NextQuestion = { done: boolean; question?: { id: string; text: string; severity: string; redFlag: boolean }; reasoning: string; viaRuleId?: string };

/** `answers` is in the order the questions were answered; the last one is what the next question follows. */
export async function nextQuestion(protocolId: string, answers: Array<{ questionId: string; answer: "yes" | "no" }>): Promise<NextQuestion> {
  const protocol = getClinicalProtocolById(protocolId);
  if (!protocol) throw new WorkError(404, "Protocol not found.", "PROTOCOL_NOT_FOUND");
  const ordered = [...protocol.questions].sort((a, b) => a.acuityOrder - b.acuityOrder);
  const answered = new Set(answers.map((a) => a.questionId));
  const pick = (id: string) => {
    const q = ordered.find((candidate) => candidate.id === id);
    return q && !answered.has(q.id) ? { id: q.id, text: q.questionTextEn, severity: q.severity, redFlag: q.redFlag } : undefined;
  };
  const last = answers[answers.length - 1];
  if (last) {
    const rule = (await listRules(protocolId)).find((r) => r.status === "signed_off" && r.fromQuestionId === last.questionId && r.answer === last.answer);
    const branch = rule && pick(rule.nextQuestionId);
    if (rule && branch) return { done: false, question: branch, reasoning: `${rule.reasoning} (signed-off branch: "${last.questionId}" answered ${last.answer})`, viaRuleId: rule.id };
  }
  const next = ordered.find((q) => !answered.has(q.id));
  if (!next) return { done: true, reasoning: "Every question in the protocol has been asked." };
  return { done: false, question: { id: next.id, text: next.questionTextEn, severity: next.severity, redFlag: next.redFlag }, reasoning: "The protocol's own order: most urgent question not yet asked." };
}
