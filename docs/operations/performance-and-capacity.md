# Performance, data growth and capacity

## What has been measured (NFR-129, NFR-120 partly)

`pnpm growth:test` builds a scratch database with the real schema, fills it with synthetic cases and audit events, and times the queries behind the busiest screens using the database's own execution time. It never touches the source database. Measured on 2026-11-21 on a developer machine (PostgreSQL 16, no other load):

| Query | 10,000 cases and events (p50 / worst, ms) | 100,000 cases and events (p50 / worst, ms) | 500,000 cases and events (p50 / worst, ms) |
|---|---|---|---|
| open queue board (ranked, 50 rows) | 0.08 / 0.12 | 0.21 / 0.31 | 0.38 / 6.76 |
| completed cases for one organisation (page of 50) | 0.7 / 0.82 | 7.2 / 9.83 | 22.35 / 178.64 |
| one nurse's open cases | 0.03 / 0.03 | 0.03 / 0.12 | 0.03 / 1.66 |
| one employee's case history | 0.03 / 0.03 | 0.08 / 0.22 | 0.06 / 1.73 |
| audit trail, newest 200 | 0.03 / 0.04 | 0.05 / 0.11 | 0.04 / 0.57 |
| audit trail for one user (200) | 0.19 / 0.23 | 1.03 / 1.16 | 0.88 / 7.9 |

**Finding.** The completed-cases page grew with the data (22 ms typical and 179 ms worst at 500,000 cases) because the existing index could not return rows in order, so the database sorted a growing set. A new index on organisation, status and last update (migration `20260823090000_queue_completed_cases_index`, which only adds) brought it to **0.07 ms typical and 2.5 ms worst at 500,000 cases**. Every other query stayed under 1 ms typical and used an index throughout.

These are database times only, on one machine. They show the queries scale with data on this schema; they are not the application's response time under load.

## What has not been done, and needs Qatar Airways

| Task | What is missing |
|---|---|
| M-027 capacity planning, NFR-135 database sizing | Peak concurrency and workload |
| NFR-120 response time under the SLA | The SLA and a workload definition; then `scripts/loadTest.mjs` against the tenant, judged by `pnpm quality:gate --load` |
| NFR-129 at an agreed data volume | Their growth assumptions; repeat the growth test at those volumes in the tenant |
| NFR-037 backup impact | A load test running through a backup in the tenant |
| NFR-058 archival and purge impact | A load test running a retention purge and archive |
| NFR-154 network per user | Their load projection (`pnpm network:estimate`) |

The test tools are ready; each needs the tenant and a stated workload to give a result worth reporting.
