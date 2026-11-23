import net from "node:net";
import tls from "node:tls";

/**
 * A small client for the Redis protocol (RESP2), which Redis, Valkey and Google Memorystore all speak. It runs one
 * command per connection, which is plenty for a cache of reference data read a few times a minute, and avoids holding
 * sockets open across Cloud Run instances. It supports AUTH, GET, SET with a time to live, and DEL.
 *
 *   redis://host:6379        plain, for local use only
 *   rediss://:password@host  TLS, required in production (REDIS_CA_CERT adds the server's CA, as Memorystore needs)
 */

export type RedisTarget = { host: string; port: number; tls: boolean; password?: string; db?: number };

export function parseRedisUrl(raw: string, env: Record<string, string | undefined> = process.env): RedisTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("REDIS_URL is not a valid URL.");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("REDIS_URL must start with redis:// or rediss://.");
  const secure = url.protocol === "rediss:";
  if (env.NODE_ENV === "production" && !secure) throw new Error("REDIS_URL must use rediss:// (TLS) in production.");
  if (env.NODE_ENV === "production" && !url.password) throw new Error("REDIS_URL must carry a password in production.");
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined;
  return { host: url.hostname, port: Number(url.port) || 6379, tls: secure, password: url.password ? decodeURIComponent(url.password) : undefined, db: Number.isInteger(db) ? db : undefined };
}

export type RespValue = string | number | null | Buffer | RespValue[] | Error;

/** Parses one reply from the start of the buffer. Returns undefined if the reply is not complete yet. */
export function parseReply(buf: Buffer, offset = 0): { value: RespValue; next: number } | undefined {
  if (offset >= buf.length) return undefined;
  const type = String.fromCharCode(buf[offset]);
  const lineEnd = buf.indexOf("\r\n", offset);
  if (lineEnd === -1) return undefined;
  const line = buf.toString("utf8", offset + 1, lineEnd);
  const afterLine = lineEnd + 2;
  if (type === "+") return { value: line, next: afterLine };
  if (type === "-") return { value: new Error(line), next: afterLine };
  if (type === ":") return { value: Number(line), next: afterLine };
  if (type === "$") {
    const length = Number(line);
    if (length === -1) return { value: null, next: afterLine };
    if (buf.length < afterLine + length + 2) return undefined;
    return { value: buf.subarray(afterLine, afterLine + length), next: afterLine + length + 2 };
  }
  if (type === "*") {
    const count = Number(line);
    if (count === -1) return { value: null, next: afterLine };
    const items: RespValue[] = [];
    let cursor = afterLine;
    for (let i = 0; i < count; i++) {
      const item = parseReply(buf, cursor);
      if (!item) return undefined;
      items.push(item.value);
      cursor = item.next;
    }
    return { value: items, next: cursor };
  }
  throw new Error(`Unexpected reply from the cache: ${type}`);
}

function command(target: RedisTarget, commands: Array<Array<string | number>>, timeoutMs: number, ca?: string): Promise<RespValue[]> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.concat(commands.map(encodeCommand));
    const socket: net.Socket = target.tls ? tls.connect({ host: target.host, port: target.port, servername: target.host, ca: ca ? [ca] : undefined }) : net.connect({ host: target.host, port: target.port });
    let received = Buffer.alloc(0);
    const replies: RespValue[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(replies);
    };
    const timer = setTimeout(() => finish(new Error("The cache did not answer in time.")), timeoutMs);
    socket.on(target.tls ? "secureConnect" : "connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      for (;;) {
        const parsed = parseReply(received);
        if (!parsed) break;
        replies.push(parsed.value);
        received = received.subarray(parsed.next);
        if (replies.length === commands.length) return finish();
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("The cache closed the connection early.")));
  });
}

export function encodeCommand(args: Array<string | number>): Buffer {
  const out: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const value = Buffer.from(String(arg));
    out.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from("\r\n"));
  }
  return Buffer.concat(out);
}

export class RedisClient {
  constructor(private readonly target: RedisTarget, private readonly timeoutMs = 1500, private readonly ca = process.env.REDIS_CA_CERT) {}

  private async run(cmd: Array<string | number>): Promise<RespValue> {
    const prefix: Array<Array<string | number>> = [];
    if (this.target.password) prefix.push(["AUTH", this.target.password]);
    if (this.target.db !== undefined) prefix.push(["SELECT", this.target.db]);
    const replies = await command(this.target, [...prefix, cmd], this.timeoutMs, this.ca);
    for (const reply of replies) if (reply instanceof Error) throw reply;
    return replies[replies.length - 1];
  }

  async get(key: string): Promise<string | null> {
    const value = await this.run(["GET", key]);
    return value === null ? null : Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.run(["SET", key, value, "PX", Math.max(1, Math.floor(ttlMs))]);
  }

  async del(key: string): Promise<void> {
    await this.run(["DEL", key]);
  }
}
