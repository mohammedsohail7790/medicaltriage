import { createHash } from "node:crypto";
import { approvedRegions } from "../config/infrastructureGuards.js";
import type { KeyProvider } from "./keyProvider.js";

/**
 * Google Cloud KMS key provider for field-level encryption (M-019, M-020, AI-012).
 *
 * The key-encryption key never leaves Cloud KMS. Each data key is wrapped and unwrapped by a KMS call, so the
 * application holds no key-encryption material. Set:
 *
 *   FIELD_ENCRYPTION_PROVIDER=gcp-kms
 *   FIELD_ENCRYPTION_KMS_KEY=projects/<p>/locations/<region>/keyRings/<ring>/cryptoKeys/<key>
 *   FIELD_ENCRYPTION_KMS_KEY_PREVIOUS=<comma-separated older key names, optional>
 *
 * The name is a crypto key, not a key version: KMS rotates versions inside the key and decrypts with whichever
 * version wrapped the data, so rotation needs no re-wrap. Use the PREVIOUS list only to move to a different key.
 * A Qatar Airways-held key (an external or imported key) is used the same way once it is reachable as a KMS key.
 *
 * Nothing here ever falls back to a local key: if KMS cannot be reached or refuses the call, the operation fails.
 */

export const FIELD_KEY_AAD = "ist-triage-field-data-key-v1";

const KEY_NAME = /^projects\/[^/]+\/locations\/([^/]+)\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;

/** The part of the Cloud KMS client this provider uses, so tests can supply a fake. */
export interface KmsClientLike {
  encrypt(request: { name: string; plaintext: Buffer; additionalAuthenticatedData?: Buffer }): Promise<ReadonlyArray<{ ciphertext?: Uint8Array | string | null }>>;
  decrypt(request: { name: string; ciphertext: Buffer; additionalAuthenticatedData?: Buffer }): Promise<ReadonlyArray<{ plaintext?: Uint8Array | string | null }>>;
}

export class GcpKmsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GcpKmsConfigurationError";
  }
}

export class GcpKmsOperationError extends Error {
  constructor(message: string, readonly causeMessage?: string) {
    super(message);
    this.name = "GcpKmsOperationError";
  }
}

function toBuffer(value: Uint8Array | string | null | undefined, what: string): Buffer {
  if (value === null || value === undefined) throw new GcpKmsOperationError(`Cloud KMS returned no ${what}.`);
  return typeof value === "string" ? Buffer.from(value, "base64") : Buffer.from(value);
}

export function kmsKeyId(keyName: string): string {
  return `gcpkms-${createHash("sha256").update(keyName).digest("hex").slice(0, 12)}`;
}

export function validateKmsKeyName(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const match = KEY_NAME.exec(name.trim());
  if (!match) {
    throw new GcpKmsConfigurationError(
      "FIELD_ENCRYPTION_KMS_KEY must be a Cloud KMS crypto key name (projects/.../locations/.../keyRings/.../cryptoKeys/...), not a key version."
    );
  }
  const approved = approvedRegions(env);
  if (approved.length > 0 && !approved.includes(match[1])) {
    throw new GcpKmsConfigurationError(`The KMS key is in region ${match[1]}, which is not an approved data region.`);
  }
  return name.trim();
}

export type GcpKmsOptions = { keyName: string; previousKeyNames?: string[]; client?: KmsClientLike };

export class GcpKmsKeyProvider implements KeyProvider {
  private readonly keyName: string;
  private readonly previous: string[];
  private client: KmsClientLike | undefined;

  constructor(options: GcpKmsOptions, env: NodeJS.ProcessEnv = process.env) {
    this.keyName = validateKmsKeyName(options.keyName, env);
    this.previous = (options.previousKeyNames ?? []).map((name) => validateKmsKeyName(name, env));
    this.client = options.client;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, client?: KmsClientLike): GcpKmsKeyProvider {
    const keyName = env.FIELD_ENCRYPTION_KMS_KEY?.trim();
    if (!keyName) throw new GcpKmsConfigurationError("FIELD_ENCRYPTION_KMS_KEY is required when FIELD_ENCRYPTION_PROVIDER=gcp-kms.");
    const previousKeyNames = (env.FIELD_ENCRYPTION_KMS_KEY_PREVIOUS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
    return new GcpKmsKeyProvider({ keyName, previousKeyNames, client }, env);
  }

  private async kms(): Promise<KmsClientLike> {
    if (!this.client) {
      const { KeyManagementServiceClient } = await import("@google-cloud/kms");
      this.client = new KeyManagementServiceClient() as unknown as KmsClientLike;
    }
    return this.client;
  }

  activeKeyId(): string {
    return kmsKeyId(this.keyName);
  }

  async wrapKey(dataKey: Buffer): Promise<{ keyId: string; wrapped: string }> {
    try {
      const [response] = await (await this.kms()).encrypt({
        name: this.keyName,
        plaintext: dataKey,
        additionalAuthenticatedData: Buffer.from(FIELD_KEY_AAD)
      });
      return { keyId: kmsKeyId(this.keyName), wrapped: toBuffer(response.ciphertext, "ciphertext").toString("base64url") };
    } catch (error) {
      if (error instanceof GcpKmsOperationError) throw error;
      throw new GcpKmsOperationError("Cloud KMS could not wrap the data key.", error instanceof Error ? error.message : String(error));
    }
  }

  async unwrapKey(keyId: string, wrapped: string): Promise<Buffer> {
    const name = [this.keyName, ...this.previous].find((candidate) => kmsKeyId(candidate) === keyId);
    if (!name) throw new GcpKmsOperationError(`No Cloud KMS key is configured for key id ${keyId}.`);
    try {
      const [response] = await (await this.kms()).decrypt({
        name,
        ciphertext: Buffer.from(wrapped, "base64url"),
        additionalAuthenticatedData: Buffer.from(FIELD_KEY_AAD)
      });
      return toBuffer(response.plaintext, "plaintext");
    } catch (error) {
      if (error instanceof GcpKmsOperationError) throw error;
      throw new GcpKmsOperationError("Cloud KMS could not unwrap the data key.", error instanceof Error ? error.message : String(error));
    }
  }
}
