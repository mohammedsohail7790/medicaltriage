import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { requireAuthenticatedSession } from "../middleware/auth.js";

// Closes NFR-002 (API Management: API Discovery) - a real, self-hosted
// discovery portal reading the existing, real, machine-generated
// docs/openapi.json (scripts/generateOpenApiSpec.ts) - no new npm
// dependency, no external CDN. Renders a clean, human-browsable endpoint
// list (grouped by path, one row per method/summary) and also serves the
// raw spec for tooling (Postman, other OpenAPI-aware clients) to import.
const OPENAPI_SPEC_PATH = path.resolve(process.cwd(), "docs", "openapi.json");

type OpenApiOperation = { summary?: string; description?: string; tags?: string[] };
type OpenApiSpec = {
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, OpenApiOperation>>;
};

function loadSpec(): OpenApiSpec | undefined {
  if (!existsSync(OPENAPI_SPEC_PATH)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(OPENAPI_SPEC_PATH, "utf8")) as OpenApiSpec;
  } catch {
    return undefined;
  }
}

const VIEWER_SCRIPT = `
(function () {
  var KEY = "ist_triage_access_token";
  var status = document.getElementById("status");
  var table = document.getElementById("rows");
  var tokenInput = document.getElementById("token");
  var tryItEnabled = document.body.getAttribute("data-try-it") === "true";
  function token() { try { return tokenInput.value.trim() || sessionStorage.getItem(KEY) || ""; } catch (e) { return tokenInput.value.trim(); } }
  function esc(v) { return String(v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function load() {
    status.textContent = "Loading...";
    fetch("/api-docs/openapi.json", { headers: { authorization: "Bearer " + token() } }).then(function (r) {
      if (r.status === 401) { status.textContent = "Sign in required: paste an access token (or open this page from a signed-in session)."; table.innerHTML = ""; return null; }
      if (!r.ok) { status.textContent = "Could not load the specification (" + r.status + ")."; return null; }
      return r.json();
    }).then(function (spec) {
      if (!spec) return;
      status.textContent = (spec.info.title || "API") + " - version " + spec.info.version;
      var rows = [];
      Object.keys(spec.paths).sort().forEach(function (p) { Object.keys(spec.paths[p]).forEach(function (m) {
        var op = spec.paths[p][m];
        rows.push("<tr><td class='method method-" + esc(m) + "'>" + esc(m.toUpperCase()) + "</td><td><code>" + esc(p) + "</code></td><td>" + esc(op.summary || "") + (op.requestBody ? " <em>(body schema)</em>" : "") + "</td></tr>");
      }); });
      table.innerHTML = rows.join("");
    });
  }
  document.getElementById("load").addEventListener("click", load);
  if (tryItEnabled) {
    document.getElementById("send").addEventListener("click", function () {
      var out = document.getElementById("out");
      var body = document.getElementById("body").value;
      fetch(document.getElementById("tpath").value, { method: document.getElementById("tmethod").value, headers: { authorization: "Bearer " + token(), "content-type": "application/json" }, body: body && document.getElementById("tmethod").value !== "GET" ? body : undefined })
        .then(function (r) { return r.text().then(function (t) { out.textContent = r.status + "\\n" + t; }); });
    });
  }
  load();
})();
`;

function renderViewerShell(tryItEnabled: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>API reference</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 32px; background: #fff; color: #1f2933; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  #status { color: #52606d; font-size: 0.9rem; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; border: 1px solid #e4e7eb; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eef0f3; font-size: 0.85rem; }
  th { background: #f5f7fa; }
  .method { font-weight: 700; } .method-get { color: #1e7a3d; } .method-post { color: #b06a00; } .method-put, .method-patch { color: #5b3fc4; } .method-delete { color: #c0392b; }
  input, textarea, select, button { font: inherit; padding: 6px 8px; } input#token { width: 420px; max-width: 100%; }
  .bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  pre { background: #f5f7fa; padding: 12px; overflow: auto; }
</style></head>
<body data-try-it="${tryItEnabled}">
  <h1>API reference</h1>
  <div id="status"></div>
  <div class="bar"><input id="token" type="password" placeholder="Access token (optional if signed in)" autocomplete="off" /><button id="load">Load</button></div>
  <table><thead><tr><th>Method</th><th>Path</th><th>Summary</th></tr></thead><tbody id="rows"></tbody></table>
  ${tryItEnabled ? `<h2>Try it (non-production only)</h2>
  <div class="bar"><select id="tmethod"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select><input id="tpath" value="/api/v1/runtime/environment" size="50" /><button id="send">Send</button></div>
  <textarea id="body" rows="5" cols="80" placeholder="JSON body"></textarea><pre id="out"></pre>` : ""}
  <script src="/api-docs/viewer.js"></script>
</body></html>`;
}

// NFR-001 / NFR-002: the reference and specification are not public. The page is a shell with no API
// content; the specification itself requires an authenticated session or a consumer access token.
export function tryItConsoleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.API_TRY_IT_ENABLED !== "false";
}

export function createApiDocsRouter(): Router {
  const router = Router();

  router.get("/api-docs", (_req, res) => {
    res.type("html").send(renderViewerShell(tryItConsoleEnabled()));
  });

  router.get("/api-docs/viewer.js", (_req, res) => {
    res.type("application/javascript").send(VIEWER_SCRIPT);
  });

  router.get("/api-docs/openapi.json", requireAuthenticatedSession, (_req, res) => {
    const spec = loadSpec();
    if (!spec) {
      return res.status(503).json({ error: "docs/openapi.json has not been generated yet" });
    }
    return res.json(spec);
  });

  return router;
}
