import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { basePrisma } from "../db.js";

/**
 * The interface watcher (NFR-096). Every inbound and outbound call is logged before it is processed, with
 * timestamp, integration name, sender, receiver and correlation identifier, and a redacted copy of the
 * payload. The log is independent of processing: writing it is fire-and-forget and a failure to write it
 * is reported but never delays or fails the call it describes.
 *
 * INTERFACE_LOG_DB_PERSISTENCE=true keeps it in PostgreSQL (the default in production); otherwise the last
 * 500 entries are kept in memory.
 */

const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|api[_-]?key|credential|cookie|otp|signature|ssn|national|qid|birth|dob|email|mobile|phone|name|address|narrative|transcript|note|summary|vitals?|diagnos|symptom|payload|body|text)/i;
const QID = /\b\d{11}\b/g;
const MAX_STRING = 200;
const MAX_DEPTH = 6;

/** A copy of a payload that is safe to keep: sensitive fields, national IDs and long text are masked. */
export function redactPayload(value: unknown, depth = 0, key = ""): unknown {
  if (value === null || value === undefined) return value;
  if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    const masked = value.replace(QID, "[id]");
    return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}...[truncated ${masked.length - MAX_STRING}]` : masked;
  }
  if (typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactPayload(item, depth + 1, key));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 60).map(([k, v]) => [k, redactPayload(v, depth + 1, k)]));
}

export type InterfaceEntry = {
  id: string;
  timestampIso: string;
  direction: "inbound" | "outbound";
  integration: string;
  sender: string;
  receiver: string;
  correlationId: string;
  method: string;
  path: string;
  payload: unknown;
  status?: number;
  durationMs?: number;
  attempts?: number;
  error?: string;
};

const SELF = "aimltriage";
const memory: InterfaceEntry[] = [];
const MEMORY_LIMIT = 500;

function persistent(): boolean {
  const flag = process.env.INTERFACE_LOG_DB_PERSISTENCE?.trim().toLowerCase();
  return flag ? flag === "true" : process.env.NODE_ENV === "production";
}

function remember(entry: InterfaceEntry): void {
  memory.push(entry);
  if (memory.length > MEMORY_LIMIT) memory.shift();
}

export function recentInterfaceEntries(filter: { integration?: string; correlationId?: string; limit?: number } = {}): InterfaceEntry[] {
  return memory
    .filter((e) => (!filter.integration || e.integration === filter.integration) && (!filter.correlationId || e.correlationId === filter.correlationId))
    .slice(-(filter.limit ?? 100))
    .reverse();
}
export function resetInterfaceLogForTests(): void {
  memory.length = 0;
}

function swallow(operation: string, error: unknown): void {
  console.error(JSON.stringify({ type: "interface_log_failed", operation, error: error instanceof Error ? error.name : "error" }));
}

/** Logs the start of a call and returns a function that records how it ended. Never throws. */
export function startInterfaceLog(args: {
  direction: "inbound" | "outbound";
  integration: string;
  sender?: string;
  receiver: string;
  correlationId?: string;
  method: string;
  path: string;
  payload?: unknown;
}): (result: { status?: number; attempts?: number; error?: string }) => void {
  const started = Date.now();
  const entry: InterfaceEntry = {
    id: randomUUID(),
    timestampIso: new Date(started).toISOString(),
    direction: args.direction,
    integration: args.integration,
    sender: args.sender ?? (args.direction === "outbound" ? SELF : "unknown"),
    receiver: args.receiver,
    correlationId: args.correlationId ?? randomUUID(),
    method: args.method,
    path: args.path,
    payload: args.payload === undefined ? undefined : redactPayload(args.payload)
  };
  remember(entry);
  const created = persistent()
    ? basePrisma.interfaceLog
        .create({ data: { id: entry.id, direction: entry.direction, integration: entry.integration, sender: entry.sender, receiver: entry.receiver, correlationId: entry.correlationId, method: entry.method, path: entry.path, payload: (entry.payload ?? undefined) as never } })
        .catch((error) => swallow("create", error))
    : Promise.resolve();
  return (result) => {
    entry.status = result.status;
    entry.attempts = result.attempts;
    entry.error = result.error;
    entry.durationMs = Date.now() - started;
    if (persistent()) {
      void created.then(() =>
        basePrisma.interfaceLog
          .update({ where: { id: entry.id }, data: { status: result.status ?? null, durationMs: entry.durationMs, attempts: result.attempts ?? null, error: result.error?.slice(0, 500) ?? null } })
          .catch((error) => swallow("update", error))
      );
    }
  };
}

/** Express middleware: logs an inbound call to `integration` before the handler runs. */
export function interfaceWatcher(integration: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const correlationId = String(req.headers["x-correlation-id"] ?? req.headers["x-request-id"] ?? res.getHeader("x-request-id") ?? randomUUID());
    res.setHeader("X-Correlation-Id", correlationId);
    const done = startInterfaceLog({
      direction: "inbound",
      integration,
      sender: String(req.headers["x-forwarded-for"] ?? req.ip ?? "unknown").split(",")[0].trim(),
      receiver: SELF,
      correlationId,
      method: req.method,
      path: req.baseUrl + req.path,
      payload: req.body && Object.keys(req.body).length > 0 ? req.body : undefined
    });
    res.on("finish", () => done({ status: res.statusCode }));
    next();
  };
}
