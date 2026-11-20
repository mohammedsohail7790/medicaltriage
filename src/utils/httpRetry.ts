import { callExternal } from "../integration/externalClient.js";

// Shared transient-failure retry for outbound HTTP calls (NFR-112, NFR-097). The retry rules are the
// same as before: retry a network error or 5xx, never a 4xx. Retries, back-off, backpressure, timeout and
// the interface log now live in callExternal (src/integration/externalClient.ts), so every outbound
// interface behaves the same and is configurable per integration. Callers need the raw Response back,
// including non-2xx, to build their own provider-specific error message.
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { maxAttempts?: number; baseDelayMs?: number; integration?: string; correlationId?: string } = {}
): Promise<Response> {
  // An explicit maxAttempts still wins for a caller that wants a specific count.
  return callExternal(options.integration ?? new URL(url).host, url, init, { attempts: options.maxAttempts, correlationId: options.correlationId });
}
