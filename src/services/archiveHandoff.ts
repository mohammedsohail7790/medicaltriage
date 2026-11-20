import { callExternal } from "../integration/externalClient.js";
import { createHash } from "node:crypto";
import { basePrisma } from "../db.js";
import { requireSecret } from "../config/secrets.js";
import { appendOperationalAuditEvent } from "./auditLedger.js";
import { signAuditPayload } from "./auditForwarding.js";
import { decryptResult } from "./fieldEncryption.js";

/**
 * Archive handoff (NFR-056). IRISSTAR keeps no clinical archive: records the retention process archives
 * are sent to the Qatar Airways-designated archive system, and once it confirms receipt the local copy of
 * the content is removed, leaving only a hash of what was sent as proof.
 *
 *   ARCHIVE_HANDOFF_URL            https endpoint of the designated archive system
 *   ARCHIVE_HANDOFF_SECRET         signs each request (HMAC-SHA256, X-Archive-Signature)
 *   ARCHIVE_HANDOFF_PURGE_LOCAL    true (default): remove the local content after confirmed handoff
 *   ARCHIVE_HANDOFF_MAX_HOURS      how long an archived record may wait before integrity checks complain (72)
 * The archive system answers 2xx, optionally with { "reference": "..." }. Anything else leaves the
 * record in place to be retried and raises an alert.
 */

type HandoffFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
let handoffFetch: HandoffFetch | undefined;
export function setArchiveHandoffFetchForTests(fn: HandoffFetch | undefined): void {
  handoffFetch = fn;
}

export function validateArchiveHandoffConfiguration(env: Record<string, string | undefined> = process.env): void {
  const url = env.ARCHIVE_HANDOFF_URL?.trim();
  if (!url) return;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("ARCHIVE_HANDOFF_URL is not a valid URL.");
  }
  if (target.protocol !== "https:" && !(env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(target.hostname))) throw new Error("ARCHIVE_HANDOFF_URL must use https.");
  if (env.NODE_ENV === "production" && !env.ARCHIVE_HANDOFF_SECRET?.trim()) throw new Error("ARCHIVE_HANDOFF_SECRET is required when ARCHIVE_HANDOFF_URL is configured.");
}

export type HandoffResult = { attempted: number; handedOff: number; failed: number; localContentRemoved: number; skipped?: string };

export async function handOffArchive(options: { batchSize?: number } = {}): Promise<HandoffResult> {
  const url = process.env.ARCHIVE_HANDOFF_URL?.trim();
  if (!url) return { attempted: 0, handedOff: 0, failed: 0, localContentRemoved: 0, skipped: "no designated archive system is configured (ARCHIVE_HANDOFF_URL)" };
  const purgeLocal = (process.env.ARCHIVE_HANDOFF_PURGE_LOCAL ?? "true").trim().toLowerCase() !== "false";
  const result: HandoffResult = { attempted: 0, handedOff: 0, failed: 0, localContentRemoved: 0 };

  for (;;) {
    const rows = await basePrisma.archivedRecord.findMany({ where: { handedOffAt: null }, orderBy: { archivedAt: "asc" }, take: options.batchSize ?? 100 });
    if (rows.length === 0) break;
    result.attempted += rows.length;
    // Content is sent in the clear to the designated system over TLS; stored ciphertext is decrypted first.
    const records = await Promise.all(
      rows.map(async (row) => {
        const payload = await decryptResult(row.entityName, JSON.parse(JSON.stringify(row.payload)));
        const text = JSON.stringify(payload);
        return { id: row.id, entityName: row.entityName, recordId: row.recordId, policyCode: row.policyCode, archivedAtIso: row.archivedAt.toISOString(), payload, payloadSha256: createHash("sha256").update(text).digest("hex") };
      })
    );
    const body = JSON.stringify({ records });
    let reference: string | undefined;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const send = handoffFetch ?? ((target, init) => callExternal("archive-handoff", target, init as RequestInit, { attempts: 1 }) as unknown as ReturnType<HandoffFetch>);
        const response = await send(url, { method: "POST", headers: { "content-type": "application/json", "x-archive-signature": signAuditPayload(body, requireSecret("ARCHIVE_HANDOFF_SECRET")) }, body, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        reference = ((await response.json().catch(() => ({}))) as { reference?: string }).reference;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      result.failed += rows.length;
      await appendOperationalAuditEvent({ action: "ARCHIVE_HANDOFF_FAILED", module: "DataRetention", resource: "ArchivedRecord", success: false, risk: "high", metadata: { records: rows.length, error: error instanceof Error ? error.message : "error" } });
      break; // leave the records for the next run rather than hammering a failing system
    }
    const handedOffAt = new Date();
    for (const record of records) {
      await basePrisma.archivedRecord.update({
        where: { id: record.id },
        data: {
          handedOffAt,
          handoffReference: reference ?? null,
          ...(purgeLocal ? { payload: { handedOff: true, payloadSha256: record.payloadSha256, handedOffAtIso: handedOffAt.toISOString() } } : {})
        }
      });
      result.handedOff += 1;
      if (purgeLocal) result.localContentRemoved += 1;
    }
  }
  if (result.attempted > 0) {
    await appendOperationalAuditEvent({ action: result.failed === 0 ? "ARCHIVE_HANDOFF_COMPLETED" : "ARCHIVE_HANDOFF_FAILED", module: "DataRetention", resource: "ArchivedRecord", success: result.failed === 0, risk: result.failed === 0 ? "medium" : "high", metadata: { ...result } });
  }
  return result;
}
