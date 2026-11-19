/**
 * Hands archived records to the Qatar Airways-designated archive system (NFR-056) and removes the local
 * content once receipt is confirmed. Exits non-zero if any record could not be handed off.
 */
import { disconnectPrisma } from "../db.js";
import { handOffArchive } from "../services/archiveHandoff.js";

const result = await handOffArchive();
console.log(JSON.stringify(result, null, 2));
await disconnectPrisma();
process.exit(result.failed > 0 ? 1 : 0);
