// NFR-156: Software Bill of Materials in CycloneDX 1.5 (JSON), generated from the installed production dependency tree.
// Run with `pnpm sbom`; attach docs/sbom/sbom.cdx.json to every tagged release.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const raw = execFileSync("npx", ["--yes", "pnpm@10.34.9", "list", "--prod", "--json", "--depth", "Infinity"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const tree = JSON.parse(raw)[0];

const components = new Map();
const edges = new Map();

function licenseOf(dir) {
  try {
    const file = path.join(dir, "package.json");
    if (!existsSync(file)) return undefined;
    const p = JSON.parse(readFileSync(file, "utf8"));
    const l = typeof p.license === "string" ? p.license : p.license?.type ?? (Array.isArray(p.licenses) ? p.licenses.map((x) => x.type).join(" OR ") : undefined);
    if (l) return l;
    // A package with no licence field but a LICENSE file: read the file's opening words (recorded as read from the file).
    const licenceFile = readdirSync(dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
    if (licenceFile) {
      const head = readFileSync(path.join(dir, licenceFile), "utf8").slice(0, 400).toLowerCase();
      if (head.includes("mit license") || head.includes("permission is hereby granted, free of charge")) return "MIT";
      if (head.includes("apache license")) return "Apache-2.0";
      if (head.includes("isc license")) return "ISC";
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function refFor(name, version) {
  return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
}

function walk(deps, parentRef) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    const version = info.version;
    if (!version || String(version).startsWith("link:")) continue;
    const ref = refFor(name, version);
    if (!components.has(ref)) {
      const license = licenseOf(info.path ?? "");
      components.set(ref, {
        type: "library", "bom-ref": ref, name, version, purl: ref, scope: "required",
        ...(license ? { licenses: [{ expression: license }] } : {})
      });
      edges.set(ref, new Set());
      walk(info.dependencies, ref);
    }
    edges.get(parentRef)?.add(ref);
  }
}

const appRef = `pkg:npm/${pkg.name}@${pkg.version}`;
edges.set(appRef, new Set());
walk(tree.dependencies, appRef);

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: "application", name: "aimltriage-sbom-generator", version: "1.0.0" }] },
    component: { type: "application", "bom-ref": appRef, name: pkg.name, version: pkg.version }
  },
  components: [...components.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
  dependencies: [...edges.entries()].map(([ref, set]) => ({ ref, dependsOn: [...set].sort() }))
};

const out = path.join(root, "docs", "sbom");
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "sbom.cdx.json"), JSON.stringify(bom, null, 2) + "\n");
console.log(`Wrote docs/sbom/sbom.cdx.json: ${bom.components.length} components, ${bom.components.filter((c) => c.licenses).length} with a licence.`);
