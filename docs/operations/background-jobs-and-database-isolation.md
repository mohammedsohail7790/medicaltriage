# Background jobs and database isolation (NFR-130)

The reply to NFR-130 says heavy background jobs run separately from interactive traffic, on a dedicated database. This is how that is built.

## Compute: scheduled jobs run in their own Cloud Run job

- The Cloud Run **service** (`terraform/tenant-qatar-airways/run.tf`) sets `SCHEDULER_MODE=external`. In that mode `startPlatformWorkers` does not start the in-process scheduler, so no API instance runs a scheduled job.
- A Cloud Run **job** (`aimltriage-scheduler`, `terraform/tenant-qatar-airways/jobs.tf`) runs `dist/schedulerJob.js`. Cloud Scheduler starts it every minute. It starts what is due (`tick`), waits for those runs to finish (at most `SCHEDULER_JOB_MAX_SECONDS`, default 540) and exits. It has its own CPU and memory (2 CPU, 2 GiB) and its own start-up, so a long job cannot take capacity from nurses.
- Runs, retries, diagnoses and the load-shedding rule (non-critical jobs are deferred while resources are constrained) are the same code as before; only where it runs changed. Every run is still recorded in the platform tables.
- Without `SCHEDULER_MODE=external` (local use, single instance) the scheduler runs inside the application as before.

## Database: one database instance for the Qatar Airways tenant

`terraform/tenant-qatar-airways/sql.tf` creates the tenant's own PostgreSQL instance (regional, private network). It is not shared with other customers or with the demo. SIT, UAT and stage each get their own instance (`environments.tf`).

## What is not shown yet

- The Terraform has been parse-checked only. `terraform validate` and `terraform plan` have not been run, and nothing has been applied.
- The job script was run locally against a real PostgreSQL database (see `tests/sprint10Database.test.ts`). It has not been run as a Cloud Run job.
- The integration job worker (queued EMR write-backs and e-mails) and the webhook worker still run in the application instances. They are small, event-driven tasks rather than heavy jobs; if Qatar Airways counts them as heavy, they move to the same job in a later change.
- The job takes up to a minute to notice a due schedule (Cloud Scheduler's finest step). Schedules finer than a minute are not supported in this mode.
