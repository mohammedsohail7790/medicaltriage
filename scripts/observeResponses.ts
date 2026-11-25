// NFR-164: records the shape of what every read-only endpoint (no identifier in its path) really answers, for a
// nurse and for an administrator, and writes docs/observed-responses.json. The OpenAPI generator uses it as the
// response schema. It describes the demonstration build's answers: a field that is absent when there is no data
// shows as optional, and endpoints that need an identifier are not covered.
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createApp } from "../src/app.js";
import { collectRoutes } from "../src/services/openApiGenerator.js";
import { inferSchema, mergeSchemas, type Json } from "../src/services/schemaInference.js";

process.env.MOCK_MODE ??= "true";
process.env.ADMIN_PASSWORD ??= "TestAdminPassword!2026";
const app = createApp();
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const routes = collectRoutes(app).filter((r) => r.method === "get" && !r.path.includes(":"));
const accounts = [{ username: "layla@irisstar.tech", simulateRole: "remote_triage_nurse" }, { username: "rishma@irisstar.tech" }];
const observed: Record<string, Record<string, Json>> = {};
for (const account of accounts) {
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...account, password: process.env.ADMIN_PASSWORD }) });
  if (!login.ok) throw new Error(`Sign-in as ${account.username} answered ${login.status}`);
  const token = ((await login.json()) as { accessToken: string }).accessToken;
  for (const route of routes) {
    const res = await fetch(`${base}${route.path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }).catch(() => undefined);
    if (!res || res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("json")) continue;
    const body = await res.json().catch(() => undefined);
    if (body === undefined) continue;
    const key = `GET ${route.path}`;
    observed[key] ??= {};
    observed[key]["200"] = observed[key]["200"] ? mergeSchemas(observed[key]["200"], inferSchema(body)) : inferSchema(body);
  }
}
server.close();
const sorted = Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(path.resolve(process.cwd(), "docs", "observed-responses.json"), JSON.stringify(sorted, null, 1) + "\n");
console.log(`Wrote docs/observed-responses.json: ${Object.keys(sorted).length} of ${routes.length} read-only endpoints answered 200 with JSON.`);
process.exit(0);
