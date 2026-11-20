import { randomUUID } from "node:crypto";
import { z } from "zod";
import { shouldPersistPlatformInDatabase } from "../config/runtime.js";
import { prisma } from "../db.js";
import { getEmailAdapter } from "./communicationAdapters.js";
import { eventMatches, subscribe, type PlatformEvent } from "./eventBus.js";
import { enqueueForSubscription } from "./webhookRules.js";

/**
 * Event and alert rules (NFR-092). An administrator configures, in a screen and without a code change,
 * which events raise an alert, under what condition, and who is told how:
 *   event      an event type or audit action, with * as a wildcard ("queue.*", "FAILED_LOGIN", "*")
 *   condition  minimum risk, and optionally one field test (success, module, resource, userId, activeRole)
 *   channel    log (written as an alert line the SIEM collects), email, or webhook (a webhook subscription id)
 *   cooldown   seconds before the same rule may fire again, so a burst is one alert, not hundreds
 * Rules are stored as configuration (the database, or memory where there is none), and every change to
 * them is audited by the caller with before and after values.
 */

export const RULE_CHANNELS = ["log", "email", "webhook"] as const;
const RISKS = ["low", "medium", "high", "critical"] as const;
const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export const RuleInput = z.object({
  name: z.string().trim().min(2).max(120),
  enabled: z.boolean().default(true),
  eventPattern: z.string().trim().min(1).max(100),
  minRisk: z.enum(RISKS).optional(),
  condition: z
    .object({ field: z.enum(["success", "module", "resource", "userId", "activeRole"]), equals: z.union([z.string(), z.boolean()]).optional(), contains: z.string().max(100).optional() })
    .refine((c) => c.equals !== undefined || c.contains !== undefined, "Give equals or contains.")
    .optional(),
  channel: z.enum(RULE_CHANNELS),
  recipients: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  cooldownSeconds: z.number().int().min(0).max(86_400).default(300)
});
export type RuleInputType = z.infer<typeof RuleInput>;

export type StoredRule = RuleInputType & { id: string; createdBy: string; updatedBy: string; createdAtIso: string; updatedAtIso: string; lastFiredAtIso?: string };

export class RuleError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
    this.name = "RuleError";
  }
}

export function validateRule(input: RuleInputType): void {
  if (input.channel === "email" && !input.recipients.every((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r))) throw new RuleError(400, "Email rules need email addresses as recipients.", "RULE_RECIPIENTS_INVALID");
}

// ---- storage -------------------------------------------------------------------------------------

const memory = new Map<string, StoredRule>();
export function resetRulesForTests(): void {
  memory.clear();
  cache = undefined;
  lastFired.clear();
}
let cache: { at: number; rules: StoredRule[] } | undefined;
const lastFired = new Map<string, number>();

type Row = Awaited<ReturnType<typeof prisma.eventRule.findFirstOrThrow>>;
const fromRow = (row: Row): StoredRule => ({
  id: row.id, name: row.name, enabled: row.enabled, eventPattern: row.eventPattern, minRisk: (row.minRisk as StoredRule["minRisk"]) ?? undefined,
  condition: (row.condition as StoredRule["condition"]) ?? undefined, channel: row.channel as StoredRule["channel"], recipients: row.recipients as string[], cooldownSeconds: row.cooldownSeconds,
  createdBy: row.createdBy, updatedBy: row.updatedBy, createdAtIso: row.createdAt.toISOString(), updatedAtIso: row.updatedAt.toISOString(), lastFiredAtIso: row.lastFiredAt?.toISOString()
});

export async function listRules(): Promise<StoredRule[]> {
  if (!shouldPersistPlatformInDatabase()) return [...memory.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (await prisma.eventRule.findMany({ orderBy: { name: "asc" } })).map(fromRow);
}
export async function getRule(id: string): Promise<StoredRule | undefined> {
  if (!shouldPersistPlatformInDatabase()) return memory.get(id);
  const row = await prisma.eventRule.findUnique({ where: { id } });
  return row ? fromRow(row) : undefined;
}
export async function createRule(input: RuleInputType, actor: string): Promise<StoredRule> {
  validateRule(input);
  cache = undefined;
  if (!shouldPersistPlatformInDatabase()) {
    const now = new Date().toISOString();
    const rule: StoredRule = { ...input, id: `rule-${randomUUID()}`, createdBy: actor, updatedBy: actor, createdAtIso: now, updatedAtIso: now };
    memory.set(rule.id, rule);
    return rule;
  }
  return fromRow(await prisma.eventRule.create({ data: { name: input.name, enabled: input.enabled, eventPattern: input.eventPattern, minRisk: input.minRisk, condition: input.condition as never, channel: input.channel, recipients: input.recipients, cooldownSeconds: input.cooldownSeconds, createdBy: actor, updatedBy: actor } }));
}
export async function updateRule(id: string, input: RuleInputType, actor: string): Promise<StoredRule> {
  validateRule(input);
  cache = undefined;
  if (!(await getRule(id))) throw new RuleError(404, "Rule not found.", "RULE_NOT_FOUND");
  if (!shouldPersistPlatformInDatabase()) {
    const current = memory.get(id)!;
    const next: StoredRule = { ...current, ...input, updatedBy: actor, updatedAtIso: new Date().toISOString() };
    memory.set(id, next);
    return next;
  }
  return fromRow(await prisma.eventRule.update({ where: { id }, data: { name: input.name, enabled: input.enabled, eventPattern: input.eventPattern, minRisk: input.minRisk ?? null, condition: (input.condition ?? null) as never, channel: input.channel, recipients: input.recipients, cooldownSeconds: input.cooldownSeconds, updatedBy: actor } }));
}
export async function deleteRule(id: string): Promise<void> {
  cache = undefined;
  if (!(await getRule(id))) throw new RuleError(404, "Rule not found.", "RULE_NOT_FOUND");
  if (!shouldPersistPlatformInDatabase()) memory.delete(id);
  else await prisma.eventRule.delete({ where: { id } });
}

async function activeRules(): Promise<StoredRule[]> {
  if (cache && Date.now() - cache.at < 10_000) return cache.rules;
  const rules = (await listRules()).filter((r) => r.enabled);
  cache = { at: Date.now(), rules };
  return rules;
}

// ---- evaluation ----------------------------------------------------------------------------------

export function ruleMatches(rule: StoredRule, event: PlatformEvent): boolean {
  if (!eventMatches(rule.eventPattern, event.type, String(event.data.action ?? ""))) return false;
  if (rule.minRisk && RISK_ORDER[event.risk] < RISK_ORDER[rule.minRisk]) return false;
  if (rule.condition) {
    const value = rule.condition.field === "success" ? event.success : event.data[rule.condition.field];
    if (rule.condition.equals !== undefined && value !== rule.condition.equals) return false;
    if (rule.condition.contains !== undefined && !String(value ?? "").toLowerCase().includes(rule.condition.contains.toLowerCase())) return false;
  }
  return true;
}

export type FiredAlert = { ruleId: string; ruleName: string; channel: string; recipients: string[]; eventId: string; eventType: string };
const alertListeners: Array<(alert: FiredAlert) => void> = [];
export function onAlertForTests(fn: (alert: FiredAlert) => void): () => void {
  alertListeners.push(fn);
  return () => void alertListeners.splice(alertListeners.indexOf(fn), 1);
}

export async function evaluateRules(event: PlatformEvent): Promise<FiredAlert[]> {
  const fired: FiredAlert[] = [];
  for (const rule of await activeRules()) {
    if (!ruleMatches(rule, event)) continue;
    const last = lastFired.get(rule.id) ?? 0;
    if (Date.now() - last < rule.cooldownSeconds * 1000) continue;
    lastFired.set(rule.id, Date.now());
    const alert: FiredAlert = { ruleId: rule.id, ruleName: rule.name, channel: rule.channel, recipients: rule.recipients, eventId: event.id, eventType: event.type };
    await notify(rule, event);
    fired.push(alert);
    alertListeners.forEach((fn) => fn(alert));
    if (shouldPersistPlatformInDatabase()) void prisma.eventRule.update({ where: { id: rule.id }, data: { lastFiredAt: new Date() } }).catch(() => undefined);
  }
  return fired;
}

async function notify(rule: StoredRule, event: PlatformEvent): Promise<void> {
  const summary = `${rule.name}: ${event.type} (${event.risk}) on ${event.subject ?? "unknown"} by ${String(event.data.userId ?? "unknown")}`;
  if (rule.channel === "log") {
    console.warn(JSON.stringify({ type: "alert", rule: rule.name, ruleId: rule.id, eventType: event.type, eventId: event.id, risk: event.risk, subject: event.subject, summary }));
  } else if (rule.channel === "email") {
    const adapter = getEmailAdapter();
    for (const to of rule.recipients) {
      await adapter.send({ to, subject: `[AiMlTriage alert] ${rule.name}`, body: `${summary}\n\nEvent id: ${event.id}\nTime: ${event.occurredAtIso}\nThis message holds no patient data.` });
    }
  } else {
    for (const subscriptionId of rule.recipients) await enqueueForSubscription(subscriptionId, event, rule.name);
  }
}

export function registerRuleSubscriber(): void {
  subscribe({ name: "event-rules", handle: async (event) => void (await evaluateRules(event)) });
}
