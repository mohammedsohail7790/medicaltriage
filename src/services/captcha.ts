import { callExternal } from "../integration/externalClient.js";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { matchesAllowlist, parseAllowlist } from "../middleware/ipAllowlist.js";
import { requireSecret } from "../config/secrets.js";

/**
 * CAPTCHA for specific sign-in situations (NFR-020): sign-in from outside the approved
 * networks, and after repeated failed attempts. The challenge method is configurable so the
 * one Qatar Airways approves can be used:
 *
 *   CAPTCHA_PROVIDER = self | turnstile | hcaptcha | recaptcha | custom   (unset = off)
 *   self       a proof-of-work challenge issued and checked by this service. No third party,
 *              no data leaves the platform and there is no per-use cost. It makes automated
 *              guessing expensive; it is not a test that the user is a person.
 *   turnstile / hcaptcha / recaptcha / custom   a third-party widget; the token is verified
 *              server-side with CAPTCHA_SECRET (custom needs CAPTCHA_VERIFY_URL).
 *
 *   CAPTCHA_SITE_KEY             public key for the third-party widget
 *   CAPTCHA_APPROVED_NETWORKS    comma-separated addresses/CIDRs; sign-in from anywhere else needs a challenge
 *   CAPTCHA_FAILURE_THRESHOLD    failed attempts before a challenge is required (default 3)
 *   CAPTCHA_SELF_DIFFICULTY      proof-of-work size; higher is harder (default 100000)
 *   CAPTCHA_FAIL_MODE            closed (default) refuses sign-in if a third-party verifier is unreachable; open allows it
 */

export type CaptchaProvider = "self" | "turnstile" | "hcaptcha" | "recaptcha" | "custom";

const VERIFY_URLS: Record<Exclude<CaptchaProvider, "self" | "custom">, string> = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  hcaptcha: "https://hcaptcha.com/siteverify",
  recaptcha: "https://www.google.com/recaptcha/api/siteverify"
};

/** Origins a third-party widget needs in the page's Content-Security-Policy. */
export const WIDGET_ORIGINS: Record<Exclude<CaptchaProvider, "self" | "custom">, string[]> = {
  turnstile: ["https://challenges.cloudflare.com"],
  hcaptcha: ["https://hcaptcha.com", "https://*.hcaptcha.com"],
  recaptcha: ["https://www.google.com", "https://www.gstatic.com"]
};

export function captchaProvider(env: Record<string, string | undefined> = process.env): CaptchaProvider | undefined {
  const raw = env.CAPTCHA_PROVIDER?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "self" || raw === "turnstile" || raw === "hcaptcha" || raw === "recaptcha" || raw === "custom") return raw;
  throw new Error("CAPTCHA_PROVIDER must be self, turnstile, hcaptcha, recaptcha or custom.");
}

export function validateCaptchaConfiguration(env: Record<string, string | undefined> = process.env): void {
  const provider = captchaProvider(env);
  if (!provider) return;
  if (provider !== "self" && !env.CAPTCHA_SITE_KEY?.trim()) throw new Error(`CAPTCHA_SITE_KEY is required for the ${provider} provider.`);
  if (provider === "custom" && !env.CAPTCHA_VERIFY_URL?.trim()) throw new Error("CAPTCHA_VERIFY_URL is required for the custom provider.");
  const verifyUrl = env.CAPTCHA_VERIFY_URL?.trim();
  if (verifyUrl && env.NODE_ENV === "production" && !/^https:\/\//i.test(verifyUrl)) throw new Error("CAPTCHA_VERIFY_URL must use https.");
  if (env.NODE_ENV === "production" && !env.CAPTCHA_SECRET?.trim()) throw new Error("CAPTCHA_SECRET is required when a CAPTCHA provider is configured.");
  const threshold = env.CAPTCHA_FAILURE_THRESHOLD;
  if (threshold !== undefined && !/^[1-9]\d*$/.test(threshold.trim())) throw new Error("CAPTCHA_FAILURE_THRESHOLD must be a positive whole number.");
}

export function captchaFailureThreshold(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CAPTCHA_FAILURE_THRESHOLD);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
}

export type CaptchaReason = "failed-attempts" | "outside-approved-network";

/** Whether this sign-in attempt must carry a solved challenge, and why. */
export function captchaRequirement(args: { failedAttempts: number; ipAddress: string }, env: Record<string, string | undefined> = process.env): CaptchaReason | undefined {
  if (!captchaProvider(env)) return undefined;
  const networks = parseAllowlist(env.CAPTCHA_APPROVED_NETWORKS);
  if (networks.length > 0 && !matchesAllowlist(args.ipAddress, networks)) return "outside-approved-network";
  if (args.failedAttempts >= captchaFailureThreshold(env)) return "failed-attempts";
  return undefined;
}

// ---- self-hosted proof-of-work -------------------------------------------------------------

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const usedChallenges = new Map<string, number>();

export type SelfChallenge = { algorithm: "SHA-256"; salt: string; challenge: string; maxnumber: number; signature: string };

function sign(value: string): string {
  return createHmac("sha256", requireSecret("CAPTCHA_SECRET")).update(value).digest("hex");
}

export function issueSelfChallenge(difficulty = Number(process.env.CAPTCHA_SELF_DIFFICULTY) || 100_000): SelfChallenge {
  const maxnumber = Math.max(1000, difficulty);
  const salt = `${randomBytes(12).toString("hex")}?expires=${Date.now() + CHALLENGE_TTL_MS}`;
  const secretNumber = randomInt(0, maxnumber + 1);
  const challenge = createHash("sha256").update(`${salt}${secretNumber}`).digest("hex");
  return { algorithm: "SHA-256", salt, challenge, maxnumber, signature: sign(challenge) };
}

function verifySelf(payload: string): boolean {
  let solved: { salt?: string; challenge?: string; number?: number; signature?: string };
  try {
    solved = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return false;
  }
  const { salt, challenge, number, signature } = solved;
  if (typeof salt !== "string" || typeof challenge !== "string" || typeof signature !== "string" || !Number.isInteger(number)) return false;
  const expires = Number(/[?&]expires=(\d+)/.exec(salt)?.[1]);
  if (!Number.isFinite(expires) || Date.now() > expires) return false;
  const expectedSignature = Buffer.from(sign(challenge));
  const givenSignature = Buffer.from(signature);
  if (expectedSignature.length !== givenSignature.length || !timingSafeEqual(expectedSignature, givenSignature)) return false;
  if (createHash("sha256").update(`${salt}${number}`).digest("hex") !== challenge) return false;
  // Each challenge works once.
  const now = Date.now();
  for (const [key, until] of usedChallenges) if (until < now) usedChallenges.delete(key);
  if (usedChallenges.has(challenge)) return false;
  usedChallenges.set(challenge, expires);
  return true;
}

// ---- third-party verification --------------------------------------------------------------

type VerifyFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
let verifyFetch: VerifyFetch | undefined;

export function setCaptchaFetchForTests(fn: VerifyFetch | undefined): void {
  verifyFetch = fn;
}

export type CaptchaResult = "passed" | "failed" | "unavailable";

/** Checks a solved challenge. A missing or wrong answer fails; an unreachable verifier is "unavailable". */
export async function verifyCaptcha(token: string | undefined, ipAddress: string, env: Record<string, string | undefined> = process.env): Promise<CaptchaResult> {
  const provider = captchaProvider(env);
  if (!provider) return "passed";
  if (!token) return "failed";
  if (provider === "self") return verifySelf(token) ? "passed" : "failed";

  const url = provider === "custom" ? env.CAPTCHA_VERIFY_URL!.trim() : (env.CAPTCHA_VERIFY_URL?.trim() || VERIFY_URLS[provider]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const send = verifyFetch ?? ((target, init) => callExternal("captcha", target, init as RequestInit, { attempts: 1 }) as unknown as ReturnType<VerifyFetch>);
    const response = await send(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: requireSecret("CAPTCHA_SECRET"), response: token, remoteip: ipAddress }).toString(),
      signal: controller.signal
    });
    if (!response.ok) return "unavailable";
    const body = (await response.json()) as { success?: unknown };
    return body.success === true ? "passed" : "failed";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}

export function captchaFailsClosed(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CAPTCHA_FAIL_MODE ?? "closed").trim().toLowerCase() !== "open";
}

export function resetCaptchaForTests(): void {
  usedChallenges.clear();
  verifyFetch = undefined;
}
