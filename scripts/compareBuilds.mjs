// Sprint 10: side-by-side comparison of two running builds (for example the sprint build and the frozen demo or the
// SOC 2 baseline). It signs in to both with the same account, calls every read-only endpoint in docs/openapi.json that
// needs no identifier, and reports where the two differ: status code, or the top-level fields of the JSON answer.
// It only reads. Usage:
//   COMPARE_PASSWORD=... node scripts/compareBuilds.mjs <sprintUrl> <baselineUrl> [out.json]
// COMPARE_ACCOUNTS="layla@irisstar.tech:remote_triage_nurse,rishma@irisstar.tech:" picks the accounts (user:role).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [sprintUrl, baseUrl, outFile] = process.argv.slice(2);
if (!sprintUrl || !baseUrl) {
  console.error("Usage: COMPARE_PASSWORD=... node scripts/compareBuilds.mjs <sprintUrl> <baselineUrl> [out.json]");
  process.exit(2);
}
const password = process.env.COMPARE_PASSWORD ?? "";
const accounts = (process.env.COMPARE_ACCOUNTS ?? "layla@irisstar.tech:remote_triage_nurse,rishma@irisstar.tech:").split(",").map((a) => {
  const [username, role] = a.split(":");
  return { username, role: role || undefined };
});
const spec = JSON.parse(readFileSync(path.join(process.cwd(), "docs/openapi.json"), "utf8"));
const endpoints = Object.entries(spec.paths).filter(([p, v]) => v.get && !p.includes("{")).map(([p]) => p).sort();

async function login(url, account) {
  const res = await fetch(`${url}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: account.username, password, ...(account.role ? { simulateRole: account.role } : {}) }) });
  if (!res.ok) return { error: `sign-in answered ${res.status}` };
  const body = await res.json();
  return { token: body.accessToken, cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ") };
}

async function call(url, auth, p) {
  try {
    const res = await fetch(`${url}${p}`, { headers: { authorization: `Bearer ${auth.token}`, ...(auth.cookie ? { cookie: auth.cookie } : {}) }, redirect: "manual", signal: AbortSignal.timeout(15000) });
    let keys;
    if ((res.headers.get("content-type") ?? "").includes("json")) {
      const body = await res.json().catch(() => undefined);
      keys = body && typeof body === "object" ? (Array.isArray(body) ? ["[array]"] : Object.keys(body).sort()) : undefined;
    }
    return { status: res.status, keys };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.name : "error" };
  }
}

const rows = [];
for (const account of accounts) {
  const [a, b] = await Promise.all([login(sprintUrl, account), login(baseUrl, account)]);
  if (a.error || b.error) {
    rows.push({ account: account.username, path: "(sign-in)", kind: "difference", detail: `sprint: ${a.error ?? "ok"}; baseline: ${b.error ?? "ok"}` });
    continue;
  }
  for (const p of endpoints) {
    const [x, y] = [await call(sprintUrl, a, p), await call(baseUrl, b, p)];
    let kind = "same";
    let detail = "";
    if (x.status !== y.status) {
      kind = y.status === 404 ? "new in sprint build" : x.status === 404 ? "missing from sprint build" : "status differs";
      detail = `sprint ${x.status}, baseline ${y.status}`;
    } else if (JSON.stringify(x.keys) !== JSON.stringify(y.keys)) {
      const added = (x.keys ?? []).filter((k) => !(y.keys ?? []).includes(k));
      const removed = (y.keys ?? []).filter((k) => !(x.keys ?? []).includes(k));
      kind = removed.length ? "fields removed" : "fields added";
      detail = `added: ${added.join(", ") || "-"}; removed: ${removed.join(", ") || "-"}`;
    }
    rows.push({ account: account.username, path: p, status: x.status, kind, detail });
  }
}
const counts = {};
for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
const summary = { sprintUrl, baseUrl, endpointsTried: endpoints.length, accounts: accounts.map((a) => a.username), counts, differences: rows.filter((r) => r.kind !== "same") };
if (outFile) writeFileSync(outFile, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ endpointsTried: endpoints.length, counts }, null, 1));
for (const r of rows.filter((x) => ["status differs", "missing from sprint build", "fields removed"].includes(x.kind))) console.log(`${r.kind.toUpperCase()}  ${r.account}  ${r.path}  ${r.detail}`);
