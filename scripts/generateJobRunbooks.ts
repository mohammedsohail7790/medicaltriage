import { writeFileSync } from "node:fs";
import path from "node:path";
import { renderRunbooks } from "../src/services/jobRunbooks.js";

writeFileSync(path.resolve(process.cwd(), "docs", "operations", "job-runbooks.md"), renderRunbooks());
console.log("Wrote docs/operations/job-runbooks.md");
