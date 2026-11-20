import { useEffect, useState } from "react";

/** Slow-connection support (NFR-122): detection, and drafts that survive a dropped connection or a reload. */

type Connection = { saveData?: boolean; effectiveType?: string };

export function isLowBandwidth(nav: { connection?: Connection } = typeof navigator === "undefined" ? {} : (navigator as unknown as { connection?: Connection })): boolean {
  const c = nav.connection;
  return Boolean(c && (c.saveData || c.effectiveType === "slow-2g" || c.effectiveType === "2g"));
}

const PREFIX = "ist_draft:";

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // Storage can be blocked; the form still works, it just cannot keep a draft.
  }
}

/**
 * Text that is kept on this device as it is typed, so a dropped connection, a failed send or an accidental reload does
 * not lose it. Clear it once the text has been sent. Only what the nurse typed is stored, under a key naming the case.
 */
export function useDraft(key: string, initial = ""): [string, (value: string) => void, () => void] {
  const [value, setValue] = useState<string>(() => safeGet(key) ?? initial);
  useEffect(() => {
    safeSet(key, value && value !== initial ? value : null);
  }, [key, value, initial]);
  return [value, setValue, () => { safeSet(key, null); setValue(initial); }];
}

export function useLowBandwidth(): boolean {
  const [low, setLow] = useState(() => isLowBandwidth());
  useEffect(() => {
    const connection = (navigator as unknown as { connection?: Connection & { addEventListener?: (e: string, f: () => void) => void; removeEventListener?: (e: string, f: () => void) => void } }).connection;
    const update = () => setLow(isLowBandwidth());
    connection?.addEventListener?.("change", update);
    return () => connection?.removeEventListener?.("change", update);
  }, []);
  return low;
}
