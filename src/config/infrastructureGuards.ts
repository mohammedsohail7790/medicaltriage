/**
 * Startup checks that tie the application to the infrastructure it is deployed on (Sprint 7). They apply in production
 * only, and each failure names the setting, never a value.
 *   data residency   every region the deployment says it uses must be one Qatar Airways approved (M-028, NFR-063, NFR-087-089)
 *   database in transit   the database connection must use TLS (M-018, AI-013)
 *   sign-in          once single sign-on is enforced, local passwords are refused except for named break-glass accounts (NFR-151)
 */

export class InfrastructureConfigurationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Infrastructure configuration is not acceptable: ${problems.join(" ")}`);
    this.name = "InfrastructureConfigurationError";
  }
}

const list = (value: string | undefined) => (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);

export function approvedRegions(env: NodeJS.ProcessEnv = process.env): string[] {
  return list(env.APPROVED_DATA_REGIONS);
}

const REGION_SETTINGS = ["DATA_REGION", "BACKUP_REGION", "DR_REGION", "LOG_REGION", "KMS_REGION", "SECRETS_REGION"] as const;

export function residencyProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const approved = approvedRegions(env);
  const problems: string[] = [];
  const declared = REGION_SETTINGS.filter((name) => env[name]?.trim());
  if (declared.length > 0 && approved.length === 0) problems.push("APPROVED_DATA_REGIONS must list the approved regions when a region is declared.");
  for (const name of declared) {
    const regions = list(env[name]);
    const outside = regions.filter((r) => !approved.includes(r));
    if (outside.length > 0) problems.push(`${name} names a region that is not approved.`);
  }
  return problems;
}

export function databaseTransportProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const url = env.DATABASE_URL;
  if (!url) return [];
  // A Cloud SQL unix-socket connection is encrypted by the connector itself.
  if (/[?&]host=\/cloudsql\//.test(url) || /@\/[^?]*\?host=/.test(url)) return [];
  const mode = /[?&]sslmode=([a-z-]+)/i.exec(url)?.[1]?.toLowerCase();
  if (mode && ["require", "verify-ca", "verify-full"].includes(mode)) return [];
  return ["DATABASE_URL must require TLS (sslmode=require, verify-ca or verify-full)."];
}

export function validateInfrastructureConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const problems = [...residencyProblems(env), ...databaseTransportProblems(env)];
  if (problems.length > 0) throw new InfrastructureConfigurationError(problems);
}

// ---- NFR-151 ---------------------------------------------------------------------------------------

export function ssoEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SSO_ENFORCED === "true";
}

export function breakGlassUsers(env: NodeJS.ProcessEnv = process.env): string[] {
  return list(env.BREAK_GLASS_USERS).map((u) => u.toLowerCase());
}

/** With SSO enforced only the named break-glass accounts may use a local password. */
export function localLoginAllowed(username: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !ssoEnforced(env) || breakGlassUsers(env).includes(username.trim().toLowerCase());
}
