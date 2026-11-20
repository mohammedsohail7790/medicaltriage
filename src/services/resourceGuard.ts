import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

/**
 * How hard this instance is working (NFR-039). When it is under pressure, non-critical work (scheduled reports,
 * exports, housekeeping) is queued for later so clinical requests keep their share of the instance.
 */

const histogram = monitorEventLoopDelay({ resolution: 20 });
let started = false;
function ensureStarted(): void {
  if (!started) {
    histogram.enable();
    started = true;
  }
}

export type ResourceStatus = { eventLoopLagMs: number; heapUsedRatio: number; activeRequests: number; constrained: boolean; reasons: string[] };

let activeRequests = 0;
export function trackRequestStart(): void {
  activeRequests += 1;
}
export function trackRequestEnd(): void {
  activeRequests = Math.max(0, activeRequests - 1);
}

export function resourceLimits(env: NodeJS.ProcessEnv = process.env) {
  return {
    eventLoopLagMs: Number(env.RESOURCE_MAX_EVENT_LOOP_LAG_MS ?? 200),
    heapUsedRatio: Number(env.RESOURCE_MAX_HEAP_RATIO ?? 0.85),
    activeRequests: Number(env.RESOURCE_MAX_ACTIVE_REQUESTS ?? 200)
  };
}

let override: Partial<ResourceStatus> | undefined;
export function setResourceStatusForTests(value: Partial<ResourceStatus> | undefined): void {
  override = value;
}

export function resourceStatus(env: NodeJS.ProcessEnv = process.env): ResourceStatus {
  ensureStarted();
  const limits = resourceLimits(env);
  const memory = process.memoryUsage();
  const limitBytes = (heapLimitBytes() || memory.heapTotal);
  const measured = {
    eventLoopLagMs: Math.round((histogram.mean / 1e6) * 10) / 10 || 0,
    heapUsedRatio: Math.round((memory.heapUsed / limitBytes) * 1000) / 1000,
    activeRequests
  };
  const merged = { ...measured, ...override };
  const reasons: string[] = [];
  if (merged.eventLoopLagMs > limits.eventLoopLagMs) reasons.push(`event loop lag ${merged.eventLoopLagMs} ms`);
  if (merged.heapUsedRatio > limits.heapUsedRatio) reasons.push(`memory ${Math.round(merged.heapUsedRatio * 100)}% of the limit`);
  if (merged.activeRequests > limits.activeRequests) reasons.push(`${merged.activeRequests} requests in flight`);
  return { ...merged, constrained: reasons.length > 0, reasons };
}

function heapLimitBytes(): number {
  try {
    return (process as unknown as { constrainedMemory?: () => number }).constrainedMemory?.() || getHeapStatistics().heap_size_limit;
  } catch {
    return 0;
  }
}

export const isConstrained = (): boolean => resourceStatus().constrained;

/** Express middleware: counts requests in flight, for the resource picture. */
export function requestCounter() {
  return (_req: unknown, res: { on: (event: string, cb: () => void) => void }, next: () => void) => {
    trackRequestStart();
    let done = false;
    const end = () => {
      if (!done) {
        done = true;
        trackRequestEnd();
      }
    };
    res.on("finish", end);
    res.on("close", end);
    next();
  };
}
