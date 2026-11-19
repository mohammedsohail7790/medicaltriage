/**
 * Runs retention for one or all data types (NFR-055, NFR-057). Each data type has its own policy, so each
 * can be run on its own schedule by its own scheduler job: --target=<policy code>.
 * Dry run by default; --execute purges only data types whose policy is approved. Audit events are never touched.
 *
 *   npx tsx src/scripts/runRetention.ts                                  # report for every data type
 *   npx tsx src/scripts/runRetention.ts --target=USER_SESSION_EXPIRED --execute
 *   npx tsx src/scripts/runRetention.ts --retention-days=30              # what-if, dry run only
 */
import { disconnectPrisma } from "../db.js";
import { runRetention } from "../services/retentionEngine.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const target = arg("target");
const days = arg("retention-days");
const results = await runRetention({ execute: process.argv.includes("--execute"), codes: target ? target.split(",") : undefined, daysOverride: days ? Number(days) : undefined });
console.log(JSON.stringify(results, null, 2));
await disconnectPrisma();
