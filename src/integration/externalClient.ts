import { randomUUID } from "node:crypto";
import { startInterfaceLog } from "./interfaceLog.js";

/**
 * The one way the service calls another system (NFR-097, NFR-096).
 *
 * Every outbound interface goes through callExternal, so every one gets the same behaviour:
 *  - retries with exponential back-off on a network error or a 5xx, never on a 4xx (a bad request fails
 *    the same way every time), with a count and delay configurable per integration;
 *  - backpressure: at most N calls in flight per integration, a bounded wait queue behind them, and a
 *    clear refusal beyond that, so a slow downstream system is not choked and cannot exhaust this one;
 *  - a timeout on every call;
 *  - an entry in the interface log before the call is made, and its outcome afterwards.
 *
 * Configuration, per integration NAME (upper case, letters and digits, e.g. EMR_FHIR) or for all:
 *   INTEGRATION_<NAME>_RETRIES, _BACKOFF_MS, _TIMEOUT_MS, _MAX_CONCURRENCY, _MAX_QUEUE
 *   INTEGRATION_DEFAULT_RETRIES (3 attempts), _BACKOFF_MS (250), _TIMEOUT_MS (30000),
 *   _MAX_CONCURRENCY (10), _MAX_QUEUE (100)
 */

export type IntegrationPolicy = { maxAttempts: number; baseDelayMs: number; timeoutMs: number; maxConcurrency: number; maxQueue: number };

const DEFAULTS: IntegrationPolicy = { maxAttempts: 3, baseDelayMs: 250, timeoutMs: 30_000, maxConcurrency: 10, maxQueue: 100 };

function positive(raw: string | undefined, fallback: number, integer = true): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value)) ? value : fallback;
}

export function integrationPolicy(name: string, env: Record<string, string | undefined> = process.env): IntegrationPolicy {
  const key = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const read = (suffix: string, fallback: number, integer = true) => positive(env[`INTEGRATION_${key}_${suffix}`] ?? env[`INTEGRATION_DEFAULT_${suffix}`], fallback, integer);
  return {
    maxAttempts: read("RETRIES", DEFAULTS.maxAttempts),
    baseDelayMs: read("BACKOFF_MS", DEFAULTS.baseDelayMs, false),
    timeoutMs: read("TIMEOUT_MS", DEFAULTS.timeoutMs, false),
    maxConcurrency: read("MAX_CONCURRENCY", DEFAULTS.maxConcurrency),
    maxQueue: read("MAX_QUEUE", DEFAULTS.maxQueue)
  };
}

export class IntegrationBackpressureError extends Error {
  readonly status = 503;
  constructor(readonly integration: string) {
    super(`Too many calls are waiting for ${integration}; try again shortly.`);
    this.name = "IntegrationBackpressureError";
  }
}

type Gate = { active: number; waiting: Array<() => void> };
const gates = new Map<string, Gate>();

async function acquire(name: string, policy: IntegrationPolicy): Promise<() => void> {
  const gate = gates.get(name) ?? { active: 0, waiting: [] };
  gates.set(name, gate);
  const release = () => {
    const next = gate.waiting.shift();
    if (next) next();
    else gate.active -= 1;
  };
  if (gate.active < policy.maxConcurrency) {
    gate.active += 1;
    return release;
  }
  if (gate.waiting.length >= policy.maxQueue) throw new IntegrationBackpressureError(name);
  await new Promise<void>((resolve) => gate.waiting.push(resolve));
  return release;
}

export function integrationLoad(name: string): { active: number; waiting: number } {
  const gate = gates.get(name);
  return { active: gate?.active ?? 0, waiting: gate?.waiting.length ?? 0 };
}

type FetchImpl = (url: string | URL, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchImpl | undefined;
let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function setExternalClientForTests(overrides: { fetch?: FetchImpl; sleep?: (ms: number) => Promise<void> } | undefined): void {
  fetchImpl = overrides?.fetch;
  sleepImpl = overrides?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  gates.clear();
}

export type CallOptions = {
  correlationId?: string;
  /** Overrides the configured attempt count for this call (use 1 where the caller retries itself). */
  attempts?: number;
  /** What to record as the payload in the interface log; defaults to a JSON request body. */
  logPayload?: unknown;
};

export async function callExternal(integration: string, url: string | URL, init: RequestInit = {}, options: CallOptions = {}): Promise<Response> {
  const target = new URL(String(url));
  const policy = integrationPolicy(integration);
  const maxAttempts = options.attempts ?? policy.maxAttempts;
  const correlationId = options.correlationId ?? randomUUID();
  const method = (init.method ?? "GET").toUpperCase();
  let logged: unknown = options.logPayload;
  if (logged === undefined && typeof init.body === "string") {
    try {
      logged = JSON.parse(init.body);
    } catch {
      logged = undefined;
    }
  }
  const done = startInterfaceLog({ direction: "outbound", integration, receiver: target.host, correlationId, method, path: target.pathname, payload: logged });
  let release: (() => void) | undefined;
  let attempts = 0;
  try {
    release = await acquire(integration, policy);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
      try {
        // Headers keep the shape the caller used (a plain object stays a plain object).
        const given = init.headers;
        const hasCorrelation = new Headers(given).has("x-correlation-id");
        const headers: HeadersInit | undefined =
          hasCorrelation ? given : given instanceof Headers ? (() => { const h = new Headers(given); h.set("x-correlation-id", correlationId); return h; })() : Array.isArray(given) ? [...given, ["x-correlation-id", correlationId]] : { ...(given as Record<string, string> | undefined), "x-correlation-id": correlationId };
        const response = await (fetchImpl ?? ((u: string | URL, i: RequestInit) => fetch(u, i)))(url instanceof URL ? url : String(url), { ...init, headers, signal: init.signal ?? controller.signal });
        if (response.status < 500 || attempt === maxAttempts) {
          done({ status: response.status, attempts });
          return response;
        }
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts) throw error;
      } finally {
        clearTimeout(timer);
      }
      await sleepImpl(policy.baseDelayMs * 2 ** (attempt - 1));
    }
    throw lastError;
  } catch (error) {
    done({ attempts, error: error instanceof Error ? error.message : "error" });
    throw error;
  } finally {
    release?.();
  }
}
