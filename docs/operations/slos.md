# Service level objectives (M-029)

The definitions of the indicators, how each is measured today and the report that exists are in `docs/sli-slo-definitions.md`. This note adds the Qatar Airways tenant.

## Proposed objectives (to be agreed)

| Indicator | Proposed objective | Measured by |
|---|---|---|
| Availability | 99.5% of requests answered without a server error, over a rolling 30 days | Cloud Monitoring SLO on Cloud Run request counts (`terraform/tenant-qatar-airways/slo.tf`), and the outside uptime check |
| Latency | 95% of requests within 1 second | Cloud Monitoring SLO on request latency |
| Error rate | Below 1% of requests per month (server errors) | The same request counts; the application's own route metrics at `/metrics` |
| Saturation | No sustained event-loop lag over 200 ms, memory under 85% of the limit | Application resource status and the performance check |

These numbers are the team's proposal. Qatar Airways' agreed targets replace them by changing three variables in the Terraform (`slo_availability_goal`, `slo_latency_goal`, `slo_latency_threshold_ms`). A burn-rate alert tells the on-call team when the error budget is being spent more than ten times faster than the objective allows.

## The live dashboard

The Cloud Monitoring SLO page shows the objective, the error budget remaining and the burn rate. The application's own metrics, traces, interfaces and jobs are in the Operations views and at `/metrics`. Read-only access for Qatar Airways' people is the `dashboard_viewers` variable.

## Not yet

The dashboard is not live: it exists once the Terraform is applied in the tenant. The monthly SLI report described in `docs/sli-slo-definitions.md` measures the SOC 2 environment today, not the tenant.
