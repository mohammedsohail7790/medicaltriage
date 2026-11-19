import { CompactEncrypt, importJWK } from "jose";

// NFR-146: builds the sign-in request. When the server publishes an encryption key, the form
// (user name, password and the rest) is encrypted to it together with a one-time nonce and a
// timestamp, so the request body is unreadable and cannot be replayed. The address can be
// moved per environment, so it is taken from the server rather than hard-coded.

type LoginEncryptionContext = {
  kid: string;
  publicJwk: Record<string, unknown>;
  nonce: string;
  path: string;
};

export type LoginRequest = { url: string; body: string };

export async function buildLoginRequest(apiBase: string, form: Record<string, unknown>): Promise<LoginRequest> {
  const plain: LoginRequest = { url: `${apiBase}/api/v1/auth/login`, body: JSON.stringify(form) };
  let context: LoginEncryptionContext | null = null;
  try {
    const response = await fetch(`${apiBase}/api/v1/auth/login-config`, { cache: "no-store" });
    if (response.ok) context = ((await response.json()) as { loginEncryption?: LoginEncryptionContext | null }).loginEncryption ?? null;
  } catch {
    // Without the published key the plain form is sent; the server refuses it if encryption is required.
  }
  if (!context) return plain;

  const key = await importJWK(context.publicJwk as Parameters<typeof importJWK>[0], "ECDH-ES+A256KW");
  const encrypted = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({ ...form, nonce: context.nonce, iat: Date.now() })))
    .setProtectedHeader({ alg: "ECDH-ES+A256KW", enc: "A256GCM", kid: context.kid })
    .encrypt(key);
  return { url: `${apiBase}${context.path}`, body: JSON.stringify({ encrypted }) };
}
