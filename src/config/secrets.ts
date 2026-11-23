import { randomBytes } from "node:crypto";

/**
 * Central access point for signing and encryption secrets (M-039).
 *
 * - No secret has a default value in code. In production a missing secret is a
 *   startup failure that names the variable, never its value.
 * - Outside production (local development and tests) a missing secret is replaced
 *   by a random value generated once per process, so nothing guessable can ever
 *   sign a token or encrypt data.
 * - A SecretProvider can be installed to read from another store (for example the
 *   Qatar Airways vault). The default provider reads environment variables, which
 *   is how Cloud Run injects values from Secret Manager.
 * - Rotation: NAME holds the current value and NAME_PREVIOUS holds one or more
 *   earlier values (comma separated). New material is signed or encrypted with the
 *   current value; verification and decryption also accept the previous ones.
 */

export interface SecretProvider {
  get(name: string): string | undefined;
}

class EnvironmentSecretProvider implements SecretProvider {
  get(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
  }
}

let provider: SecretProvider = new EnvironmentSecretProvider();
const ephemeral = new Map<string, string>();

const PLACEHOLDER_PATTERNS = [/^mock-dev-only/i, /^replace-with/i, /^changeme/i, /^change-me/i];

export class SecretConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretConfigurationError";
  }
}

export function setSecretProvider(next: SecretProvider): void {
  provider = next;
  ephemeral.clear();
}

export function resetSecretProvider(): void {
  provider = new EnvironmentSecretProvider();
  ephemeral.clear();
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

export function requireSecret(name: string): string {
  const configured = provider.get(name);
  if (configured) {
    if (isProduction() && looksLikePlaceholder(configured)) {
      throw new SecretConfigurationError(`${name} holds a placeholder value; configure a real secret.`);
    }
    return configured;
  }
  if (isProduction()) {
    throw new SecretConfigurationError(`${name} is required in production and is not configured.`);
  }
  let generated = ephemeral.get(name);
  if (!generated) {
    generated = randomBytes(32).toString("hex");
    ephemeral.set(name, generated);
  }
  return generated;
}

/** Current secret first, then any NAME_PREVIOUS values, for verification and decryption. */
export function secretVersions(name: string): string[] {
  const current = requireSecret(name);
  const previous = (provider.get(`${name}_PREVIOUS`) ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== current);
  return [current, ...previous];
}

/** Names that must be configured before the service starts in production. */
export const REQUIRED_PRODUCTION_SECRETS = ["AUTH_JWT_SECRET", "MFA_ENCRYPTION_KEY", "FIELD_ENCRYPTION_KEY"] as const;

/** With FIELD_ENCRYPTION_PROVIDER=gcp-kms or fortanix the field key lives in a key service, so no local field key is needed. */
function fieldProvider(): string {
  return (process.env.FIELD_ENCRYPTION_PROVIDER ?? "").trim().toLowerCase();
}
function fieldKeyHeldInKms(): boolean {
  return fieldProvider() === "gcp-kms" || fieldProvider() === "fortanix";
}

export function missingProductionSecrets(): string[] {
  const missing: string[] = REQUIRED_PRODUCTION_SECRETS.filter((name) => {
    if (name === "FIELD_ENCRYPTION_KEY" && fieldKeyHeldInKms()) return false;
    const value = provider.get(name);
    return !value || looksLikePlaceholder(value);
  });
  if (fieldProvider() === "gcp-kms" && !process.env.FIELD_ENCRYPTION_KMS_KEY?.trim()) missing.push("FIELD_ENCRYPTION_KMS_KEY");
  if (fieldProvider() === "fortanix") {
    for (const name of ["FORTANIX_ENDPOINT"]) if (!process.env[name]?.trim()) missing.push(name);
    if (!process.env.FORTANIX_KEY_ID?.trim() && !process.env.FORTANIX_KEY_NAME?.trim()) missing.push("FORTANIX_KEY_ID");
    const apiKey = provider.get("FORTANIX_API_KEY");
    if (!apiKey || looksLikePlaceholder(apiKey)) missing.push("FORTANIX_API_KEY");
  }
  return missing;
}
