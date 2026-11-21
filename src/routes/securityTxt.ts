import { Router } from "express";

/**
 * Vulnerability disclosure (NFR-162). A public policy and a machine-readable security.txt (RFC 9116), served without sign-in so a
 * researcher can find where to report. The contact address is deployment configuration (SECURITY_CONTACT) because it belongs to
 * the organisation, not to the code; with none set neither page is served, so nothing public points at a mailbox nobody reads.
 */

export type DisclosureConfig = { contact: string; policyUrl?: string; languages: string; acknowledgeDays: number; triageDays: number };

export function disclosureConfig(env: NodeJS.ProcessEnv = process.env): DisclosureConfig | undefined {
  const raw = env.SECURITY_CONTACT?.trim();
  if (!raw) return undefined;
  const contact = /^(mailto:|https:\/\/)/i.test(raw) ? raw : `mailto:${raw}`;
  if (!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(contact) && !/^https:\/\/\S+$/i.test(contact)) return undefined;
  return { contact, policyUrl: env.SECURITY_POLICY_URL?.trim() || undefined, languages: env.SECURITY_LANGUAGES?.trim() || "en, ar", acknowledgeDays: Number(env.SECURITY_ACK_DAYS ?? 3), triageDays: Number(env.SECURITY_TRIAGE_DAYS ?? 10) };
}

export function renderSecurityTxt(config: DisclosureConfig, host: string, now = new Date()): string {
  const expires = new Date(now.getTime() + 365 * 86_400_000).toISOString();
  return [
    `Contact: ${config.contact}`,
    `Expires: ${expires}`,
    `Preferred-Languages: ${config.languages}`,
    `Canonical: https://${host}/.well-known/security.txt`,
    `Policy: ${config.policyUrl ?? `https://${host}/security/disclosure`}`
  ].join("\n") + "\n";
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderDisclosurePage(config: DisclosureConfig): string {
  const contactHref = esc(config.contact);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Vulnerability disclosure policy</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1f2933;line-height:1.6}h1{font-size:1.5rem}h2{font-size:1.05rem;margin-top:1.6em}</style></head>
<body>
<h1>Vulnerability disclosure policy</h1>
<p>We want to hear about security weaknesses in the IST Health tele-triage service. This page says how to report one and what to expect.</p>
<h2>How to report</h2>
<p>Write to <a href="${contactHref}">${esc(config.contact.replace(/^mailto:/i, ""))}</a>. Say what you found, where, and how to reproduce it. Do not include patient or staff personal data; if you came across any, tell us what kind and stop.</p>
<h2>What we ask of you</h2>
<ul><li>Give us reasonable time to fix the issue before you tell anyone else.</li>
<li>Do not read, change, delete or keep data that is not yours; do not disrupt the service (no denial-of-service or volume testing).</li>
<li>Test only with accounts you own, and only against the service itself, not against our suppliers or other customers.</li></ul>
<h2>What you can expect from us</h2>
<ul><li>We acknowledge your report within ${config.acknowledgeDays} working days.</li>
<li>We tell you our assessment within ${config.triageDays} working days, and keep you informed until it is fixed.</li>
<li>We will not take legal action against research that follows this policy.</li>
<li>With your agreement, we will credit you when the fix is published.</li></ul>
<h2>Scope</h2>
<p>The web application and its API at this address. Out of scope: social engineering, physical attacks, and third-party services we use.</p>
<h2>Machine-readable</h2>
<p>See <a href="/.well-known/security.txt">/.well-known/security.txt</a>.</p>
</body></html>`;
}

export function createSecurityTxtRouter(): Router {
  const router = Router();
  router.get("/.well-known/security.txt", (req, res) => {
    const config = disclosureConfig();
    if (!config) return res.status(404).type("text/plain").send("Not configured\n");
    return res.type("text/plain").send(renderSecurityTxt(config, req.get("host") ?? "localhost"));
  });
  router.get("/security/disclosure", (_req, res) => {
    const config = disclosureConfig();
    if (!config) return res.status(404).type("text/plain").send("Not configured\n");
    return res.type("html").send(renderDisclosurePage(config));
  });
  return router;
}
