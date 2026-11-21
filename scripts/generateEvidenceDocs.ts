import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderDataFlowAssessment, renderIntegrationSpec } from "../src/services/integrationSpecs.js";
import { renderLicenceRegister } from "../src/utils/licenceRegister.js";

const root = process.cwd();
writeFileSync(path.join(root, "docs", "integration-handoff-spec.md"), renderIntegrationSpec());
writeFileSync(path.join(root, "docs", "compliance", "data-flow-assessment.md"), renderDataFlowAssessment());
writeFileSync(path.join(root, "docs", "licences", "component-licence-register.md"), renderLicenceRegister(JSON.parse(readFileSync(path.join(root, "docs", "sbom", "sbom.cdx.json"), "utf8"))));
console.log("Wrote docs/integration-handoff-spec.md, docs/compliance/data-flow-assessment.md and docs/licences/component-licence-register.md");
