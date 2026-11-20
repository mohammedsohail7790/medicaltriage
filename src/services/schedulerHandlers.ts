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
}
