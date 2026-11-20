// Tests must be deterministic regardless of a developer's local .env content-source
// choice (used only to switch the dev server/demo between the embedded sample, the
// generated STCC-shaped corpus, and the open-source-rules/guidelines modules). Pin the
// test run to the embedded 6-protocol sample so fixtures like "sample-fever-child" /
// "sample-ankle-foot-injury" always resolve.
// loadLocalEnv() (src/config/env.ts) only fills in keys that are `undefined` in
// process.env, so pinned keys must be explicitly set (even to "") rather than
// deleted - deleting lets a later loadLocalEnv() call refill them from .env.
process.env.CLINICAL_CONTENT_USE_GENERATED_STCC = "false";
process.env.CLINICAL_CONTENT_PACKAGE_PATH = "";
process.env.CLINICAL_CONTENT_SOURCE = "";
// Same reasoning: queue persistence must stay in-memory for tests regardless
// of a developer's local .env choice to run the live app against Cloud SQL.
process.env.QUEUE_DB_PERSISTENCE = "false";

// Diagnostic for intermittent 404s: whenever a test request is answered 404, record whether the application itself answered
// (it always sets X-Request-Id and X-Powered-By) and what the body was, so a stray 404 can be traced to its source.
import SupertestTest from "supertest/lib/test.js";

const supertestPrototype = (SupertestTest as unknown as { prototype: { assert: (e: unknown, res: { status?: number; headers?: Record<string, string>; text?: string } | undefined, fn: unknown) => unknown; method?: string; url?: string } }).prototype;
const originalAssert = supertestPrototype.assert;
supertestPrototype.assert = function (this: { method?: string; url?: string }, resError, res, fn) {
  if (res && res.status === 404) {
    console.warn(
      JSON.stringify({
        type: "test_404",
        method: this.method,
        path: String(this.url ?? "").replace(/^https?:\/\/[^/]+/, ""),
        appAnswered: Boolean(res.headers?.["x-request-id"]),
        contentType: res.headers?.["content-type"] ?? null,
        body: String(res.text ?? "").slice(0, 200)
      })
    );
  }
  return originalAssert.call(this, resError, res, fn);
};

// Root cause of the long-standing intermittent 404 and "socket hang up" failures in the full suite.
// supertest starts a throw-away server per request with listen(0), which binds every address (the IPv6 wildcard). On macOS
// that bind can succeed on a port number another program on the same machine already uses on 127.0.0.1 only (for example
// a desktop app's local helper). A request to 127.0.0.1:<that port> then reaches the other program, which answers
// "404 not found" (as plain text, with no X-Request-Id) or hangs up. Binding the test servers to 127.0.0.1 makes the
// operating system pick a port that is free on that address, so no other program can share it.
import net from "node:net";

const originalListen = net.Server.prototype.listen as (this: net.Server, ...args: unknown[]) => net.Server;
// supertest reads the address straight after listen(0), so the bind must be synchronous: a handle bound to 127.0.0.1 is made
// first and given to the server (listen(0, "127.0.0.1") would look the host up and finish later).
const createServerHandle = (net as unknown as { _createServerHandle?: (address: string, port: number, family: number, fd?: number, flags?: number) => unknown })._createServerHandle;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
  if (createServerHandle && args[0] === 0 && (args.length === 1 || typeof args[1] === "function")) {
    const handle = createServerHandle("127.0.0.1", 0, 4, undefined, 0);
    if (handle && typeof handle === "object") return originalListen.call(this, { handle }, ...args.slice(1));
  }
  return originalListen.call(this, ...args);
} as typeof net.Server.prototype.listen;
