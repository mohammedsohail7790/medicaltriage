import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getKeyProvider } from "./keyProvider.js";

/**
 * Field-level encryption of personal and clinical data (M-019, M-020).
 *
 * Stored value:  enc:v1:<keyId>:<wrappedDataKey>:<iv>:<tag>:<ciphertext>   (base64url parts)
 *  - AES-256-GCM with a fresh data key per value.
 *  - The data key is wrapped by the key provider (see keyProvider.ts), so keys come
 *    from the configured vault and rotation only re-wraps small keys.
 *  - The column name ("Model.field") is authenticated data, so a ciphertext copied
 *    into a different column fails to decrypt.
 * Values without the prefix are treated as legacy plaintext and returned unchanged,
 * which lets existing rows keep working until they are backfilled.
 */

const PREFIX = "enc:v1:";

export class FieldEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldEncryptionError";
  }
}

export function isEncryptedValue(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export async function encryptText(plaintext: string, context: string): Promise<string> {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const { keyId, wrapped } = await getKeyProvider().wrapKey(dataKey);
  dataKey.fill(0);
  return [PREFIX + keyId, wrapped, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(":");
}

function parts(value: string): { keyId: string; wrapped: string; iv: Buffer; tag: Buffer; body: Buffer } {
  // enc : v1 : keyId : wrappedDataKey : iv : tag : ciphertext
  const segments = value.split(":");
  if (segments.length !== 7 || segments[0] !== "enc" || segments[1] !== "v1" || !segments[2] || !segments[3]) {
    throw new FieldEncryptionError("Malformed encrypted value.");
  }
  return {
    keyId: segments[2],
    wrapped: segments[3],
    iv: Buffer.from(segments[4], "base64url"),
    tag: Buffer.from(segments[5], "base64url"),
    body: Buffer.from(segments[6], "base64url")
  };
}

export async function decryptText(value: string, context: string): Promise<string> {
  try {
    const p = parts(value);
    const dataKey = await getKeyProvider().unwrapKey(p.keyId, p.wrapped);
    const decipher = createDecipheriv("aes-256-gcm", dataKey, p.iv);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(p.tag);
    const plaintext = Buffer.concat([decipher.update(p.body), decipher.final()]).toString("utf8");
    dataKey.fill(0);
    return plaintext;
  } catch (error) {
    // Never include the value or key material in the message.
    throw new FieldEncryptionError(`Could not decrypt ${context}: ${error instanceof FieldEncryptionError ? error.message : "authentication failed or key unavailable"}.`);
  }
}

/** Re-wraps the data key under the provider's active key without touching the data. */
export async function rewrapEncryptedValue(value: string, context: string): Promise<{ value: string; changed: boolean }> {
  const p = parts(value);
  const active = await getKeyProvider().activeKeyId();
  if (p.keyId === active) return { value, changed: false };
  const dataKey = await getKeyProvider().unwrapKey(p.keyId, p.wrapped);
  // Verify the value is authentic under the old wrap before re-wrapping it.
  await decryptText(value, context);
  const next = await getKeyProvider().wrapKey(dataKey);
  dataKey.fill(0);
  return { value: [PREFIX + next.keyId, next.wrapped, value.split(":").slice(4).join(":")].join(":"), changed: true };
}

export type FieldKind = "text" | "json";

/**
 * Personal and clinical columns that are encrypted at rest. None of them is used in a
 * filter, sort or raw query, so encryption does not affect search behaviour.
 * Date-of-birth columns are DateTime and would need a column type change; see the
 * sprint notes.
 */
export const ENCRYPTED_FIELDS: Record<string, Record<string, FieldKind>> = {
  TriageQueueItem: { summary: "text", vitals: "json", clinicalApproval: "json", queuePayload: "json" },
  AviationTriageEncounter: { transcriptText: "text", audioRecordingUrl: "text", clipboardPayload: "json" },
  SafetyAuditDeviationLog: { nurseOverrideRationale: "text" },
  Dependent: { fullName: "text" },
  VoiceAssessmentTurn: {
    transcriptText: "text",
    validationComment: "text",
    structuredAnswer: "json",
    interpreterEvidence: "json",
    nurseCorrectedAnswer: "json"
  },
  CcpDraft: { body: "text" },
  CcpWebhookRecord: { body: "text", queueNote: "text", attachments: "json", rawPayload: "json" }
};

type ModelInfo = Map<string, { kind: string; type: string }>;
let schema: Map<string, ModelInfo> | undefined;

function modelInfo(model: string): ModelInfo | undefined {
  if (!schema) {
    schema = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, new Map(m.fields.map((f) => [f.name, { kind: f.kind, type: f.type }]))]));
  }
  return schema.get(model);
}

function isPlainJson(value: unknown): boolean {
  return Array.isArray(value) || (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype);
}

async function encryptFieldValue(model: string, field: string, kind: FieldKind, value: unknown): Promise<unknown> {
  if (value === undefined || value === null || isEncryptedValue(value)) return value;
  const context = `${model}.${field}`;
  if (kind === "text") {
    if (typeof value === "string") return encryptText(value, context);
    if (typeof value === "object" && value !== null && "set" in value && typeof (value as { set: unknown }).set === "string") {
      return { ...(value as object), set: await encryptText((value as { set: string }).set, context) };
    }
    return value;
  }
  // JSON column: only real JSON values; Prisma.JsonNull / DbNull markers pass through.
  return isPlainJson(value) || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? encryptText(JSON.stringify(value), context)
    : value;
}

/** Encrypts configured fields in a write payload, including nested relation writes. */
export async function encryptWriteData(model: string, data: unknown): Promise<unknown> {
  if (Array.isArray(data)) return Promise.all(data.map((item) => encryptWriteData(model, item)));
  if (typeof data !== "object" || data === null) return data;
  const info = modelInfo(model);
  const fields = ENCRYPTED_FIELDS[model] ?? {};
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    const field = info?.get(key);
    if (fields[key]) {
      out[key] = await encryptFieldValue(model, key, fields[key], value);
    } else if (field?.kind === "object" && typeof value === "object" && value !== null) {
      out[key] = await encryptNestedWrite(field.type, value as Record<string, unknown>);
    }
  }
  return out;
}

async function encryptNestedWrite(model: string, op: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...op };
  const each = async (value: unknown, fn: (entry: Record<string, unknown>) => Promise<unknown>): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map((item) => each(item, fn)));
    return typeof value === "object" && value !== null ? fn(value as Record<string, unknown>) : value;
  };
  // create / createMany take plain data; update, updateMany and upsert wrap it with `data`, `create` or `update`.
  if ("create" in out) out.create = await each(out.create, (entry) => encryptWriteData(model, entry));
  if ("update" in out) {
    out.update = await each(out.update, async (entry) => ("data" in entry ? { ...entry, data: await encryptWriteData(model, entry.data) } : encryptWriteData(model, entry)));
  }
  if ("updateMany" in out) out.updateMany = await each(out.updateMany, async (entry) => ({ ...entry, data: await encryptWriteData(model, entry.data) }));
  if ("upsert" in out) {
    out.upsert = await each(out.upsert, async (entry) => ({ ...entry, create: await encryptWriteData(model, entry.create), update: await encryptWriteData(model, entry.update) }));
  }
  if ("connectOrCreate" in out) {
    out.connectOrCreate = await each(out.connectOrCreate, async (entry) => ({ ...entry, create: await encryptWriteData(model, entry.create) }));
  }
  if ("createMany" in out && typeof out.createMany === "object" && out.createMany !== null) {
    const many = out.createMany as Record<string, unknown>;
    out.createMany = { ...many, data: await encryptWriteData(model, many.data) };
  }
  return out;
}

/** Decrypts configured fields in a query result, including included relations. */
export async function decryptResult(model: string, result: unknown): Promise<unknown> {
  if (Array.isArray(result)) {
    await Promise.all(result.map((item) => decryptResult(model, item)));
    return result;
  }
  if (typeof result !== "object" || result === null) return result;
  const record = result as Record<string, unknown>;
  const info = modelInfo(model);
  const fields = ENCRYPTED_FIELDS[model] ?? {};
  for (const [key, value] of Object.entries(record)) {
    const kind = fields[key];
    if (kind) {
      if (isEncryptedValue(value)) {
        const text = await decryptText(value, `${model}.${key}`);
        record[key] = kind === "json" ? JSON.parse(text) : text;
      }
    } else if (value && typeof value === "object" && info?.get(key)?.kind === "object") {
      await decryptResult(info.get(key)!.type, value);
    }
  }
  return result;
}

const WRITE_OPERATIONS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert"]);

export function fieldEncryptionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.FIELD_ENCRYPTION_ENABLED?.trim().toLowerCase();
  if (env.NODE_ENV === "production") {
    if (flag === "false") throw new Error("FIELD_ENCRYPTION_ENABLED=false is not allowed in production.");
    return true;
  }
  return flag === "true";
}

/** Wraps a Prisma client so configured fields are encrypted on write and decrypted on read. */
export function withFieldEncryption(client: PrismaClient): PrismaClient {
  return client.$extends({
    name: "field-encryption",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          let nextArgs = args as Record<string, unknown>;
          if (WRITE_OPERATIONS.has(operation) && nextArgs) {
            nextArgs = { ...nextArgs };
            if ("data" in nextArgs) nextArgs.data = await encryptWriteData(model, nextArgs.data);
            if (operation === "upsert") {
              nextArgs.create = await encryptWriteData(model, nextArgs.create);
              nextArgs.update = await encryptWriteData(model, nextArgs.update);
            }
          }
          const result = await query(nextArgs);
          return decryptResult(model, result) as Promise<typeof result>;
        }
      }
    }
  }) as unknown as PrismaClient;
}
