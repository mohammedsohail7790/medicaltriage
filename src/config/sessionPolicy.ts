// Session timing policy shared by the session store and its persistence layer (NFR-145).

function minutes(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Inactivity period after which a session ends. SESSION_IDLE_TIMEOUT_MINUTES, 15 by default. */
export function sessionIdleTimeoutMs(): number {
  return minutes("SESSION_IDLE_TIMEOUT_MINUTES", 15) * 60 * 1000;
}
