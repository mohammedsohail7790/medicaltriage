import { writeFileSync } from "node:fs";
import path from "node:path";
import { renderCatalogue, scanErrorCodes } from "../src/utils/errorCodeScan.js";

const codes = scanErrorCodes();
writeFileSync(path.resolve(process.cwd(), "docs", "operations", "error-catalogue.md"), renderCatalogue(codes));
console.log(`Wrote docs/operations/error-catalogue.md: ${codes.length} codes.`);
