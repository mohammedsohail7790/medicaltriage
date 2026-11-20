import { callExternal } from "../integration/externalClient.js";

// NFR-090: every external system the platform talks to, whether it is configured, and whether it runs
// live or as a dry run. An integration is live only when it is configured AND explicitly set to live
// (INTEGRATION_<NAME>_MODE=live, a deployment setting under change control). Anything else is a dry run, so
// a half-configured or newly added integration can never send real traffic by accident.

export type IntegrationDefinition = {
  name: string;
  label: string;
  requiredConfig: string[];
  anyOfConfig?: string[][];
  probeUrlFrom?: string;
  dependsOn: "customer" | "platform";
};

export const INTEGRATIONS: IntegrationDefinition[] = [
  { name: "qhie", label: "Qatar Health Information Exchange", requiredConfig: ["QHIE_BASE_URL", "QHIE_ACCESS_TOKEN"], probeUrlFrom: "QHIE_BASE_URL", dependsOn: "customer" },
  { name: "emr-fhir", label: "EMR (FHIR write-back)", requiredConfig: ["FHIR_BASE_URL", "FHIR_ACCESS_TOKEN"], probeUrlFrom: "FHIR_BASE_URL", dependsOn: "customer" },
  { name: "oracle-hcm", label: "Oracle Fusion HCM directory", requiredConfig: ["ORACLE_HEALTH_BASE_URL"], probeUrlFrom: "ORACLE_HEALTH_BASE_URL", dependsOn: "customer" },
  { name: "dlp", label: "Data-loss-prevention service", requiredConfig: ["EXPORT_DLP_URL"], probeUrlFrom: "EXPORT_DLP_URL", dependsOn: "customer" },
  { name: "archive-handoff", label: "Archive system", requiredConfig: ["ARCHIVE_HANDOFF_URL", "ARCHIVE_HANDOFF_SECRET"], probeUrlFrom: "ARCHIVE_HANDOFF_URL", dependsOn: "customer" },
  { name: "captcha", label: "CAPTCHA provider", requiredConfig: ["CAPTCHA_PROVIDER"], anyOfConfig: [["CAPTCHA_SECRET", "CAPTCHA_SELF_DIFFICULTY"]], dependsOn: "platform" },
  { name: "message-broker", label: "Message broker", requiredConfig: ["MESSAGE_BROKER"], dependsOn: "platform" },
  { name: "audit-sink", label: "Audit forwarding sinks (SIEM)", requiredConfig: ["AUDIT_FORWARD_SINKS"], dependsOn: "customer" },
  { name: "twilio", label: "Twilio messaging", requiredConfig: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"], dependsOn: "platform" },
  { name: "msgraph-mail", label: "Microsoft Graph mail", requiredConfig: ["MSGRAPH_CLIENT_ID", "MSGRAPH_CLIENT_SECRET"], dependsOn: "platform" }
];

export type IntegrationStatus = {
  name: string;
  label: string;
  configured: boolean;
  missingConfig: string[];
  mode: "live" | "dry-run";
  dependsOn: "customer" | "platform";
  canProbe: boolean;
};

const present = (env: NodeJS.ProcessEnv, key: string) => Boolean(env[key] && env[key]!.trim());

export function integrationStatus(def: IntegrationDefinition, env: NodeJS.ProcessEnv = process.env): IntegrationStatus {
  const missing = def.requiredConfig.filter((key) => !present(env, key));
  for (const group of def.anyOfConfig ?? []) if (!group.some((key) => present(env, key))) missing.push(group.join(" or "));
  const envName = `INTEGRATION_${def.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_MODE`;
  const configured = missing.length === 0;
  return {
    name: def.name,
    label: def.label,
    configured,
    missingConfig: missing,
    mode: configured && env[envName] === "live" ? "live" : "dry-run",
    dependsOn: def.dependsOn,
    canProbe: Boolean(def.probeUrlFrom && present(env, def.probeUrlFrom))
  };
}

export function integrationRegistry(env: NodeJS.ProcessEnv = process.env): IntegrationStatus[] {
  return INTEGRATIONS.map((def) => integrationStatus(def, env));
}

export function isLive(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const def = INTEGRATIONS.find((item) => item.name === name);
  return Boolean(def && integrationStatus(def, env).mode === "live");
}

export type ProbeResult = { name: string; reachable: boolean; httpStatus?: number; latencyMs: number; error?: string };

/** Connectivity test: a single, unretried GET of the configured base address. It never sends clinical data. */
export async function probeIntegration(name: string, env: NodeJS.ProcessEnv = process.env): Promise<ProbeResult> {
  const def = INTEGRATIONS.find((item) => item.name === name);
  if (!def) throw new Error("Unknown integration");
  const status = integrationStatus(def, env);
  if (!status.configured || !def.probeUrlFrom || !present(env, def.probeUrlFrom)) throw new Error("Integration is not configured for a connectivity test");
  const started = Date.now();
  try {
    const response = await callExternal(name, env[def.probeUrlFrom]!, { method: "GET" }, { attempts: 1 });
    return { name, reachable: true, httpStatus: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { name, reachable: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 200) : "failed" };
  }
}
