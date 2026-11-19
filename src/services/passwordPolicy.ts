import { z } from "zod";
import { shouldPersistSessionsInDatabase } from "../config/runtime.js";
import { prisma } from "../db.js";

/**
 * Administrator-configurable password policy for local accounts (NFR-016):
 * length, complexity, history, expiry and lockout. Users who sign in through single
 * sign-on follow the identity provider's policy instead.
 */

export const PasswordPolicySchema = z.object({
  minLength: z.number().int().min(8).max(128),
  requireUppercase: z.boolean(),
  requireLowercase: z.boolean(),
  requireDigit: z.boolean(),
  requireSymbol: z.boolean(),
  /** Number of previous passwords that cannot be reused. 0 turns the check off. */
  historyCount: z.number().int().min(0).max(24),
  /** Days before a password must be changed. 0 means it never expires. */
  maxAgeDays: z.number().int().min(0).max(730),
  /** Failed sign-ins before the account is locked. */
  lockoutThreshold: z.number().int().min(3).max(20),
  /** Minutes an account stays locked. */
  lockoutDurationMinutes: z.number().int().min(1).max(1440),
  /** A temporary password issued by an administrator must be changed at first sign-in. */
  forceChangeOnFirstLogin: z.boolean()
});

export type PasswordPolicy = z.infer<typeof PasswordPolicySchema>;

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  requireSymbol: true,
  historyCount: 5,
  // Expiry and forced first-sign-in change are off by default so the capability can be switched
  // on per deployment without changing how existing accounts sign in; set them under
  // PUT /admin/password-policy (recommended: forceChangeOnFirstLogin true).
  maxAgeDays: 0,
  lockoutThreshold: 5,
  lockoutDurationMinutes: 15,
  forceChangeOnFirstLogin: false
};

const POLICY_ID = "default";
const REFRESH_MS = 30_000;
let current: PasswordPolicy = { ...DEFAULT_PASSWORD_POLICY };
let loadedAt = 0;

/** The policy in force right now, from the cache. Never blocks sign-in. */
export function currentPasswordPolicy(): PasswordPolicy {
  return current;
}

/** Reads the stored policy (shared across instances) at most every 30 seconds. */
export async function refreshPasswordPolicy(force = false): Promise<PasswordPolicy> {
  if (!force && Date.now() - loadedAt < REFRESH_MS) return current;
  loadedAt = Date.now();
  if (!shouldPersistSessionsInDatabase()) return current;
  try {
    const row = await prisma.passwordPolicy.findUnique({ where: { id: POLICY_ID } });
    if (row) {
      const parsed = PasswordPolicySchema.safeParse({ ...DEFAULT_PASSWORD_POLICY, ...(row.policy as object) });
      if (parsed.success) current = parsed.data;
    }
  } catch (error) {
    console.error("Could not read the stored password policy; keeping the cached one.", error instanceof Error ? error.name : "error");
  }
  return current;
}

export async function savePasswordPolicy(next: PasswordPolicy, updatedBy: string): Promise<PasswordPolicy> {
  const parsed = PasswordPolicySchema.parse(next);
  if (shouldPersistSessionsInDatabase()) {
    await prisma.passwordPolicy.upsert({
      where: { id: POLICY_ID },
      create: { id: POLICY_ID, policy: parsed, updatedBy },
      update: { policy: parsed, updatedBy }
    });
  }
  current = parsed;
  loadedAt = Date.now();
  return current;
}

export function resetPasswordPolicyForTests(): void {
  current = { ...DEFAULT_PASSWORD_POLICY };
  loadedAt = 0;
}

export type PasswordContext = { username?: string; email?: string; fullName?: string };

/** Returns what is wrong with a candidate password; an empty list means it meets the policy. */
export function passwordViolations(password: string, policy: PasswordPolicy, context: PasswordContext = {}): string[] {
  const problems: string[] = [];
  if (password.length < policy.minLength) problems.push(`Use at least ${policy.minLength} characters.`);
  if (password.length > 256) problems.push("Use at most 256 characters.");
  if (policy.requireUppercase && !/\p{Lu}/u.test(password)) problems.push("Include an uppercase letter.");
  if (policy.requireLowercase && !/\p{Ll}/u.test(password)) problems.push("Include a lowercase letter.");
  if (policy.requireDigit && !/\d/.test(password)) problems.push("Include a digit.");
  if (policy.requireSymbol && !/[^\p{L}\p{N}]/u.test(password)) problems.push("Include a symbol.");
  const lowered = password.toLowerCase();
  const personal = [context.username, context.email?.split("@")[0], ...(context.fullName?.split(/\s+/) ?? [])]
    .map((part) => part?.trim().toLowerCase())
    .filter((part): part is string => Boolean(part && part.length >= 4));
  if (personal.some((part) => lowered.includes(part))) problems.push("Do not include your name or user name.");
  return problems;
}

export function isPasswordExpired(changedAt: Date | undefined, policy: PasswordPolicy, now = Date.now()): boolean {
  if (policy.maxAgeDays <= 0 || !changedAt) return false;
  return now - changedAt.getTime() > policy.maxAgeDays * 24 * 60 * 60 * 1000;
}
