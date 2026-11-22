import { areDemoCredentialsEnabled, assertRuntimeConfiguration, isMockMode, persistenceConfigurationSummary } from "./runtime.js";

export interface PreflightFinding {
  level: "fail" | "warn";
  check: string;
  detail: string;
}

/**
 * OI-51: one pass over the environment a production deploy will use, reporting every problem
 * together (the startup check stops at the first). Reads configuration only; it connects to nothing.
 */
export function productionPreflight(env: NodeJS.ProcessEnv = process.env): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  const fail = (check: string, detail: string) => out.push({ level: "fail", check, detail });
  const warn = (check: string, detail: string) => out.push({ level: "warn", check, detail });
  const has = (name: string) => Boolean(env[name]?.trim());

  if (env.NODE_ENV !== "production") fail("NODE_ENV", "must be 'production'.");
  if (isMockMode()) fail("MOCK_MODE", "must be false: mock mode serves simulated integrations and demo data.");
  if (areDemoCredentialsEnabled()) fail("ALLOW_DEMO_CREDENTIALS", "demo credentials are enabled.");
  if (env.ALLOW_DEMO_CREDENTIALS?.trim().toLowerCase() === "true") fail("ALLOW_DEMO_CREDENTIALS", "must not be set to true.");

  // The startup assertion covers secrets, database, audit and persistence flags; surface its message.
  try {
    assertRuntimeConfiguration();
  } catch (error) {
    fail("runtime configuration", (error as Error).message.replace(/\n/g, " "));
  }

  const flags = persistenceConfigurationSummary();
  for (const [flag, on] of Object.entries(flags)) if (!on) fail("persistence", `${flag} is not true.`);

  if ((env.FIELD_ENCRYPTION_PROVIDER ?? "").trim().toLowerCase() !== "gcp-kms") {
    warn("field encryption", "FIELD_ENCRYPTION_PROVIDER is not gcp-kms: field keys are held by the application, not the key service.");
  }
  if (env.SCHEDULER_MODE !== "external") {
    warn("scheduler", "SCHEDULER_MODE is not 'external': scheduled jobs and queue workers run inside the API instances.");
  }
  if (!has("CALL_CENTER_GATEWAY_SECRET")) fail("call-centre gateway", "CALL_CENTER_GATEWAY_SECRET is not set; events would be rejected.");
  if (!has("CORS_ALLOWED_ORIGINS")) warn("CORS", "no allowed origins configured.");
  return out;
}
