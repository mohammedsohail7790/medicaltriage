// NFR-164: generates docs/openapi.json from the routes the application really registers (Express router
// introspection) with request schemas derived from the zod validators the handlers run.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../src/app.js";
import { mkdirSync } from "node:fs";
import { buildAsyncApi, buildGatewayDefinition } from "../src/services/gatewayDefinition.js";
import { generateOpenApiFromApp } from "../src/services/openApiGenerator.js";
import { loadSchemaRegistry } from "../src/services/schemaRegistry.js";

process.env.MOCK_MODE ??= "true";
const srcDir = path.resolve(process.cwd(), "src");
const { spec, stats } = generateOpenApiFromApp(createApp(), srcDir, await loadSchemaRegistry(srcDir), {
  title: "IST Health Tele-Triage API",
  version: "1.0.0",
  description:
    "Generated from the routes the application registers and the zod request validators its handlers run " +
    "(scripts/generateOpenApiSpec.ts). Request bodies and query parameters are described by schema; responses are described by status class."
});
const outPath = path.resolve(process.cwd(), "docs", "openapi.json");
writeFileSync(outPath, JSON.stringify(spec, null, 2) + "\n", "utf8");
console.log(`Wrote ${outPath}: ${stats.operations} operations, ${stats.withRequestSchema} with request schemas, unresolved: ${stats.unresolvedSchemas.join(", ") || "none"}.`);

mkdirSync(path.resolve(process.cwd(), "docs", "gateway"), { recursive: true });
writeFileSync(path.resolve(process.cwd(), "docs", "gateway", "gateway-definition.json"), JSON.stringify(buildGatewayDefinition(spec as never, "https://<backend-service-url>"), null, 2) + "\n", "utf8");
writeFileSync(path.resolve(process.cwd(), "docs", "asyncapi.json"), JSON.stringify(buildAsyncApi("1.0.0"), null, 2) + "\n", "utf8");
console.log("Wrote docs/gateway/gateway-definition.json and docs/asyncapi.json.");
