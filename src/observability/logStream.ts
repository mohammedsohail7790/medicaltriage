import { createHmac } from "node:crypto";
import { requireSecret } from "../config/secrets.js";

/**
 * Application and security log streaming to a SIEM (NFR-167). Every structured log line the application writes (a JSON
 * object with a "type") is also placed in a bounded buffer and sent, in batches and signed, to the HTTPS collectors in
 * LOG_FORWARD_SINKS. Lines are classed as security or application so a SIEM can route them. A failing collector never
 * affects the service: the buffer is bounded, the oldest lines are dropped and counted, and failures are reported
 * without writing structured lines (which would feed the stream with its own errors).
 * Audit events travel separately, from the ledger, through AUDIT_FORWARD_SINKS.
 */

export type LogSinkConfig = { name: string; url: string; timeoutMs?: number };
export type StreamedLine = { stream: "security" | "application"; timestampIso: string; line: Record<string, unknown> };

const SECURITY_TYPE = /(auth|login|mfa|captcha|session|security|anomaly|audit|elevat|reveal|export|integrity|rate_limit|forbidden|denied)/i;

export function parseLogSinks(raw: string | undefined): LogSinkConfig[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("LOG_FORWARD_SINKS must be a JSON array.");
  return parsed.map((entry) => {
    const e = entry as Partial<LogSinkConfig>;
    if (!e.name || !e.url || !/^https:\/\//.test(e.url)) throw new Error("Each log sink needs a name and an https url.");
    return { name: e.name, url: e.url, ...(e.timeoutMs ? { timeoutMs: e.timeoutMs } : {}) };
  });
}

export function classify(line: Record<string, unknown>): StreamedLine["stream"] {
  return SECURITY_TYPE.test(String(line.type ?? "")) ? "security" : "application";
}

type Sender = (sink: LogSinkConfig, body: string, signature: string) => Promise<boolean>;

export class LogStreamer {
  private buffer: StreamedLine[] = [];
  dropped = 0;
  sent = 0;
  failed = 0;
  constructor(private readonly sinks: LogSinkConfig[], private readonly send: Sender, private readonly options: { maxBuffer?: number; batchSize?: number; secret?: () => string } = {}) {}

  get enabled(): boolean {
    return this.sinks.length > 0;
  }

  get buffered(): number {
    return this.buffer.length;
  }

  push(line: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.buffer.push({ stream: classify(line), timestampIso: new Date().toISOString(), line });
    const max = this.options.maxBuffer ?? 10_000;
    if (this.buffer.length > max) {
      this.dropped += this.buffer.length - max;
      this.buffer.splice(0, this.buffer.length - max);
    }
  }

  async flush(): Promise<void> {
    if (!this.enabled) return;
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.options.batchSize ?? 200);
      const results = await Promise.all(this.sinks.map(async (sink) => {
        const body = JSON.stringify({ sink: sink.name, events: batch });
        const signature = createHmac("sha256", (this.options.secret ?? (() => requireSecret("LOG_FORWARD_SECRET")))()).update(body).digest("hex");
        try {
          return await this.send(sink, body, signature);
        } catch {
          return false;
        }
      }));
      if (results.every(Boolean)) this.sent += batch.length;
      else {
        this.failed += batch.length;
        // Keep what could not be delivered for one more try, within the bound.
        this.buffer.unshift(...batch.slice(0, 500));
        process.stderr.write(`log stream: a collector did not accept ${batch.length} line(s)\n`);
        return;
      }
    }
  }

  statistics() {
    return { buffered: this.buffer.length, sent: this.sent, failed: this.failed, dropped: this.dropped, sinks: this.sinks.map((s) => s.name) };
  }
}

const httpSender: Sender = async (sink, body, signature) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), sink.timeoutMs ?? 5000);
  try {
    const response = await fetch(sink.url, { method: "POST", headers: { "content-type": "application/json", "x-log-signature": signature }, body, signal: controller.signal });
    return response.ok;
  } finally {
    clearTimeout(timer);
  }
};

let shared: LogStreamer | undefined;
export function getLogStreamer(): LogStreamer {
  if (!shared) shared = new LogStreamer(parseLogSinks(process.env.LOG_FORWARD_SINKS), httpSender);
  return shared;
}

let installed = false;
/** Copies structured console lines into the stream. Call once at start-up. */
export function installLogStream(streamer: LogStreamer = getLogStreamer()): void {
  if (installed || !streamer.enabled) return;
  installed = true;
  for (const method of ["log", "warn", "error"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      if (typeof args[0] === "string" && args[0].startsWith("{")) {
        try {
          const parsed = JSON.parse(args[0]) as Record<string, unknown>;
          if (typeof parsed.type === "string") streamer.push(parsed);
        } catch {
          // Not a structured line.
        }
      }
    };
  }
  const timer = setInterval(() => void streamer.flush(), 5000);
  timer.unref?.();
}
