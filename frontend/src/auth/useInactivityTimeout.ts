import { useEffect, useRef } from "react";

// NFR-145: signs the user out after a period of inactivity and keeps the server-side
// session alive while the user is actually working. Real input (pointer, keys, scroll,
// touch) counts as activity; background polling does not. The server enforces the same
// timeout, so this only makes the sign-out prompt instead of waiting for the next call.

const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "scroll", "touchstart", "wheel"] as const;
const DEFAULT_IDLE_SECONDS = 15 * 60;

type Options = {
  enabled: boolean;
  apiBase: string;
  onTimeout: () => void;
  /** Overrides the value reported by the server; used by tests. */
  idleSecondsOverride?: number;
};

export function useInactivityTimeout({ enabled, apiBase, onTimeout, idleSecondsOverride }: Options): void {
  const timeoutRef = useRef(onTimeout);
  timeoutRef.current = onTimeout;

  useEffect(() => {
    if (!enabled) return undefined;
    let idleSeconds = idleSecondsOverride ?? DEFAULT_IDLE_SECONDS;
    let lastActivity = Date.now();
    let lastPing = 0;
    let activeSincePing = false;
    let stopped = false;

    const markActive = () => {
      lastActivity = Date.now();
      activeSincePing = true;
    };
    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, markActive, { passive: true }));

    if (idleSecondsOverride === undefined) {
      fetch(`${apiBase}/api/v1/auth/session`, { credentials: "include" })
        .then((response) => (response.ok ? response.json() : undefined))
        .then((payload) => {
          if (!stopped && payload && typeof payload.idleTimeoutSeconds === "number" && payload.idleTimeoutSeconds > 0) {
            idleSeconds = payload.idleTimeoutSeconds;
          }
        })
        .catch(() => undefined);
    }

    const handle = window.setInterval(() => {
      const now = Date.now();
      if (now - lastActivity >= idleSeconds * 1000) {
        stopped = true;
        window.clearInterval(handle);
        timeoutRef.current();
        return;
      }
      // Tell the server the user is still working, at most about three times per timeout.
      const pingEvery = Math.min(60_000, (idleSeconds * 1000) / 3);
      if (activeSincePing && now - lastPing >= pingEvery) {
        activeSincePing = false;
        lastPing = now;
        fetch(`${apiBase}/api/v1/auth/activity`, { method: "POST", credentials: "include" })
          .then((response) => {
            if (response.status === 401 && !stopped) {
              stopped = true;
              window.clearInterval(handle);
              timeoutRef.current();
            }
          })
          .catch(() => undefined);
      }
    }, Math.max(250, Math.min(5000, (idleSeconds * 1000) / 10)));

    return () => {
      stopped = true;
      window.clearInterval(handle);
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, markActive));
    };
  }, [enabled, apiBase, idleSecondsOverride]);
}
