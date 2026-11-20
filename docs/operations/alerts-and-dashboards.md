# Alerts, dashboards and how they reach Qatar Airways

## What raises an alert

| Alert | Raised by | Event or policy | Message includes |
|---|---|---|---|
| A job or queued task failed | The scheduler and the integration queue | `job.failed` | Failure reason, category, likely cause, what to check first (NFR-045) |
| An interface is slow or failing | Interface check job | `interface.degraded` | Integration, problem, value, threshold (NFR-111) |
| Performance dipped below the thresholds | Performance check job | `performance.degraded` | Route or event loop, value, threshold (NFR-132) |
| Call volume fell against the same hour in earlier weeks | Volume check job | `business.volume_dip` | Hour, observed, baseline (NFR-107; silent for the first two weeks of live traffic) |
| A secret is overdue for rotation | Rotation check job | `secret.rotation_overdue` | Which secrets, the interval (NFR-161) |
| The service is not answering | Uptime check, Terraform | Cloud Monitoring policy | |
| The database is down, its disk is filling, a backup failed, the DR replica is behind the RPO | Terraform | Cloud Monitoring policies | (M-024) |
| High and critical security findings | Security Command Center | Streamed to the SIEM topic | |

Application events are routed by **alert rules** (Admin, Access control, Event and alert rules) to a log, an email or a webhook, with a cooldown so a burst is one alert. Infrastructure alerts go to the notification channels in `monitoring.tf`.

## Pushing alerts to Qatar Airways in real time (NFR-102)

Two routes, both over HTTPS: set `alert_push_url` (and, at apply time, `alert_push_token`) in Terraform for the infrastructure alerts, and create a webhook subscription for application events (Admin, Integrations, Webhooks), whose deliveries are signed, retried, dead-lettered and replayable. Qatar Airways supplies the endpoint.

## Dashboards (NFR-104)

The Operations views (metrics, traces, interfaces, resources, jobs, rules) and the Cloud Monitoring dashboards are read-only for the groups in `dashboard_viewers`. `docs/monitoring/api-consumption-dashboard.json` defines the API dashboard.

## Thresholds

Defaults are the team's placeholders. Qatar Airways' agreed values replace them without a deployment: performance thresholds and business rules in Operations; interface thresholds with `INTERFACE_<NAME>_P95_MS`, `_ERROR_RATE` and `_MIN_CALLS`; database and disk alerts with `disk_alert_percent`; the DR lag alert follows the tier's RPO. Volume baselines come from live traffic after two weeks.

## Cost (NFR-116, AI-018)

`costs.tf` creates a budget with alerts at 50%, 90% and forecast 100%, a cost export dataset in the approved region, and read access for the finance group. Linking the export to the billing account is a one-time step for the billing administrator (`docs/cost-visibility-setup.md`). Whether Qatar Airways sees costs for their own tenant or a shared one depends on the tenant decision still to be made.
