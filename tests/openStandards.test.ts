import net from "node:net";
import { KafkaRestBroker, brokerFromEnv, setBrokerPostForTests } from "../src/integration/messageBroker.js";
import { RedisClient, encodeCommand, parseRedisUrl, parseReply } from "../src/integration/redisProtocol.js";
import { CACHE_NAMESPACES, assertCacheableKey, cacheDelete, cacheGetOrSet, cacheStoreName, setCacheClientForTests } from "../src/services/sharedCache.js";

// NFR-076: Kafka-compatible export and a Redis-protocol cache. NFR-121: shared reference caches exclude patient data.

describe("NFR-076 Kafka-compatible export through the Kafka REST Proxy interface", () => {
  afterEach(() => setBrokerPostForTests(undefined));

  it("posts a CloudEvents message as a keyed record in the Kafka REST v2 JSON format", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    setBrokerPostForTests(async (url, init) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    });
    const broker = brokerFromEnv({ MESSAGE_BROKER: "kafka-rest", KAFKA_REST_URL: "https://kafka.example/", KAFKA_REST_TOKEN: "t" });
    expect(broker).toBeInstanceOf(KafkaRestBroker);
    await broker!.publish("triage.completed", { specversion: "1.0", id: "e1" }, { type: "triage.completed" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://kafka.example/topics/aimltriage.triage.completed");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/vnd.kafka.json.v2+json");
    expect(headers.authorization).toBe("Bearer t");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ records: [{ key: "triage.completed", value: { specversion: "1.0", id: "e1" } }] });
  });

  it("raises an error when the proxy refuses, so the durable queue retries", async () => {
    setBrokerPostForTests(async () => new Response("no", { status: 503 }));
    await expect(new KafkaRestBroker("https://kafka.example", "p.").publish("t", {})).rejects.toThrow(/HTTP 503/);
  });

  it("needs an address, and in production https and a token", () => {
    expect(() => brokerFromEnv({ MESSAGE_BROKER: "kafka-rest" })).toThrow(/KAFKA_REST_URL/);
    expect(() => brokerFromEnv({ MESSAGE_BROKER: "kafka-rest", KAFKA_REST_URL: "http://k.example", NODE_ENV: "production" })).toThrow(/https/);
    expect(() => brokerFromEnv({ MESSAGE_BROKER: "kafka-rest", KAFKA_REST_URL: "https://k.example", NODE_ENV: "production" })).toThrow(/TOKEN/);
    expect(() => brokerFromEnv({ MESSAGE_BROKER: "kafka" })).toThrow(/kafka-rest/);
  });
});

describe("NFR-076 Redis-protocol cache: the protocol itself", () => {
  it("encodes commands and parses every reply type, including partial data", () => {
    expect(encodeCommand(["SET", "k", "vé"]).toString()).toBe("*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\nvé\r\n");
    expect(parseReply(Buffer.from("+OK\r\n"))?.value).toBe("OK");
    expect(parseReply(Buffer.from(":42\r\n"))?.value).toBe(42);
    expect(parseReply(Buffer.from("$-1\r\n"))?.value).toBeNull();
    expect((parseReply(Buffer.from("$5\r\nhello\r\n"))?.value as Buffer).toString()).toBe("hello");
    expect(parseReply(Buffer.from("-ERR bad\r\n"))?.value).toBeInstanceOf(Error);
    expect(parseReply(Buffer.from("$5\r\nhel"))).toBeUndefined();
    expect((parseReply(Buffer.from("*2\r\n+a\r\n:1\r\n"))?.value as unknown[]).length).toBe(2);
  });

  it("parses the address, and in production insists on TLS and a password", () => {
    expect(parseRedisUrl("redis://cache.local:6380/2", {})).toMatchObject({ host: "cache.local", port: 6380, tls: false, db: 2 });
    expect(parseRedisUrl("rediss://:p%40ss@cache.local", { NODE_ENV: "production" })).toMatchObject({ tls: true, password: "p@ss", port: 6379 });
    expect(() => parseRedisUrl("redis://cache.local", { NODE_ENV: "production" })).toThrow(/rediss/);
    expect(() => parseRedisUrl("rediss://cache.local", { NODE_ENV: "production" })).toThrow(/password/);
    expect(() => parseRedisUrl("http://x", {})).toThrow(/redis/);
  });
});

describe("NFR-076 Redis-protocol cache against a server that speaks the protocol", () => {
  const store = new Map<string, string>();
  const seen: string[][] = [];
  let server: net.Server;
  let port: number;
  beforeAll(async () => {
    server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const parsed = parseReply(buf);
          if (!parsed) break;
          buf = buf.subarray(parsed.next);
          const args = (parsed.value as Buffer[]).map((b) => b.toString());
          seen.push(args);
          const [cmd, key, value] = args;
          if (cmd === "AUTH") socket.write(key === "secret" ? "+OK\r\n" : "-WRONGPASS invalid\r\n");
          else if (cmd === "SET") {
            store.set(key, value);
            socket.write("+OK\r\n");
          } else if (cmd === "GET") socket.write(store.has(key) ? `$${Buffer.byteLength(store.get(key)!)}\r\n${store.get(key)}\r\n` : "$-1\r\n");
          else if (cmd === "DEL") socket.write(`:${store.delete(key) ? 1 : 0}\r\n`);
          else socket.write("-ERR unknown\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    store.clear();
    seen.length = 0;
  });

  it("sets with a time to live, gets, and deletes", async () => {
    const client = new RedisClient({ host: "127.0.0.1", port, tls: false, password: "secret" });
    await client.set("k", "héllo", 5000);
    expect(await client.get("k")).toBe("héllo");
    expect(seen.find((c) => c[0] === "SET")).toEqual(["SET", "k", "héllo", "PX", "5000"]);
    await client.del("k");
    expect(await client.get("k")).toBeNull();
  });

  it("authenticates, and surfaces a wrong password as an error", async () => {
    await expect(new RedisClient({ host: "127.0.0.1", port, tls: false, password: "wrong" }).get("k")).rejects.toThrow(/WRONGPASS/);
    expect(seen[0]).toEqual(["AUTH", "wrong"]);
  });

  it("fails fast when nothing is listening", async () => {
    await expect(new RedisClient({ host: "127.0.0.1", port: 1, tls: false }, 300).get("k")).rejects.toBeDefined();
  });

  it("is used by the shared cache when configured, and never fails the caller if the cache is down", async () => {
    setCacheClientForTests(new RedisClient({ host: "127.0.0.1", port, tls: false, password: "secret" }));
    let loads = 0;
    const load = async () => {
      loads += 1;
      return { n: 1 };
    };
    expect(await cacheGetOrSet("protocols:test", 5000, load)).toEqual({ n: 1 });
    expect(await cacheGetOrSet("protocols:test", 5000, load)).toEqual({ n: 1 });
    expect(loads).toBe(1);
    expect(store.get("aimltriage:protocols:test")).toBe('{"n":1}');
    await cacheDelete("protocols:test");
    expect(store.size).toBe(0);
    setCacheClientForTests(new RedisClient({ host: "127.0.0.1", port: 1, tls: false }, 200));
    expect(await cacheGetOrSet("protocols:down", 5000, load)).toEqual({ n: 1 });
    setCacheClientForTests(undefined);
  });
});

describe("NFR-121 the shared cache holds reference data only", () => {
  afterEach(() => setCacheClientForTests(undefined));

  it("accepts only reference namespaces and refuses keys that name patient or case data", async () => {
    expect([...CACHE_NAMESPACES]).toEqual(["protocols", "reference", "config"]);
    expect(() => assertCacheableKey("protocols:summary:1")).not.toThrow();
    expect(() => assertCacheableKey("session:abc")).toThrow(/must start with/);
    expect(() => assertCacheableKey("reference:patient-123")).toThrow(/patient/);
    expect(() => assertCacheableKey("config:triage-note")).toThrow(/patient/);
    await expect(cacheGetOrSet("encounter:1", 1000, () => 1)).rejects.toThrow();
  });

  it("uses memory by default and validates the redis settings", async () => {
    expect(cacheStoreName({})).toBe("memory");
    expect(() => cacheStoreName({ CACHE_STORE: "redis" })).toThrow(/REDIS_URL/);
    expect(cacheStoreName({ CACHE_STORE: "redis", REDIS_URL: "redis://c.local" })).toBe("redis");
    expect(() => cacheStoreName({ CACHE_STORE: "x" })).toThrow(/memory or redis/);
    let loads = 0;
    expect(await cacheGetOrSet("reference:memory-test", 5000, () => (loads += 1))).toBe(1);
    expect(await cacheGetOrSet("reference:memory-test", 5000, () => (loads += 1))).toBe(1);
  });
});
