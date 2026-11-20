// NFR-100: the supported-component inventory with lifecycle reviews. Reads docs/operations/component-lifecycle.json and the
// versions actually in use, and writes docs/supported-components.md. Run with `pnpm inventory` at each release.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const life = JSON.parse(readFileSync(path.join(root, "docs", "operations", "component-lifecycle.json"), "utf8"));
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
const dockerNode = /FROM node:(\d+)/.exec(dockerfile)?.[1];

function used(name) {
  if (name === "node") return `${dockerNode ?? "unknown"} (container), ${process.versions.node.split(".")[0]} (this machine)`;
  if (name === "postgresql") return "16 (test and target database)";
  const range = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
  return range ?? "not a direct dependency";
}

const rows = life.components.map((c) => `| ${c.name} | ${c.kind} | ${used(c.name)} | ${c.track} | ${c.status} | ${c.supportedUntil} | ${c.action} |`);
const md = `# Supported-component inventory

Reviewed on ${life.reviewedOn}. ${life.note}

| Component | Kind | In use | Tracked major | Status | Supported until | Action |
|---|---|---|---|---|---|---|
${rows.join("\n")}

Review this table at every release and again before go-live. A component whose status is not "supported" or "long-term-support" has an action that must be closed or accepted in writing by the security owner.
`;
writeFileSync(path.join(root, "docs", "supported-components.md"), md);
console.log(`Wrote docs/supported-components.md (${life.components.length} components).`);
