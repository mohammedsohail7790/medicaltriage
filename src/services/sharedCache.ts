import { RedisClient, parseRedisUrl } from "../integration/redisProtocol.js";

/**
 * Shared cache for reference and configuration data (NFR-121, NFR-076). By default each instance keeps its own memory
 * cache. With CACHE_STORE=redis and REDIS_URL, instances share one Redis-protocol cache (Memorystore, Redis or Valkey).
 *
 * Patient data never goes in it: only keys under an allowed namespace are accepted, and every namespace is reference or
 * configuration data. If the shared cache cannot be reached the value is loaded from the source, so the cache can slow a
 * request but never fail it.
 */

export const CACHE_NAMESPACES = ["protocols", "reference", "config"] as const;
const FORBIDDEN = /(patient|encounter|queue|triage|note|sbar|nurse|caller|case)/i;

export function assertCacheableKey(key: string): void {
  const namespace = key.split(":")[0];
  if (!(CACHE_NAMESPACES as readonly string[]).includes(namespace)) throw new Error(`Cache keys must start with one of ${CACHE_NAMESPACES.join(", ")}.`);
  if (FORBIDDEN.test(key)) throw new Error("Cache keys must not name patient or case data.");
}

export function cacheStoreName(env: Record<string, string | undefined> = process.env): "memory" | "redis" {
  const configured = env.CACHE_STORE?.trim().toLowerCase();
  if (configured === "redis") {
    if (!env.REDIS_URL?.trim()) throw new Error("REDIS_URL is required when CACHE_STORE=redis.");
    parseRedisUrl(env.REDIS_URL, env);
    return "redis";
  }
  if (configured && configured !== "memory") throw new Error("CACHE_STORE must be memory or redis.");
  return "memory";
}

const memory = new Map<string, { value: string; expires: number }>();
let client: RedisClient | undefined;
let override: Pick<RedisClient, "get" | "set" | "del"> | undefined;
export function setCacheClientForTests(fake: Pick<RedisClient, "get" | "set" | "del"> | undefined): void {
  override = fake;
  memory.clear();
}
const remote = () => override ?? (client ??= new RedisClient(parseRedisUrl(process.env.REDIS_URL!)));

export async function cacheGetOrSet<T>(key: string, ttlMs: number, load: () => Promise<T> | T): Promise<T> {
  assertCacheableKey(key);
  const useRedis = override ? true : cacheStoreName() === "redis";
  if (useRedis) {
    try {
      const hit = await remote().get(`aimltriage:${key}`);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch {
      // fall through to the source
    }
    const value = await load();
    try {
      await remote().set(`aimltriage:${key}`, JSON.stringify(value), ttlMs);
    } catch {
      // the next request will load it again
    }
    return value;
  }
  const hit = memory.get(key);
  if (hit && hit.expires > Date.now()) return JSON.parse(hit.value) as T;
  const value = await load();
  memory.set(key, { value: JSON.stringify(value), expires: Date.now() + ttlMs });
  return value;
}

export async function cacheDelete(key: string): Promise<void> {
  assertCacheableKey(key);
  memory.delete(key);
  if (override || cacheStoreName() === "redis") await remote().del(`aimltriage:${key}`).catch(() => undefined);
}
