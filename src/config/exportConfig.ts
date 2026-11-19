// Startup validation for export settings (M-021). Kept free of service imports so runtime.ts can use it.

export function validateExportDlpConfiguration(env: Record<string, string | undefined> = process.env): void {
  const url = env.EXPORT_DLP_URL?.trim();
  if (!url) return;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("EXPORT_DLP_URL is not a valid URL.");
  }
  if (target.protocol !== "https:" && !(env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(target.hostname))) {
    throw new Error("EXPORT_DLP_URL must use https.");
  }
  if (env.NODE_ENV === "production" && !env.EXPORT_DLP_SECRET?.trim()) {
    throw new Error("EXPORT_DLP_SECRET is required when EXPORT_DLP_URL is configured.");
  }
}
