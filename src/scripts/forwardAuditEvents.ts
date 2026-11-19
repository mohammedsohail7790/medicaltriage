/**
 * Replays audit events from the ledger to the configured forwarding sinks (M-008).
 * Use it after a sink outage or when a new Qatar Airways store is connected.
 * Delivery is at-least-once; receivers de-duplicate on eventHash.
 *
 * Usage:
 *   npx tsx src/scripts/forwardAuditEvents.ts --from-sequence=0
 *   npx tsx src/scripts/forwardAuditEvents.ts --from-sequence=1200 --batch-size=200
 */
import { auditPrisma } from "../db.js";
import { getAuditForwarder, type ForwardedAuditEvent } from "../services/auditForwarding.js";
import type { AuditEvent } from "../types/security.js";

function numberArg(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative whole number`);
  return value;
}

async function main() {
  const forwarder = getAuditForwarder();
  if (!forwarder.enabled) throw new Error("No audit forwarding sinks are configured (AUDIT_FORWARD_SINKS).");
  let cursor = BigInt(numberArg("from-sequence", 0));
  const batchSize = Math.max(1, numberArg("batch-size", 200));
  let total = 0;
  for (;;) {
    const rows = await auditPrisma.auditEvent.findMany({
      where: { eventHash: { not: null }, sequenceNumber: { gt: cursor } },
      orderBy: { sequenceNumber: "asc" },
      take: batchSize
    });
    if (rows.length === 0) break;
    const events: ForwardedAuditEvent[] = rows.map((row) => ({
      id: row.id,
      timestampIso: row.timestamp.toISOString(),
      userId: row.userId ?? "",
      activeRole: row.activeRole ?? "",
      organization: row.organization ?? "",
      facility: row.facility ?? "",
      department: row.department ?? "",
      action: row.action,
      module: row.module,
      resource: row.resource ?? "",
      recordReference: row.recordReference ?? undefined,
      purpose: row.purpose ?? undefined,
      approvalReference: row.approvalReference ?? undefined,
      ipAddress: row.ipAddress ?? "",
      device: row.device ?? "",
      sessionHash: row.sessionHash ?? undefined,
      success: row.success,
      risk: row.riskLevel as AuditEvent["risk"],
      metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
      sequenceNumber: String(row.sequenceNumber),
      previousHash: row.previousHash ?? "",
      eventHash: row.eventHash ?? "",
      keyVersion: row.keyVersion ?? ""
    }));
    await forwarder.forward(events);
    total += events.length;
    cursor = rows[rows.length - 1].sequenceNumber;
    console.log(`Replayed through sequence ${cursor} (${total} events)`);
  }
  console.log(JSON.stringify({ replayed: total, sinks: forwarder.statistics() }));
  await auditPrisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
