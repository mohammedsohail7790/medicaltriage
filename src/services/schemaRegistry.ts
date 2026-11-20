import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ZodType } from "zod";

// Collects every exported zod schema named *Schema from the source tree. Used by the OpenAPI generator.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "scripts" ? [] : walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

export async function loadSchemaRegistry(srcDir: string): Promise<Record<string, ZodType>> {
  const registry: Record<string, ZodType> = {};
  for (const file of [...walk(path.join(srcDir, "types")), ...walk(path.join(srcDir, "routes")), ...walk(path.join(srcDir, "services"))]) {
    const mod = (await import(file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (name.endsWith("Schema") && value instanceof ZodType) registry[name] = value;
    }
  }
  return registry;
}
