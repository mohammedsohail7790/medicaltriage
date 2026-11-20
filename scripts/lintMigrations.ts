import { lintAll } from "../src/utils/migrationLint.js";

const { problems, risky } = lintAll();
if (process.argv.includes("--write-baseline")) {
  console.log(JSON.stringify({ grandfathered: risky }, null, 2));
  process.exit(0);
}
if (problems.length) {
  console.error("Migrations that are not backward compatible:");
  for (const p of problems) console.error(`- ${p.migration}: ${p.reasons.join("; ")}. Split it (expand now, contract in a later release) or add '-- expand-contract: <reason>'.`);
  process.exit(1);
}
console.log(`Migration lint passed (${risky.length} earlier migration(s) grandfathered).`);
