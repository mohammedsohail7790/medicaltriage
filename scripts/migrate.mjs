// NFR-153: run database migrations with the migration role, not the runtime role.
//   MIGRATION_DATABASE_URL=postgresql://aimltriage_migration:...@host/db?sslmode=require node scripts/migrate.mjs
import { spawnSync } from "node:child_process";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL is not set. Migrations must run with the migration role, not the runtime role.");
  process.exit(1);
}
if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) {
  console.error("MIGRATION_DATABASE_URL and DATABASE_URL are the same. Use two different roles.");
  process.exit(1);
}
const result = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
process.exit(result.status ?? 1);
