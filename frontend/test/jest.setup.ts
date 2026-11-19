import "@testing-library/jest-dom";
import { webcrypto } from "node:crypto";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

// jsdom does not provide these; the sign-in code (security check, form encryption) needs them.
for (const [name, value] of [
  ["TextEncoder", NodeTextEncoder],
  ["TextDecoder", NodeTextDecoder],
  ["crypto", webcrypto]
] as const) {
  const existing = (globalThis as Record<string, unknown>)[name] as { subtle?: unknown } | undefined;
  if (existing === undefined || (name === "crypto" && !existing.subtle)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
}
