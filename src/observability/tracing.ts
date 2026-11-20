import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Distributed tracing for the application and database tiers (NFR-101).
 *   - W3C Trace Context: an incoming traceparent is continued; otherwise a trace starts. The response carries the
 *     traceparent, and outbound calls pass it on, so a trace follows a request into other systems.
 *   - Spans: the HTTP request, every database operation (model and operation only, never values) and every call to an
 *     external system. Attributes hold names and statuses, never payloads or personal data.
 *   - Storage: a bounded in-memory window for the admin trace view, and optional export to an OpenTelemetry
 *     collector (OTLP over HTTP/JSON) when OTEL_EXPORTER_OTLP_ENDPOINT is set, which is how an SRE team reads it.
 */

export type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "server" | "client" | "internal";
  startMs: number;
  durationMs: number;
  status: "ok" | "error";
  attributes: Record<string, string | number | boolean>;
};

type Context = { traceId: string; spanId: string; sampled: boolean };
const als = new AsyncLocalStorage<Context>();

const MAX_SPANS = Number(process.env.TRACE_BUFFER_SPANS ?? 5000);
const spans: Span[] = [];
const exportQueue: Span[] = [];

export const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export function parseTraceparent(header: string | undefined): { traceId: string; parentId: string; sampled: boolean } | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec((header ?? "").trim());
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;
  return { traceId: match[1], parentId: match[2], sampled: (parseInt(match[3], 16) & 1) === 1 };
}

export const formatTraceparent = (c: Context) => `00-${c.traceId}-${c.spanId}-${c.sampled ? "01" : "00"}`;
export const currentTraceId = (): string | undefined => als.getStore()?.traceId;
export function currentTraceparent(): string | undefined {
  const c = als.getStore();
  return c ? formatTraceparent(c) : undefined;
}

function sampleRate(): number {
  const rate = Number(process.env.TRACE_SAMPLE_RATE ?? 1);
  return Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 1;
}

function record(span: Span, sampled: boolean): void {
  if (!sampled) return;
  spans.push(span);
  if (spans.length > MAX_SPANS) spans.splice(0, spans.length - MAX_SPANS);
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) exportQueue.push(span);
}

/** Runs fn as a child span of the current trace; with no trace in progress it just runs fn. */
export async function withSpan<T>(name: string, kind: Span["kind"], attributes: Span["attributes"], fn: () => Promise<T>): Promise<T> {
  const parent = als.getStore();
  if (!parent) return fn();
  const context: Context = { traceId: parent.traceId, spanId: hex(8), sampled: parent.sampled };
  const start = Date.now();
  try {
    const result = await als.run(context, fn);
    record({ traceId: context.traceId, spanId: context.spanId, parentSpanId: parent.spanId, name, kind, startMs: start, durationMs: Date.now() - start, status: "ok", attributes }, context.sampled);
    return result;
  } catch (error) {
    record({ traceId: context.traceId, spanId: context.spanId, parentSpanId: parent.spanId, name, kind, startMs: start, durationMs: Date.now() - start, status: "error", attributes: { ...attributes, "error.type": error instanceof Error ? error.name : "error" } }, context.sampled);
    throw error;
  }
}

/** Express middleware: starts or continues the trace for a request and records its server span. */
export function tracingMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api/") && req.path !== "/metrics") return next();
    const incoming = parseTraceparent(req.get("traceparent"));
    const sampled = incoming ? incoming.sampled : Math.random() < sampleRate();
    const context: Context = { traceId: incoming?.traceId ?? hex(16), spanId: hex(8), sampled };
    const start = Date.now();
    res.setHeader("traceparent", formatTraceparent(context));
    res.on("finish", () => {
      const route = req.route ? `${req.baseUrl}${typeof req.route.path === "string" ? req.route.path : ""}` : "(unmatched)";
      record({ traceId: context.traceId, spanId: context.spanId, parentSpanId: incoming?.parentId, name: `${req.method} ${route.replace(/\/$/, "") || "/"}`, kind: "server", startMs: start, durationMs: Date.now() - start, status: res.statusCode >= 500 ? "error" : "ok", attributes: { "http.method": req.method, "http.route": route, "http.status_code": res.statusCode } }, sampled);
    });
    als.run(context, next);
  };
}

export function spansForTrace(traceId: string): Span[] {
  return spans.filter((s) => s.traceId === traceId).sort((a, b) => a.startMs - b.startMs);
}

export function recentTraces(limit = 50): Array<{ traceId: string; root: string; startMs: number; durationMs: number; spanCount: number; errors: number }> {
  const byTrace = new Map<string, Span[]>();
  for (const s of spans) byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);
  return [...byTrace.entries()]
    .map(([traceId, list]) => {
      const root = list.find((s) => s.kind === "server") ?? list[0];
      return { traceId, root: root.name, startMs: root.startMs, durationMs: root.durationMs, spanCount: list.length, errors: list.filter((s) => s.status === "error").length };
    })
    .sort((a, b) => b.startMs - a.startMs)
    .slice(0, limit);
}

export function resetTracesForTests(): void {
  spans.length = 0;
  exportQueue.length = 0;
}

// ---- OTLP export -------------------------------------------------------------------------------------------

const KIND = { internal: 1, server: 2, client: 3 } as const;
const toNanos = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);
const attr = (key: string, value: string | number | boolean) => ({ key, value: typeof value === "string" ? { stringValue: value } : typeof value === "boolean" ? { boolValue: value } : { intValue: String(Math.trunc(value)) } });

export function toOtlp(batch: Span[], serviceName = process.env.OTEL_SERVICE_NAME ?? "aimltriage") {
  return {
    resourceSpans: [{
      resource: { attributes: [attr("service.name", serviceName), attr("deployment.environment", process.env.NODE_ENV ?? "development")] },
      scopeSpans: [{
        scope: { name: "aimltriage.tracing" },
        spans: batch.map((s) => ({
          traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}), name: s.name, kind: KIND[s.kind],
          startTimeUnixNano: toNanos(s.startMs), endTimeUnixNano: toNanos(s.startMs + s.durationMs),
          attributes: Object.entries(s.attributes).map(([k, v]) => attr(k, v)), status: { code: s.status === "error" ? 2 : 1 }
        }))
      }]
    }]
  };
}

type Poster = (url: string, body: string) => Promise<void>;
let poster: Poster | undefined;
export function setTraceExporterForTests(p: Poster | undefined): void {
  poster = p;
}

export async function flushTraces(): Promise<number> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || exportQueue.length === 0) return 0;
  const batch = exportQueue.splice(0, 500);
  const url = `${endpoint.replace(/\/$/, "")}/v1/traces`;
  const body = JSON.stringify(toOtlp(batch));
  try {
    if (poster) await poster(url, body);
    else {
      const { callExternal } = await import("../integration/externalClient.js");
      await callExternal("otlp", url, { method: "POST", headers: { "content-type": "application/json", ...(process.env.OTEL_EXPORTER_OTLP_HEADERS ? { authorization: process.env.OTEL_EXPORTER_OTLP_HEADERS } : {}) }, body }, { attempts: 1, logPayload: { spans: batch.length } });
    }
    return batch.length;
  } catch {
    exportQueue.unshift(...batch.slice(0, 200)); // keep a bounded backlog for the next try
    return 0;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startTraceExporter(everyMs = 5000): void {
  if (timer || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  timer = setInterval(() => void flushTraces(), everyMs);
  timer.unref?.();
}
