import { registerSchedulerHandler } from "./jobScheduler.js";

/** The jobs the scheduler can run. Each is a thin wrapper over an existing, tested operation. */
let registered = false;
export function registerSchedulerHandlers(): void {
  if (registered) return;
  registered = true;

  // A harmless job for trying the scheduler and for proving asynchronous work: waits, and stops when cancelled.
  registerSchedulerHandler("demo.wait", async ({ params, signal }) => {
    const ms = Math.min(Number(params.ms ?? 1000), 600_000);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    return { waitedMs: ms };
  });

  registerSchedulerHandler("integrity.check", async () => {
    const { runIntegrityChecks } = await import("./integrityChecks.js");
    const report = await runIntegrityChecks({});
    if (!report.ok) throw new Error(`${report.checks.filter((c) => !c.ok).length} integrity check(s) failed.`);
    return { ok: report.ok, checks: report.checks.length };
  });

  registerSchedulerHandler("retention.dry_run", async () => {
    const { runRetention } = await import("./retentionEngine.js");
    const results = await runRetention({ execute: false });
    return { targets: results.length };
  });

  registerSchedulerHandler("performance.check", async () => {
    const { checkPerformance } = await import("./performanceMonitor.js");
    const result = await checkPerformance();
    return { ok: result.ok, findings: result.findings.length };
  });

  registerSchedulerHandler("synthetic.check", async () => {
    const { runSyntheticChecks } = await import("./syntheticChecks.js");
    const outcome = await runSyntheticChecks();
    if (!outcome.ok) throw new Error(outcome.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`).join("; "));
    return { checks: outcome.results.length };
  });

  // Key metrics by email on a schedule (NFR-105). Only to approved domains; one text summary, no patient data.
  registerSchedulerHandler("report.email", async ({ params }) => {
    const { sendMetricsReport } = await import("./metricsReport.js");
    return sendMetricsReport({ to: Array.isArray(params.to) ? params.to.map(String) : [], report: params.report === "usage" ? "usage" : "performance" });
  });
}
