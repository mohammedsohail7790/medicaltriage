/**
 * Runs the data integrity checks (NFR-059) and exits non-zero when one fails, so the scheduler
 * (Cloud Scheduler running this as a Cloud Run job) marks the run failed and alerting fires.
 *
 *   npx tsx src/scripts/runIntegrityChecks.ts            # run all checks, repairing safe cases
 *   npx tsx src/scripts/runIntegrityChecks.ts --no-repair
 *   npx tsx src/scripts/runIntegrityChecks.ts --only=audit-ledger,encrypted-fields
 */
import { disconnectPrisma } from "../db.js";
import { runIntegrityChecks } from "../services/integrityChecks.js";

const only = process.argv.find((arg) => arg.startsWith("--only="))?.split("=")[1]?.split(",");
const report = await runIntegrityChecks({ repair: !process.argv.includes("--no-repair"), only });
console.log(JSON.stringify(report, null, 2));
await disconnectPrisma();
process.exit(report.ok ? 0 : 1);
