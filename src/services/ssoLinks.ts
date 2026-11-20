// NFR-019: deep links into the application after single sign-on, and one-click transitions to the
// other applications connected to the same identity provider. The return address is validated, never
// trusted: only a path on this application or an address on an explicitly allowed host is accepted.

export type ConnectedApp = { id: string; name: string; launchUrl: string };

const RETURN_TTL_MS = 10 * 60 * 1000;
const pendingReturns = new Map<string, { returnTo: string; expiresAt: number }>();

function allowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.SSO_ALLOWED_RETURN_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
}

export function sanitizeReturnTo(value: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return undefined;
  // A path on this application: one leading slash, no scheme-relative or backslash tricks, no control characters.
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !/[\u0000-\u001f]/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return allowedHosts(env).includes(url.host.toLowerCase()) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function rememberReturn(state: string | null | undefined, returnTo: string | undefined, now = Date.now()): void {
  for (const [key, entry] of pendingReturns) if (entry.expiresAt < now) pendingReturns.delete(key);
  if (state && returnTo) pendingReturns.set(state, { returnTo, expiresAt: now + RETURN_TTL_MS });
}

export function takeReturn(state: string | null | undefined, now = Date.now()): string | undefined {
  if (!state) return undefined;
  const entry = pendingReturns.get(state);
  pendingReturns.delete(state);
  return entry && entry.expiresAt >= now ? entry.returnTo : undefined;
}

export function connectedApps(env: NodeJS.ProcessEnv = process.env): ConnectedApp[] {
  const raw = env.SSO_CONNECTED_APPS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const app = item as Partial<ConnectedApp>;
      if (!app?.id || !app.name || !app.launchUrl) return [];
      const safe = sanitizeReturnTo(app.launchUrl, { ...env, SSO_ALLOWED_RETURN_HOSTS: new URL(app.launchUrl).host } as NodeJS.ProcessEnv);
      return safe && safe.startsWith("https:") ? [{ id: String(app.id), name: String(app.name), launchUrl: safe }] : [];
    });
  } catch {
    return [];
  }
}
