/**
 * Retention/purge of completed queue cases. Kept for the existing scheduler job and its documented
 * command line; it now runs the general retention engine for this one data type, so it follows the same
 * rules as every other (approved policy, legal holds, archive before delete, audit entry).
 *
 *   npx tsx src/scripts/purgeExpiredQueueData.ts                      # dry run
 *   npx tsx src/scripts/purgeExpiredQueueData.ts --retention-days=90  # what-if, dry run only
 *   npx tsx src/scripts/purgeExpiredQueueData.ts --execute
 *
 * See src/services/retentionEngine.ts and src/scripts/runRetention.ts for all data types.
 */
import { disconnectPrisma } from "../db.js";
import { runRetention } from "../services/retentionEngine.js";

const days = process.argv.find((a) => a.startsWith("--retention-days="))?.split("=")[1];
const results = await runRetention({
  execute: process.argv.includes("--execute"),
  codes: ["TRIAGE_QUEUE_ITEM_COMPLETED"],
  daysOverride: days ? Number(days) : undefined
});
console.log(JSON.stringify(results, null, 2));
await disconnectPrisma();
