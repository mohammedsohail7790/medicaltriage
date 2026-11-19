/**
 * Encrypts existing plaintext values and re-wraps data keys after a key rotation
 * (M-019, M-020). Works on the raw database values, in batches, and is safe to run
 * repeatedly: values that are already encrypted under the active key are skipped.
 *
 * Dry run by default; pass --execute to write.
 *
 * Usage:
 *   npx tsx src/scripts/encryptStoredFields.ts                 # report what would change
 *   npx tsx src/scripts/encryptStoredFields.ts --execute       # encrypt plaintext
 *   npx tsx src/scripts/encryptStoredFields.ts --execute --rewrap   # also move data keys to the active key
 *   npx tsx src/scripts/encryptStoredFields.ts --models=TriageQueueItem,Dependent
 *
 * Rotation procedure: set the new secret as FIELD_ENCRYPTION_KEY and the old one in
 * FIELD_ENCRYPTION_KEY_PREVIOUS, deploy, run with --execute --rewrap, then remove the
 * previous key once the report shows nothing left to rewrap.
 */
import { Prisma } from "@prisma/client";
import { basePrisma } from "../db.js";
import { ENCRYPTED_FIELDS, encryptText, isEncryptedValue, rewrapEncryptedValue } from "../services/fieldEncryption.js";

const execute = process.argv.includes("--execute");
const rewrap = process.argv.includes("--rewrap");
const modelsArg = process.argv.find((arg) => arg.startsWith("--models="))?.split("=")[1];
const batchSize = Number(process.argv.find((arg) => arg.startsWith("--batch-size="))?.split("=")[1] ?? "200");

type Delegate = {
  findMany(args: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  update(args: Record<string, unknown>): Promise<unknown>;
};

async function main() {
  const wanted = modelsArg ? new Set(modelsArg.split(",")) : undefined;
  const summary: Record<string, { scanned: number; encrypted: number; rewrapped: number }> = {};

  for (const [model, fields] of Object.entries(ENCRYPTED_FIELDS)) {
    if (wanted && !wanted.has(model)) continue;
    const meta = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
    if (!meta?.fields.some((f) => f.name === "id" && f.isId)) throw new Error(`${model} has no id field; cannot batch.`);
    const delegate = (basePrisma as unknown as Record<string, Delegate>)[model.charAt(0).toLowerCase() + model.slice(1)];
    const stats = (summary[model] = { scanned: 0, encrypted: 0, rewrapped: 0 });
    let cursor: string | undefined;
    for (;;) {
      const rows = await delegate.findMany({ take: batchSize, orderBy: { id: "asc" }, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) });
      if (rows.length === 0) break;
      for (const row of rows) {
        stats.scanned += 1;
        const data: Record<string, unknown> = {};
        for (const [field, kind] of Object.entries(fields)) {
          const value = row[field];
          if (value === null || value === undefined) continue;
          const context = `${model}.${field}`;
          if (isEncryptedValue(value)) {
            if (!rewrap) continue;
            const next = await rewrapEncryptedValue(value, context);
            if (next.changed) {
              data[field] = next.value;
              stats.rewrapped += 1;
            }
          } else {
            data[field] = await encryptText(kind === "json" ? JSON.stringify(value) : String(value), context);
            stats.encrypted += 1;
          }
        }
        if (execute && Object.keys(data).length > 0) await delegate.update({ where: { id: row.id }, data });
      }
      cursor = String(rows[rows.length - 1].id);
    }
  }
  console.log(JSON.stringify({ mode: execute ? "EXECUTE" : "DRY RUN", rewrap, summary }, null, 2));
  await basePrisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
