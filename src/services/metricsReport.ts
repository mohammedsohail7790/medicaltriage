import { collectMetrics } from "../observability/metrics.js";
import { getEmailAdapter } from "./communicationAdapters.js";
import { getThresholds, evaluate } from "./performanceMonitor.js";
import { usageInsights } from "./usageInsights.js";

/** The key-metrics email (NFR-105): plain text, counts only, sent to approved recipient domains. */

export function allowedReportDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.REPORT_ALLOWED_RECIPIENT_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
}

export async function buildReport(kind: "usage" | "performance"): Promise<{ subject: string; body: string }> {
  if (kind === "usage") {
    const day = new Date(Date.now() - 86_400_000).toISOString();
    const i = await usageInsights({ sinceIso: day });
    return {
      subject: "AiMlTriage daily usage summary",
      body: [`Events in the last 24 hours: ${i.window.events}`, `Active users: ${i.users.total}`, `Error rate: ${(i.errors.rate * 100).toFixed(1)}%`, `Busiest hours (UTC): ${i.peakHours.map((h) => `${h.hourUtc}:00 (${h.events})`).join(", ") || "none"}`, `Most used areas: ${i.byFeature.slice(0, 5).map((f) => `${f.feature} (${f.events})`).join(", ") || "none"}`].join("\n")
    };
  }
  const m = await collectMetrics();
  const findings = evaluate(await getThresholds());
  const total = m.routes.reduce((n, r) => n + r.requests, 0);
  const errors = m.routes.reduce((n, r) => n + r.serverErrors, 0);
  return {
    subject: "AiMlTriage performance summary",
    body: [`Requests (recent window): ${total}`, `Server errors: ${errors}`, `Slowest route p95: ${Math.max(0, ...m.routes.map((r) => r.p95))} ms`, `Event loop lag: ${m.resources.eventLoopLagMs} ms`, `Database round trip: ${m.databaseLatencyMs ?? "n/a"} ms`, `Outside thresholds: ${findings.length === 0 ? "nothing" : findings.map((f) => `${f.kind}${f.route ? ` ${f.route}` : ""}`).join(", ")}`].join("\n")
  };
}

export async function sendMetricsReport(options: { to: string[]; report: "usage" | "performance" }): Promise<{ sent: number; skipped: string[] }> {
  const allowed = allowedReportDomains();
  const recipients = options.to.filter((address) => allowed.includes(address.split("@")[1]?.toLowerCase() ?? ""));
  const skipped = options.to.filter((a) => !recipients.includes(a));
  if (recipients.length === 0) throw new Error("No recipient is on an approved domain (REPORT_ALLOWED_RECIPIENT_DOMAINS).");
  const { subject, body } = await buildReport(options.report);
  let sent = 0;
  for (const to of recipients) {
    const result = await getEmailAdapter().send({ to, subject, body });
    if (!result.ok) throw new Error(result.error ?? "Email could not be sent.");
    sent += 1;
  }
  return { sent, skipped };
}
