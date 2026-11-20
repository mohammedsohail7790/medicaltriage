/**
 * A runbook for every job (NFR-112): what it does, whether it is safe to run again, what to check when it fails, and who
 * can correct it. The scheduler's handler list returns these beside each handler, docs/operations/job-runbooks.md is
 * generated from them, and a test fails if a job has none.
 */

export type Runbook = { title: string; what: string; safeToRerun: boolean; whenItFails: string[]; whoCanFix: string };

export const JOB_RUNBOOKS: Record<string, Runbook> = {
  "demo.wait": { title: "Demonstration wait", what: "Waits for a set time. Used to try the scheduler and to prove asynchronous work.", safeToRerun: true, whenItFails: ["It cannot fail on its own. A run that shows cancelled was stopped by an administrator."], whoCanFix: "Administrator" },
  "integrity.check": { title: "Integrity checks", what: "Runs the six data integrity checks: audit chain, encrypted values, completed cases, deletions, stale locks and archive handoff.", safeToRerun: true, whenItFails: ["Open Admin, Integrity checks and read which check failed and the references it lists.", "A broken audit chain is a security incident: follow the incident response plan before repairing anything.", "A stale-lock problem repairs itself on the next run; the others need the named record corrected."], whoCanFix: "Security owner and administrator" },
  "retention.dry_run": { title: "Retention preview", what: "Counts what each approved retention policy would remove, without removing anything.", safeToRerun: true, whenItFails: ["Check the database is reachable and the retention policies exist under Admin, Retention."], whoCanFix: "Administrator" },
  "performance.check": { title: "Performance check", what: "Compares request latency, error rate and event-loop lag with the thresholds and raises a performance.degraded event when one is outside.", safeToRerun: true, whenItFails: ["A failure means the check itself could not run: see the error and the trace. A degradation is delivered as an alert, not as a failed run."], whoCanFix: "Administrator" },
  "synthetic.check": { title: "Synthetic transactions", what: "Runs the critical flows (clinical content search, note compilation, referral PDF, database) with invented data.", safeToRerun: true, whenItFails: ["The error names the flow that failed. Reproduce it in the cockpit with a test case.", "A content failure usually means the clinical content package did not load: check the content release and the service logs."], whoCanFix: "Engineer on call" },
  "report.email": { title: "Metrics report by email", what: "Emails a usage or performance summary to approved recipient domains.", safeToRerun: true, whenItFails: ["'No recipient is on an approved domain': add the domain to REPORT_ALLOWED_RECIPIENT_DOMAINS.", "An email error: check the email integration under Admin, Integrations, Registry and run its connectivity test."], whoCanFix: "Administrator" },
  "secrets.rotation_check": { title: "Secret rotation check", what: "Raises an alert when a secret is older than the rotation interval.", safeToRerun: true, whenItFails: ["The run fails on purpose when a secret is overdue; its error lists which. Rotate the secret, then record the new date as NAME_ROTATED_AT."], whoCanFix: "Security owner" },
  "interface.check": { title: "Interface check", what: "Compares each live integration's response time and error rate with its thresholds and raises an interface.degraded event.", safeToRerun: true, whenItFails: ["A failed run means the check could not read the interface statistics. A slow or failing interface is delivered as an alert."], whoCanFix: "Administrator" },
  "business.volume_check": { title: "Call-volume check", what: "Compares this hour's call volume with the same hour in earlier weeks and raises a business.volume_dip event on a large fall.", safeToRerun: true, whenItFails: ["'Baseline not ready' is normal for the first two weeks of live traffic; nothing is alerted until then."], whoCanFix: "Service manager" },
  "emr.writeback": { title: "EMR write-back (queued)", what: "Writes a completed note to the hospital record through the EMR integration.", safeToRerun: true, whenItFails: ["Check the EMR integration and its credentials under Admin, Integrations.", "After four failures it moves to the dead-letter list; replay it once the EMR is reachable. The note stays safe in the encounter, and the nurse can copy it meanwhile."], whoCanFix: "Administrator, EMR owner" },
  "email.send": { title: "Email send (queued)", what: "Sends one queued email through the approved email service.", safeToRerun: false, whenItFails: ["Check the email service connection. Replay only if you are sure the first attempt did not deliver, as a replay can send the message twice."], whoCanFix: "Administrator" }
};

export function runbookFor(handler: string): Runbook | undefined {
  return JOB_RUNBOOKS[handler];
}

export function renderRunbooks(): string {
  const sections = Object.entries(JOB_RUNBOOKS).map(([name, r]) => `## ${r.title} (\`${name}\`)\n\n${r.what}\n\n- **Safe to run again:** ${r.safeToRerun ? "yes" : "no, see below"}\n- **Who can correct it:** ${r.whoCanFix}\n- **When it fails:**\n${r.whenItFails.map((w) => `  - ${w}`).join("\n")}\n`);
  return `# Job runbooks\n\nGenerated by \`pnpm runbooks:generate\` from \`src/services/jobRunbooks.ts\`. Every job the scheduler or the integration queue can run has an entry; a test fails if one is missing. For any failure, first read the failure reason and likely cause in the alert, then the run's trace.\n\n${sections.join("\n")}`;
}
