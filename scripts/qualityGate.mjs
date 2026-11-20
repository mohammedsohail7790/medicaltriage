// NFR-082: quality gate for the pipeline. Fails (exit 1) when test coverage or measured performance is below the
// thresholds in quality-thresholds.json.
//   node scripts/qualityGate.mjs [--coverage coverage/coverage-summary.json] [--load path/to/load-test-summary.json]
// Coverage comes from `pnpm test:coverage`; the performance summary is the JSON printed by scripts/loadTest.mjs.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const thresholds = JSON.parse(readFileSync(path.resolve(process.cwd(), "quality-thresholds.json"), "utf8"));
const failures = [];
const lines = [];

const coveragePath = path.resolve(process.cwd(), arg("--coverage", "coverage/coverage-summary.json"));
if (!existsSync(coveragePath)) failures.push(`No coverage report at ${coveragePath}. Run pnpm test:coverage first.`);
else {
  const total = JSON.parse(readFileSync(coveragePath, "utf8")).total;
  for (const metric of ["lines", "statements", "functions", "branches"]) {
    const actual = total[metric].pct;
    const min = thresholds.coverage[metric];
    lines.push(`coverage ${metric}: ${actual}% (minimum ${min}%)`);
    if (actual < min) failures.push(`Coverage of ${metric} is ${actual}%, below the ${min}% minimum.`);
  }
}

const loadPath = arg("--load");
if (loadPath) {
  const file = path.resolve(process.cwd(), loadPath);
  if (!existsSync(file)) failures.push(`No load-test summary at ${file}.`);
  else {
    const summary = JSON.parse(readFileSync(file, "utf8"));
    const p95 = summary.p95Ms ?? summary.latency?.p95Ms;
    const errorRate = summary.errorRate ?? (summary.requests ? (summary.failures ?? 0) / summary.requests : 0);
    lines.push(`performance p95: ${p95} ms (maximum ${thresholds.performance.p95Ms} ms)`, `performance error rate: ${errorRate} (maximum ${thresholds.performance.errorRate})`);
    if (p95 > thresholds.performance.p95Ms) failures.push(`p95 latency ${p95} ms is above ${thresholds.performance.p95Ms} ms.`);
    if (errorRate > thresholds.performance.errorRate) failures.push(`Error rate ${errorRate} is above ${thresholds.performance.errorRate}.`);
  }
} else lines.push("performance: no load-test summary given (pass --load to enforce the latency and error thresholds)");

console.log(lines.join("\n"));
if (failures.length) {
  console.error("\nQuality gate FAILED:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("\nQuality gate passed.");
