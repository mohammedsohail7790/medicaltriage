import { Prisma } from "@prisma/client";
import { parquetWriteBuffer } from "hyparquet-writer";
import { basePrisma, prisma } from "../db.js";
import type { AuthenticatedSession } from "../types/security.js";
import { classifyField } from "./dataCatalogue.js";
import { organizationWhereClause } from "./tenantScope.js";

/**
 * Data portability and incremental extraction (NFR-169, NFR-050).
 *
 * Qatar Airways can take all customer data, configuration and operational history in open formats at
 * any time: JSON, CSV and Parquet. Each dataset can be taken in full or incrementally: a request
 * returns only the rows added or changed since a token, in a stable order, so a consumer that stores
 * the last token never re-reads or misses a row. Rows deleted softly come through with deletedAt set;
 * rows purged by retention appear in the archived-records dataset, which acts as the list of deletions.
 * Passwords, keys and tokens are never exported.
 */

export type DatasetKind = "data" | "configuration" | "history";
type DatasetDefinition = { name: string; model: string; kind: DatasetKind; description: string; tenantScoped?: boolean };

export const DATASETS: DatasetDefinition[] = [
  { name: "queue-items", model: "TriageQueueItem", kind: "data", description: "Queue cases: calls, vitals, protocol, disposition, approval", tenantScoped: true },
  { name: "encounters", model: "AviationTriageEncounter", kind: "data", description: "Completed clinical encounters", tenantScoped: true },
  { name: "staff", model: "StaffMember", kind: "data", description: "Staff members seen by the service", tenantScoped: true },
  { name: "dependents", model: "Dependent", kind: "data", description: "Dependents of staff members" },
  { name: "users", model: "ApplicationUser", kind: "configuration", description: "Application users (no credentials)", tenantScoped: true },
  { name: "roles", model: "Role", kind: "configuration", description: "Roles" },
  { name: "permissions", model: "Permission", kind: "configuration", description: "Permissions" },
  { name: "retention-policies", model: "RetentionPolicy", kind: "configuration", description: "Retention policies per data type" },
  { name: "password-policy", model: "PasswordPolicy", kind: "configuration", description: "Password policy for local accounts" },
  { name: "queue-transitions", model: "QueueTransitionLog", kind: "history", description: "Signed log of every queue state change" },
  { name: "safety-logs", model: "SafetyAuditDeviationLog", kind: "history", description: "Safety audit and approval trace per encounter" },
  { name: "audit-events", model: "AuditEvent", kind: "history", description: "The hash-chained audit ledger, with before and after values" },
  { name: "archived-records", model: "ArchivedRecord", kind: "history", description: "Records removed by retention (also the list of purged rows)" }
];

const CURSOR_PREFERENCE = ["sequenceNumber", "updatedAt", "timestamp", "createdAt", "archivedAt", "receivedAt", "persistedAt", "requestedAt"];

type Shape = { model: string; pk: string; cursor: string; cursorType: string; columns: Array<{ name: string; type: string }> };
const shapes = new Map<string, Shape>();

export function datasetShape(name: string): { definition: DatasetDefinition; shape: Shape } {
  const definition = DATASETS.find((d) => d.name === name);
  if (!definition) throw new ExtractionError(404, "Unknown dataset.", "DATASET_UNKNOWN");
  let shape = shapes.get(definition.model);
  if (!shape) {
    const meta = Prisma.dmmf.datamodel.models.find((m) => m.name === definition.model)!;
    const scalar = meta.fields.filter((f) => f.kind !== "object");
    const cursor = CURSOR_PREFERENCE.map((c) => scalar.find((f) => f.name === c)).find(Boolean);
    if (!cursor) throw new Error(`Dataset ${name} has no field to order extraction by.`);
    shape = {
      model: definition.model,
      pk: scalar.find((f) => f.isId)?.name ?? "id",
      cursor: cursor.name,
      cursorType: cursor.type,
      // Passwords, keys, tokens and session secrets are never exported.
      columns: scalar.filter((f) => classifyField(definition.model, f.name).classification !== "credential").map((f) => ({ name: f.name, type: f.kind === "enum" ? "String" : f.type }))
    };
    shapes.set(definition.model, shape);
  }
  return { definition, shape };
}

export class ExtractionError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

// ---- tokens ------------------------------------------------------------------------------------

type Position = { c: string; i: string };
export function encodeToken(position: Position): string {
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}
export function decodeToken(token: string): Position {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Position;
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string") throw new Error();
    return parsed;
  } catch {
    throw new ExtractionError(400, "The token is not valid.", "TOKEN_INVALID");
  }
}

const cursorValue = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const parseCursor = (type: string, text: string): unknown => (type === "DateTime" ? new Date(text) : type === "BigInt" ? BigInt(text) : text);

// ---- a page of rows ------------------------------------------------------------------------------

export type ExtractedPage = { dataset: string; columns: Shape["columns"]; rows: Array<Record<string, unknown>>; nextToken: string | null; hasMore: boolean };

export async function extractPage(args: { dataset: string; since?: string; limit?: number; session?: AuthenticatedSession }): Promise<ExtractedPage> {
  const { definition, shape } = datasetShape(args.dataset);
  const limit = Math.min(Math.max(args.limit ?? 1000, 1), 10_000);
  const tenant = definition.tenantScoped && args.session ? organizationWhereClause(args.session) : undefined;
  const conditions: Array<Record<string, unknown>> = tenant ? [tenant] : [];
  if (args.since) {
    const position = decodeToken(args.since);
    const value = parseCursor(shape.cursorType, position.c);
    conditions.push(
      shape.cursor === shape.pk || shape.cursorType === "BigInt"
        ? { [shape.cursor]: { gt: value } }
        : { OR: [{ [shape.cursor]: { gt: value } }, { AND: [{ [shape.cursor]: value }, { [shape.pk]: { gt: position.i } }] }] }
    );
  }
  const delegate = (prisma as unknown as Record<string, { findMany(a: unknown): Promise<Array<Record<string, unknown>>> }>)[definition.model.charAt(0).toLowerCase() + definition.model.slice(1)];
  // The extended client decrypts protected fields and, for soft-deletable types, would hide deleted rows; ask for them explicitly.
  const softDeletable = shape.columns.some((c) => c.name === "deletedAt");
  // Naming deletedAt (even as undefined, which Prisma ignores) tells the soft-delete layer not to hide deleted rows.
  const where = { AND: conditions, ...(softDeletable ? { deletedAt: undefined } : {}) };
  const rows = await delegate.findMany({ where, orderBy: shape.cursor === shape.pk || shape.cursorType === "BigInt" ? [{ [shape.cursor]: "asc" }] : [{ [shape.cursor]: "asc" }, { [shape.pk]: "asc" }], take: limit + 1 });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const allowed = new Set(shape.columns.map((c) => c.name));
  const clean = page.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => allowed.has(key)).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])));
  const last = page[page.length - 1];
  return {
    dataset: args.dataset,
    columns: shape.columns,
    rows: clean,
    nextToken: last ? encodeToken({ c: cursorValue(last[shape.cursor]), i: String(last[shape.pk]) }) : (args.since ?? null),
    hasMore
  };
}

// ---- formats ---------------------------------------------------------------------------------------

const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function toCsv(page: ExtractedPage): string {
  const header = page.columns.map((c) => c.name).join(",");
  return [header, ...page.rows.map((row) => page.columns.map((c) => csvCell(row[c.name])).join(","))].join("\n") + "\n";
}

const PARQUET_TYPES: Record<string, string> = { String: "STRING", Int: "INT32", Float: "DOUBLE", Decimal: "DOUBLE", Boolean: "BOOLEAN", DateTime: "TIMESTAMP", Json: "JSON", BigInt: "STRING" };

export function toParquet(page: ExtractedPage): Buffer {
  const columnData = page.columns.map((column) => {
    const type = PARQUET_TYPES[column.type] ?? "STRING";
    return {
      name: column.name,
      type,
      data: page.rows.map((row) => {
        const value = row[column.name];
        if (value === null || value === undefined) return null;
        if (type === "JSON") return JSON.stringify(value);
        if (type === "TIMESTAMP") return value instanceof Date ? value : new Date(String(value));
        if (type === "STRING") return typeof value === "object" ? JSON.stringify(value) : String(value);
        return value;
      })
    };
  });
  return Buffer.from(parquetWriteBuffer({ columnData: columnData as never }));
}

// ---- per-consumer position -----------------------------------------------------------------------------

export async function storedToken(consumer: string, dataset: string): Promise<string | undefined> {
  return (await basePrisma.extractionCursor.findUnique({ where: { consumer_dataset: { consumer, dataset } } }))?.token;
}

export async function acknowledgeToken(consumer: string, dataset: string, token: string): Promise<void> {
  datasetShape(dataset);
  decodeToken(token);
  await basePrisma.extractionCursor.upsert({ where: { consumer_dataset: { consumer, dataset } }, create: { consumer, dataset, token }, update: { token } });
}

export function listDatasets() {
  return DATASETS.map((definition) => {
    const { shape } = datasetShape(definition.name);
    return { name: definition.name, kind: definition.kind, description: definition.description, orderedBy: shape.cursor, columns: shape.columns.length, tenantScoped: Boolean(definition.tenantScoped), formats: ["json", "csv", "parquet"] };
  });
}
