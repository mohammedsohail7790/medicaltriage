# Sizing and load test (AI-027, NFR-005, NFR-133)

The replies say the application scales to 20 instances, the database is sized for Qatar Airways' specified peak, and a load test at that peak confirms performance. Two of those three are in place; the third cannot be done yet.

## In place

- **Scale-out.** `terraform/tenant-qatar-airways/run.tf` sets minimum 2 and maximum 20 instances; Cloud Run adds and removes instances with load. (Non-production environments are capped at 5 in `modules/environment/main.tf`.)
- **Database tier.** `database_tier` is a variable (`variables.tf`); stage uses `db-custom-2-7680`. The production value is set when the peak is known.
- **Measured data growth.** `docs/operations/performance-and-capacity.md`: the busiest queries stay under 1 ms typical at 500,000 cases, after an index fix.

## Measured here: one instance on a developer machine

`node scripts/loadTest.mjs http://localhost:8099 50 40`, 50 concurrent clients, 2,000 requests each scenario, one application process, PostgreSQL 16 on the same machine, demonstration mode, 2026-11-21:

| Scenario | Requests per second | p95 | Errors |
|---|---|---|---|
| Public status page | 7,605 | 17 ms | 0 |
| Queue list, unpaginated | 3,242 | 34 ms | 0 |
| Queue list, 50 per page | 12,422 | 8 ms | 0 |
| Protocol list | 11,976 | 8 ms | 0 |

**These numbers say the code has no obvious per-request bottleneck. They are not the load test the reply promises.** The data set was nearly empty, the database and the client shared the machine, and nothing ran through Cloud Run, the load balancer or the private network.

## Not done, and what it needs

1. **Qatar Airways' peak concurrent users** (the reply says they specify it). Without it there is no target to size to or test against.
2. **The tenant environment** to run `scripts/loadTest.mjs` and `scripts/capacityLoadTest.mjs` against, with a realistic number of cases loaded (`pnpm growth:test` shows how).
3. Set `database_tier` from the result, run again, and attach the report. Judge it with `pnpm quality:gate --load <summary.json>`.

Until then AI-027, NFR-005 and NFR-133 are **built, not proven at peak**.
