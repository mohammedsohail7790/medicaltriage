import express, { Router } from "express";
import { rateLimit } from "../middleware/rateLimit.js";
import { ConsumerError, RegistrationInput, issueToken, register } from "../services/apiConsumers.js";
import { shouldPersistPlatformInDatabase } from "../config/runtime.js";

/**
 * The developer portal and consumer onboarding (NFR-003): a public page that explains the API and takes a
 * registration, the registration endpoint, and the OAuth token endpoint (client credentials grant). The detailed
 * API reference and the OpenAPI file are for signed-in users and approved consumers (see apiDocsRouter).
 */

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AiMlTriage developer portal</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#111}h1{font-size:1.6rem}label{display:block;margin-top:.8rem;font-weight:600}input,select,textarea{width:100%;padding:.5rem;border:1px solid #bbb;border-radius:6px;font:inherit}button{margin-top:1rem;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#1d4ed8;color:#fff;font:inherit;cursor:pointer}code{background:#f3f4f6;padding:1px 5px;border-radius:4px}.note{background:#eff4ff;padding:.7rem 1rem;border-radius:8px}#result{margin-top:1rem;font-weight:600}</style></head><body>
<h1>AiMlTriage developer portal</h1>
<p>AiMlTriage exposes REST APIs, in JSON, for clinical triage queues, encounters, approvals, administration and integrations, and publishes events as signed webhooks and, where needed, to a message broker.</p>
<h2>How access works</h2>
<ol><li><b>Register</b> below with what you want to build and the load you expect, so capacity can be planned.</li>
<li>An administrator <b>reviews</b> your request and, if approved, issues <b>client credentials</b> with a request budget of its own.</li>
<li>Exchange them for an access token: <code>POST /api/v1/oauth/token</code> with <code>grant_type=client_credentials</code>, <code>client_id</code> and <code>client_secret</code>. The token lasts one hour.</li>
<li>Call the APIs with <code>Authorization: Bearer &lt;token&gt;</code>. The full API reference and the OpenAPI 3 file are then available at <code>/api-docs</code> and <code>/openapi.json</code>, and a test console in non-production environments.</li></ol>
<p class="note">API versions are served under <code>/api/v1</code> and <code>/api/v2</code>. An older version stays available for a notice period; see the deprecation policy at <code>/api/v1/versions</code>.</p>
<h2>Request access</h2>
<form id="form"><label>Application name<input name="name" required minlength="2"></label>
<label>Organisation<input name="organization" required minlength="2"></label>
<label>Contact email<input name="contactEmail" type="email" required></label>
<label>What will it do? (at least 20 characters)<textarea name="purpose" rows="4" required minlength="20"></textarea></label>
<label>Integration type<select name="integrationType"><option value="read-only">Read only</option><option value="read-write">Read and write</option><option value="events">Events (webhooks)</option></select></label>
<label>Expected requests per minute<input name="expected" type="number" min="1" value="60" required></label>
<label>Peak requests per minute<input name="peak" type="number" min="1" value="300" required></label>
<label>Data volume and anything else we should size for<input name="dataVolumeNote"></label>
<button type="submit">Send request</button></form><div id="result" role="status"></div>
<script src="/developers/register.js"></script></body></html>`;

const SCRIPT = `document.getElementById("form").addEventListener("submit", async function (event) {
  event.preventDefault();
  var f = new FormData(event.target);
  var out = document.getElementById("result");
  out.textContent = "Sending...";
  try {
    var response = await fetch("/api/v1/developer/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      name: f.get("name"), organization: f.get("organization"), contactEmail: f.get("contactEmail"), purpose: f.get("purpose"),
      sizing: { integrationType: f.get("integrationType"), expectedRequestsPerMinute: Number(f.get("expected")), peakRequestsPerMinute: Number(f.get("peak")), dataVolumeNote: f.get("dataVolumeNote") || undefined } }) });
    var body = await response.json();
    out.textContent = response.ok ? "Request received. Keep this reference: " + body.requestId + ". You will be contacted when it has been reviewed." : (body.error || "The request could not be sent.");
  } catch (e) { out.textContent = "The request could not be sent. Try again."; }
});`;

export function createDeveloperPageRouter(): Router {
  const router = Router();
  router.get("/developers", (_req, res) => res.type("html").send(PAGE));
  router.get("/developers/register.js", (_req, res) => res.type("application/javascript").send(SCRIPT));
  return router;
}

export function createDeveloperApiRouter(): Router {
  const router = Router();
  const registerLimit = rateLimit({ name: "developer-register", windowMs: 3_600_000, maxRequests: 10 });
  const tokenLimit = rateLimit({ name: "oauth-token", windowMs: 60_000, maxRequests: 30 });

  router.post("/developer/register", registerLimit, async (req, res, next) => {
    try {
      if (!shouldPersistPlatformInDatabase()) return res.status(409).json({ error: "Registration needs database persistence, which is off in this environment.", code: "REGISTRATION_NEEDS_DATABASE" });
      const parsed = RegistrationInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Please check the form: every field is required and the purpose needs at least 20 characters.", details: parsed.error.flatten() });
      return res.status(201).json({ ...(await register(parsed.data)), status: "pending" });
    } catch (error) {
      return next(error);
    }
  });

  // RFC 6749 client credentials grant. Credentials may be in the body or in HTTP Basic.
  router.post("/oauth/token", tokenLimit, express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      let clientId = typeof req.body?.client_id === "string" ? req.body.client_id : undefined;
      let clientSecret = typeof req.body?.client_secret === "string" ? req.body.client_secret : undefined;
      const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? "");
      if (basic) {
        const [id, ...rest] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
        clientId = clientId ?? id;
        clientSecret = clientSecret ?? rest.join(":");
      }
      if (req.body?.grant_type !== "client_credentials") return res.status(400).json({ error: "unsupported_grant_type", error_description: "Only client_credentials is supported." });
      if (!clientId || !clientSecret) return res.status(400).json({ error: "invalid_request", error_description: "client_id and client_secret are required." });
      return res.json(await issueToken(clientId, clientSecret, req.ip ?? "unknown"));
    } catch (error) {
      if (error instanceof ConsumerError) {
        if (error.status === 401) res.setHeader("WWW-Authenticate", 'Basic realm="aimltriage"');
        return res.status(error.status).json({ error: error.code === "INVALID_CLIENT" ? "invalid_client" : "unauthorized_client", error_description: error.message });
      }
      return next(error);
    }
  });

  return router;
}
