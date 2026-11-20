import { callExternal } from "../integration/externalClient.js";
import { createHmac } from "node:crypto";
import { requireSecret } from "../config/secrets.js";
import type { AuditEvent } from "../types/security.js";

/**
 * Forwards audit events to stores designated by Qatar Airways (M-008).
 *
 * The hash-chained ledger stays the source of truth. Forwarding runs after an event
 * is committed, never blocks or fails the write, and is at-least-once: receivers can
 * de-duplicate on eventHash, and a gap can be replayed from the ledger by sequence
 * number (see src/scripts/forwardAuditEvents.ts).
 *
 * Configure with AUDIT_FORWARD_SINKS, a JSON array such as:
 *   [{"name":"qr-siem","type":"https","url":"https://siem.example/audit"},
 *    {"name":"cloud-logging","type":"stdout"}]
 * An https sink signs each request body with HMAC-SHA256 using AUDIT_FORWARD_SECRET and
 * sends it in the X-Audit-Signature header. The stdout sink writes one JSON line per
 * event for a log router or SIEM connector to collect.
 */

export type ForwardedAuditEvent = AuditEvent & {
  sequenceNumber: string;
  previousHash: string;
  eventHash: string;
  keyVersion: string;
};

export type AuditSinkConfig =
  | { name: string; type: "https"; url: string; timeoutMs?: number }
  | { name: string; type: "stdout" };

export interface AuditSink {
  readonly name: string;
  send(events: ForwardedAuditEvent[]): Promise<void>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export function parseAuditSinkConfig(raw: string | undefined, production = process.env.NODE_ENV === "production"): AuditSinkConfig[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AUDIT_FORWARD_SINKS is not valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("AUDIT_FORWARD_SINKS must be a JSON array.");
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    const item = entry as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) throw new Error(`AUDIT_FORWARD_SINKS[${index}] needs a name.`);
    if (seen.has(name)) throw new Error(`AUDIT_FORWARD_SINKS has a duplicate sink name: ${name}.`);
    seen.add(name);
    if (item.type === "stdout") return { name, type: "stdout" } as AuditSinkConfig;
    if (item.type === "https") {
      const url = typeof item.url === "string" ? item.url.trim() : "";
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw new Error(`AUDIT_FORWARD_SINKS sink ${name} has an invalid url.`);
      }
      if (target.protocol !== "https:" && !(target.protocol === "http:" && !production && ["localhost", "127.0.0.1"].includes(target.hostname))) {
        throw new Error(`AUDIT_FORWARD_SINKS sink ${name} must use https.`);
      }
      const timeoutMs = typeof item.timeoutMs === "number" && item.timeoutMs > 0 ? item.timeoutMs : undefined;
      return { name, type: "https", url, timeoutMs } as AuditSinkConfig;
    }
    throw new Error(`AUDIT_FORWARD_SINKS sink ${name} has an unsupported type.`);
  });
}

export function signAuditPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function createSink(config: AuditSinkConfig, fetchImpl: FetchLike = (((url: string, init: unknown) => callExternal("audit-sink", url, init as RequestInit, { attempts: 1 })) as unknown as FetchLike)): AuditSink {
  if (config.type === "stdout") {
    return {
      name: config.name,
      async send(events) {
        for (const event of events) console.log(JSON.stringify({ type: "audit_event", sink: config.name, ...event }));
      }
    };
  }
  return {
    name: config.name,
    async send(events) {
      const body = JSON.stringify({ sink: config.name, events });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 5000);
      try {
        const response = await fetchImpl(config.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-audit-signature": signAuditPayload(body, requireSecret("AUDIT_FORWARD_SECRET")) },
          body,
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`sink ${config.name} answered HTTP ${response.status}`);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

export type ForwardingStats = { forwarded: number; failed: number; lastError?: string };

export class AuditForwarder {
  private readonly stats = new Map<string, ForwardingStats>();

  constructor(
    private readonly sinks: AuditSink[],
    private readonly options: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {}
  ) {
    sinks.forEach((sink) => this.stats.set(sink.name, { forwarded: 0, failed: 0 }));
  }

  get enabled(): boolean {
    return this.sinks.length > 0;
  }

  statistics(): Record<string, ForwardingStats> {
    return Object.fromEntries(this.stats);
  }

  /** Sends to every sink independently. Never throws: a failing store cannot affect the ledger. */
  async forward(events: ForwardedAuditEvent[]): Promise<void> {
    if (events.length === 0) return;
    await Promise.all(this.sinks.map((sink) => this.deliver(sink, events)));
  }

  private async deliver(sink: AuditSink, events: ForwardedAuditEvent[]): Promise<void> {
    const attempts = this.options.attempts ?? 3;
    const base = this.options.baseDelayMs ?? 250;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const stat = this.stats.get(sink.name)!;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await sink.send(events);
        stat.forwarded += events.length;
        return;
      } catch (error) {
        stat.lastError = error instanceof Error ? error.message : String(error);
        if (attempt < attempts) await sleep(base * 2 ** (attempt - 1));
      }
    }
    stat.failed += events.length;
    console.error(JSON.stringify({ type: "audit_forward_failed", sink: sink.name, events: events.length, lastSequence: events[events.length - 1]?.sequenceNumber, error: stat.lastError }));
  }
}

let shared: AuditForwarder | undefined;

export function getAuditForwarder(): AuditForwarder {
  if (!shared) shared = new AuditForwarder(parseAuditSinkConfig(process.env.AUDIT_FORWARD_SINKS).map((config) => createSink(config)));
  return shared;
}

export function resetAuditForwarderForTests(): void {
  shared = undefined;
}

/** Fire-and-forget entry point used after a ledger commit. */
export function forwardCommittedAuditEvent(event: ForwardedAuditEvent): void {
  const forwarder = getAuditForwarder();
  if (!forwarder.enabled) return;
  void forwarder.forward([event]);
}
