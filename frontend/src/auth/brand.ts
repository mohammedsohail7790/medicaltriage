// OI-39: the product name shown in the page chrome is configurable per customer without a rebuild.
// A deployment sets `window.__APP_BRAND__ = { productName: "Qatar Airways Tele-Triage" }` (for example from a
// config script served beside index.html). Without it the name stays "IST Health". No import.meta, so tests can load it.
type Brand = { productName?: string };

export function productName(): string {
  const configured = (globalThis as { __APP_BRAND__?: Brand }).__APP_BRAND__?.productName?.trim();
  return configured || "IST Health";
}
