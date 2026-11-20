import request from "supertest";
import { createApp } from "../src/app.js";
import { callExternal, IntegrationBackpressureError, integrationLoad, integrationPolicy, setExternalClientForTests } from "../src/integration/externalClient.js";
import { recentInterfaceEntries, redactPayload, resetInterfaceLogForTests, startInterfaceLog } from "../src/integration/interfaceLog.js";
import { fetchWithRetry } from "../src/utils/httpRetry.js";

const reply = (status: number) => new Response(JSON.stringify({ ok: status < 400 }), { status });

describe("NFR-097 retries and backpressure on every outbound interface", () => {
  const originalEnv = { ...process.env };
  const delays: number[] = [];
  beforeEach(() => {
    resetInterfaceLogForTests();
    delays.length = 0;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    setExternalClientForTests(undefined);
  });
  const stub = (responses: Array<number | Error>) => {
    let i = 0;
    const calls: string[] = [];
    setExternalClientForTests({
      fetch: async (url) => {
        calls.push(url);
        const next = responses[Math.min(i++, responses.length - 1)];
        if (next instanceof Error) throw next;
        return reply(next);
      },
      sleep: async (ms) => {
        delays.push(ms);
      }
    });
    return calls;
  };

  it("retries a 5xx and a network error with exponential back-off, then returns the success", async () => {
    const calls = stub([503, new Error("reset"), 200]);
    const response = await callExternal("demo", "https://partner.example/api/items", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([250, 500]);
  });

  it("does not retry a 4xx, which would fail the same way every time", async () => {
    const calls = stub([400, 200]);
    expect((await callExternal("demo", "https://partner.example/x")).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("gives up after the configured number of attempts and returns the last answer or error", async () => {
    process.env.INTEGRATION_DEMO_RETRIES = "2";
    process.env.INTEGRATION_DEMO_BACKOFF_MS = "100";
    const calls = stub([500, 500, 200]);
    expect((await callExternal("demo", "https://partner.example/x")).status).toBe(500);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([100]);
    stub([new Error("down")]);
    await expect(callExternal("demo", "https://partner.example/x")).rejects.toThrow("down");
  });

  it("is configurable per integration, with a default for the rest", () => {
    process.env.INTEGRATION_DEFAULT_RETRIES = "5";
    process.env.INTEGRATION_EMR_FHIR_RETRIES = "2";
    process.env.INTEGRATION_EMR_FHIR_MAX_CONCURRENCY = "3";
    expect(integrationPolicy("emr-fhir")).toMatchObject({ maxAttempts: 2, maxConcurrency: 3 });
    expect(integrationPolicy("twilio")).toMatchObject({ maxAttempts: 5, maxConcurrency: 10 });
    process.env.INTEGRATION_DEFAULT_RETRIES = "zero";
    expect(integrationPolicy("twilio").maxAttempts).toBe(3);
  });

  it("limits calls in flight, queues the next ones, and refuses beyond the queue so a downstream system is not choked", async () => {
    process.env.INTEGRATION_SLOW_MAX_CONCURRENCY = "2";
    process.env.INTEGRATION_SLOW_MAX_QUEUE = "2";
    const releases: Array<() => void> = [];
    let peak = 0;
    let active = 0;
    setExternalClientForTests({
      fetch: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return reply(200);
      }
    });
    const calls = Array.from({ length: 4 }, () => callExternal("slow", "https://partner.example/x", {}, { attempts: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(integrationLoad("slow")).toEqual({ active: 2, waiting: 2 });
    await expect(callExternal("slow", "https://partner.example/x")).rejects.toBeInstanceOf(IntegrationBackpressureError);
    while (releases.length || integrationLoad("slow").active > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all(calls);
    expect(peak).toBe(2);
    expect(integrationLoad("slow")).toEqual({ active: 0, waiting: 0 });
  });

  it("applies the same behaviour through the shared helper used by the messaging adapters", async () => {
    const calls = stub([502, 200]);
    const response = await fetchWithRetry("https://api.twilio.example/messages", { method: "POST", body: "x=1" }, { integration: "twilio" });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(recentInterfaceEntries({ integration: "twilio" })).toHaveLength(1);
  });
});

describe("NFR-096 interface watcher", () => {
  beforeEach(() => resetInterfaceLogForTests());
  afterEach(() => setExternalClientForTests(undefined));

  it("masks sensitive fields, national IDs and long text", () => {
    const redacted = redactPayload({ ok: "fine", password: "p", patient: { fullName: "A B", qid: "28163400000" }, free: "ref 28163400001 here", long: "x".repeat(300), list: [1, 2] }) as Record<string, unknown>;
    expect(redacted.ok).toBe("fine");
    expect(redacted.password).toBe("[redacted]");
    expect((redacted.patient as Record<string, unknown>).fullName).toBe("[redacted]");
    expect(redacted.free).toBe("ref [id] here");
    expect(String(redacted.long)).toMatch(/\[truncated 100\]$/);
    expect(redacted.list).toEqual([1, 2]);
  });

  it("logs an outbound call before it is made, with sender, receiver and correlation id, and records the outcome", async () => {
    let seenBeforeCall = 0;
    setExternalClientForTests({
      fetch: async () => {
        seenBeforeCall = recentInterfaceEntries({ integration: "emr-fhir" }).length;
        return reply(201);
      }
    });
    await callExternal("emr-fhir", "https://emr.example/fhir/DocumentReference?token=abc", { method: "POST", body: JSON.stringify({ patient: { fullName: "Hidden" }, kind: "note" }) }, { correlationId: "corr-1" });
    expect(seenBeforeCall).toBe(1);
    const [entry] = recentInterfaceEntries({ correlationId: "corr-1" });
    expect(entry).toMatchObject({ direction: "outbound", integration: "emr-fhir", sender: "aimltriage", receiver: "emr.example", method: "POST", path: "/fhir/DocumentReference", status: 201, attempts: 1 });
    expect(entry.path).not.toContain("token");
    expect(JSON.stringify(entry.payload)).not.toContain("Hidden");
    expect(entry.timestampIso).toMatch(/^\d{4}-/);
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes the correlation identifier to the other system", async () => {
    let sent: string | null = null;
    setExternalClientForTests({
      fetch: async (_url, init) => {
        sent = new Headers(init.headers).get("x-correlation-id");
        return reply(200);
      }
    });
    await callExternal("demo", "https://partner.example/x", {}, { correlationId: "corr-2" });
    expect(sent).toBe("corr-2");
  });

  it("never lets a logging failure affect the call", async () => {
    process.env.INTERFACE_LOG_DB_PERSISTENCE = "true";
    process.env.DATABASE_URL = "postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1";
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const done = startInterfaceLog({ direction: "inbound", integration: "hrms", receiver: "aimltriage", method: "POST", path: "/x" });
    expect(() => done({ status: 200 })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    errors.mockRestore();
    delete process.env.INTERFACE_LOG_DB_PERSISTENCE;
  });

  it("logs an inbound call before the handler runs, with the correlation id echoed back", async () => {
    const app = createApp();
    const response = await request(app).post("/api/v1/hrms/sync-users").set("X-Correlation-Id", "corr-in-1").send({ users: [], password: "secret-value" });
    expect(response.headers["x-correlation-id"]).toBe("corr-in-1");
    const [entry] = recentInterfaceEntries({ correlationId: "corr-in-1" });
    expect(entry).toMatchObject({ direction: "inbound", integration: "hrms", receiver: "aimltriage", method: "POST", path: "/api/v1/hrms/sync-users" });
    expect(entry.status).toBe(response.status);
    expect(JSON.stringify(entry.payload)).not.toContain("secret-value");
  });
});
