import { isLowBandwidth } from "./lowBandwidth";
const STORAGE_KEY = "ist_triage_access_token";

let currentToken: string | undefined = sessionStorage.getItem(STORAGE_KEY) ?? undefined;

export function getAccessToken(): string | undefined {
  return currentToken;
}

export function setAccessToken(token: string | undefined): void {
  currentToken = token;
  if (token) {
    sessionStorage.setItem(STORAGE_KEY, token);
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

export function clearAccessToken(): void {
  setAccessToken(undefined);
}

/**
 * Firebase Hosting's rewrite-to-Cloud-Run proxy does not forward the Cookie
 * header upstream, so cookie-based sessions never survive past login on
 * custom-domain deployments. Patch the global fetch once at startup to
 * attach the bearer token instead - every existing call site (which already
 * passes credentials:"include" for the cookie path too, kept as a harmless
 * no-op fallback) picks this up with no further changes.
 */
export function installBearerTokenFetch(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const token = getAccessToken();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    // NFR-148: the browser window size is sent as an extra signal for the server's session
    // context check. It is not a credential and is never used on its own to reject a request.
    if (!headers.has("X-Client-Viewport")) {
      headers.set("X-Client-Viewport", `${window.innerWidth}x${window.innerHeight}`);
    }
    // NFR-122: on a slow connection, ask the server for lists without the bulky parts.
    if (isLowBandwidth() && !headers.has("X-Low-Bandwidth")) {
      headers.set("X-Low-Bandwidth", "1");
    }
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return originalFetch(input, { ...init, headers });
  };
}
