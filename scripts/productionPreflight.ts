import { productionPreflight } from "../src/config/productionPreflight.js";

const findings = productionPreflight();
for (const f of findings) console.log(`${f.level === "fail" ? "FAIL" : "warn"}  ${f.check}: ${f.detail}`);
const failures = findings.filter((f) => f.level === "fail").length;
console.log(failures === 0 ? `Preflight passed (${findings.length} warning(s)).` : `Preflight FAILED: ${failures} problem(s).`);
process.exit(failures === 0 ? 0 : 1);
