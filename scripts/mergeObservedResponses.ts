// NFR-164: folds the answers recorded during a test run (RECORD_RESPONSES_FILE) and the answers of the read-only
// endpoints (scripts/observeResponses.ts) into docs/observed-responses.json: { "METHOD /path": { "<status>": schema } }.
// Usage: RECORD_RESPONSES_FILE=/tmp/r.jsonl pnpm test; pnpm exec tsx scripts/mergeObservedResponses.ts /tmp/r.jsonl
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mergeSchemas, type Json } from "../src/services/schemaInference.js";

const recorded = process.argv[2];
if (!recorded || !existsSync(recorded)) {
  console.error("Usage: tsx scripts/mergeObservedResponses.ts <recorded.jsonl>");
  process.exit(2);
}
const target = path.resolve(process.cwd(), "docs", "observed-responses.json");
const out: Record<string, Record<string, Json>> = existsSync(target) ? (JSON.parse(readFileSync(target, "utf8")) as Record<string, Record<string, Json>>) : {};
for (const [key, value] of Object.entries(out)) if ((value as Json).type) out[key] = { "200": value as Json }; // older single-schema form
let lines = 0;
for (const line of readFileSync(recorded, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const { key, status, schema } = JSON.parse(line) as { key: string; status: number; schema: Json };
  if (!key.includes(" /api/")) continue;
  out[key] ??= {};
  const s = String(status);
  out[key][s] = out[key][s] ? mergeSchemas(out[key][s], schema) : schema;
  lines++;
}
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(target, JSON.stringify(sorted, null, 1) + "\n");
console.log(`Merged ${lines} recorded answers: ${Object.keys(sorted).length} operations now have an observed answer.`);
