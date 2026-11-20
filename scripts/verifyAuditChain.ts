// Verifies the audit ledger's hash chain in the database DATABASE_URL points at. Used by the recovery rehearsal.
import { verifyAuditEventChain } from "../src/services/auditLedger.js";

const result = await verifyAuditEventChain();
console.log(JSON.stringify(result));
process.exit(result.valid ? 0 : 2);
