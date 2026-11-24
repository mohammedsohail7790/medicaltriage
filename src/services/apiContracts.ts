import { z } from "zod";

/**
 * NFR-164: request contracts for handlers that check their body themselves. Where a handler used an inline
 * z.object, it now parses with the schema below (same rules). Where a handler reads fields directly
 * (marked `// contract: <Name>` above its body use), the schema documents exactly the fields it reads; tests
 * send each sample to the real route so a change to the handler's reading shows up as a failure here.
 * Exported names end in Schema so the OpenAPI generator picks them up.
 */

export const ElevateBodySchema = z.object({ code: z.string().min(1) });
export const RevealDecisionBodySchema = z.object({ decision: z.enum(["approved", "denied"]), comments: z.string().max(500).optional() });
export const PasswordChangeBodySchema = z.object({ username: z.string().min(3).max(180).optional(), currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) });
export const WebhookChangeBodySchema = z.object({ status: z.enum(["active", "paused"]).optional(), url: z.string().optional(), events: z.array(z.string().max(100)).min(1).max(50).optional() });
export const EventRuleTestBodySchema = z.object({ type: z.string().min(1).max(100), risk: z.enum(["low", "medium", "high", "critical"]).default("medium") });

// Handlers that read named fields from the body.
export const ExportRequestBodySchema = z.object({ reason: z.string().min(1) });
export const ExportDecisionBodySchema = z.object({ decision: z.enum(["approve", "reject"]), comments: z.string().max(500).optional() });
export const ExtractAckBodySchema = z.object({ consumer: z.string().min(1).max(80), token: z.string().min(1) });
export const IntegrityRunBodySchema = z.object({ only: z.string().optional().describe("Comma-separated check names; all checks when omitted."), repair: z.boolean().optional().describe("Repair what can be repaired (default true).") });
export const MfaEnrollBodySchema = z.object({ enrollmentToken: z.string().optional() });
export const OauthTokenBodySchema = z.object({ grant_type: z.literal("client_credentials"), client_id: z.string().optional(), client_secret: z.string().optional() }).describe("Also accepted as application/x-www-form-urlencoded; the client may instead send HTTP Basic credentials.");
export const BusinessRuleChangeBodySchema = z.object({ value: z.unknown(), reason: z.string().optional() });
export const ReasonAudioBodySchema = z.object({ audioReference: z.string().optional(), simulatedTranscriptText: z.string().optional() });
export const RedFlagsBodySchema = z.object({ text: z.string(), emergencyKeywords: z.array(z.string()).optional() });
export const NoteTemplateRenderBodySchema = z.record(z.unknown()).describe("Values for the template's fields, by field name.");

export const RetentionPolicyBodySchema = z.object({
  days: z.number().int().min(1).max(36500),
  deletionMode: z.enum(["archive_then_delete", "hard_delete"]).default("archive_then_delete"),
  legalBasis: z.string().trim().min(5).max(500),
  decisionReference: z.string().trim().min(3).max(120),
  status: z.enum(["active", "draft"]).default("draft"),
  schedule: z.string().trim().max(120).optional()
});
