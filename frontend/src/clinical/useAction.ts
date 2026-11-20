import { useState } from "react";

/** Runs an async action, tracking whether it is busy and the message to show if it fails. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError("");
    try {
      return await action();
    } catch (caught) {
      // A failed fetch means the connection dropped, not that the request was refused: say so, and say the text is kept.
      const offline = caught instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false);
      setError(offline ? "The connection was lost. What you typed is kept on this screen; try again when you are back online." : caught instanceof Error ? caught.message : "The action could not be completed.");
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}
