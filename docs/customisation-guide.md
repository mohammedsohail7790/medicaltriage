# Customisation, extension points and open standards

For Qatar Airways' own developers and integrators. Everything here is configuration or a documented interface, so a customisation never needs a change to the product's code and a change for one organisation does not affect another.

## What can be customised, and how

| Need | Mechanism | Who changes it | Recorded |
|---|---|---|---|
| Queue ranking, call hold time | Business rules (`Admin, Operations, Rules`, `PUT /api/v1/admin/ops/rules/{key}`) with range, version and reason | Administrator, elevated | Audit trail, rule history |
| Initial Assessment rule | Setting with a required reason when relaxed | Administrator | Audit trail |
| Reusable note wording | Note templates, approved by a second person | Clinical lead and approver | Audit trail, version |
| Protocol question order | Adaptive branch rules, signed off by a second person | Clinical lead and approver | Audit trail |
| Who is told about what | Event and alert rules (log, email, webhook) | Administrator | Audit trail |
| Your systems reacting to events | Signed webhooks with retry, dead-letter and replay; Pub/Sub or JMS bridge | Administrator | Audit trail, delivery log |
| Your systems calling the API | Registered API consumers (OAuth 2.0 client credentials), a role and a request budget each | Developer registers, administrator approves | Audit trail |
| Scheduled work | Job scheduler: calendar, one-off, counted, user-triggered | Administrator | Run history |
| Connections to your systems | Integration registry: configured or not, dry run or live | Deployment setting | Interface log |

Clinical safety floors (vital-sign limits, emergency rules, dispositions) are **not** customisable at run time. They change only through a clinical release with its own sign-off.

## Standard technology

You extend the product with any language that can speak HTTPS and JSON. There is no required SDK. Working examples are in `docs/clients/`: `curl`, Java (`java.net.http`) and .NET (`HttpClient`). They have not been run against a live instance in this repository's tests; run them against your staging service before relying on them.

## Open standards used

| Area | Standard | Where |
|---|---|---|
| Messages | JSON over HTTPS | every endpoint |
| API description | OpenAPI 3.0 | `docs/openapi.json`, served at `/api-docs/openapi.json` to signed-in users |
| Event description | AsyncAPI 2.6 | `docs/asyncapi.json` |
| Events | CloudEvents 1.0 (`application/cloudevents+json`) | webhooks, Pub/Sub, alert rules |
| Errors (v2) | RFC 7807 problem documents | `/api/v2` |
| Deprecation signalling | Deprecation and Sunset headers | `/api/v1` once deprecated |
| Authentication | OAuth 2.0 client credentials, bearer JWT, OIDC single sign-on | `/api/v1/oauth/token` |
| Tracing | W3C Trace Context; OpenTelemetry (OTLP over HTTP/JSON) export | `traceparent` header; `OTEL_EXPORTER_OTLP_ENDPOINT` |
| Metrics | Prometheus text exposition | `/metrics` with `METRICS_TOKEN` |
| Messaging | Google Cloud Pub/Sub; JMS through a signed HTTPS bridge | `MESSAGE_BROKER` |
| Software bill of materials | CycloneDX 1.5 | `docs/sbom/sbom.cdx.json` |
| Data extraction | JSON, CSV, Apache Parquet | `/api/v1/admin/extract/...` |

**Not built:** Kafka-compatible export, a Redis-protocol cache, a general feature-flag facility, and a choice of protocol set per organisation (each deployment carries one protocol set, changed through a clinical release). If Qatar Airways needs any of these, it is new work.

## Observability checklist for every customisation

A customisation is not released until each box is ticked. The checks marked (CI) are enforced by `tests/hygiene.test.ts`.

- [ ] **Logs.** It writes structured one-line JSON with a `type`, never personal or clinical content. (Log streaming to the SIEM picks it up automatically.)
- [ ] **Metrics.** Its routes are served through the main application, so request counts and latency appear in `/metrics` and the Operations view. (CI: request counting, tracing and analytics are applied before any API route.)
- [ ] **Alerts.** A failure mode has an alert rule or a performance threshold, and someone owns it.
- [ ] **Traces.** Calls it makes to other systems go through the shared outbound client, so they appear as spans and pass `traceparent` on.
- [ ] **Audit.** Every change it makes is recorded with before and after values. (CI: each route file either records audit events or is named, with a reason, as audited by its service.)
- [ ] **Dashboards.** A customised component is visible on the Operations dashboard and the monitoring dashboard definition.
