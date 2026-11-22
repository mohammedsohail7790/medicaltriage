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

- The Terraform passed `terraform validate` on 21 Nov 2026 (see `docs/infrastructure/qatar-airways-tenant.md`). `terraform plan` has not been run, and nothing has been applied.
- The job script was run locally against a real PostgreSQL database (see `tests/sprint10Database.test.ts`). It has not been run as a Cloud Run job.
- With `SCHEDULER_MODE=external` the application instances start no queue workers: the integration job worker (queued EMR write-backs and e-mails) and the webhook worker now run in the scheduler job, which drains both queues every few seconds for up to `QUEUE_DRAIN_SECONDS` (default 45) after each start. Cloud Scheduler starts the job every minute, so a queued item can wait up to about a minute before the first pass. Both queues lock their rows, so overlapping runs do not repeat work. Without `SCHEDULER_MODE=external` (local use, the demo) the workers still run in the application, as before. This has been tested with stand-ins and has not been run as a Cloud Run job.
- The job takes up to a minute to notice a due schedule (Cloud Scheduler's finest step). Schedules finer than a minute are not supported in this mode.
