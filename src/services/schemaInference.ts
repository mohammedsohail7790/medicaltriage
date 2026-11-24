// NFR-164: describes a JSON value as a JSON schema, and merges what several observations of the same answer show.
export type Json = Record<string, unknown>;

export function inferSchema(value: unknown): Json {
  if (value === null) return { nullable: true };
  if (Array.isArray(value)) return value.length === 0 ? { type: "array", items: {} } : { type: "array", items: value.map(inferSchema).reduce(mergeSchemas) };
  switch (typeof value) {
    case "string": return { type: "string" };
    case "number": return { type: Number.isInteger(value) ? "integer" : "number" };
    case "boolean": return { type: "boolean" };
    case "object": {
      const properties: Record<string, Json> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) properties[k] = inferSchema(v);
      return { type: "object", properties, required: Object.keys(properties).sort() };
    }
    default: return {};
  }
}

export function mergeSchemas(a: Json, b: Json): Json {
  if (Object.keys(a).length === 0) return b;
  if (Object.keys(b).length === 0) return a;
  if (a.nullable && !a.type) return { ...b, nullable: true };
  if (b.nullable && !b.type) return { ...a, nullable: true };
  const numeric = (t: unknown) => t === "integer" || t === "number";
  if (a.type !== b.type && !(numeric(a.type) && numeric(b.type))) return { description: "Varies between answers.", oneOf: [a, b] };
  if (a.type === "object") {
    const pa = (a.properties ?? {}) as Record<string, Json>;
    const pb = (b.properties ?? {}) as Record<string, Json>;
    const properties: Record<string, Json> = {};
    for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) properties[k] = k in pa && k in pb ? mergeSchemas(pa[k], pb[k]) : (pa[k] ?? pb[k]);
    const ra = new Set((a.required as string[]) ?? []);
    const rb = new Set((b.required as string[]) ?? []);
    return { type: "object", properties, required: [...ra].filter((k) => rb.has(k)).sort() };
  }
  if (a.type === "array") return { type: "array", items: mergeSchemas((a.items ?? {}) as Json, (b.items ?? {}) as Json) };
  return { ...a, ...(a.type === "integer" && b.type === "number" ? { type: "number" } : {}), ...(a.nullable || b.nullable ? { nullable: true } : {}) };
}
