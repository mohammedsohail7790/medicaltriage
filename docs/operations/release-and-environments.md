# Releases, environments and upgrades

## Environments (NFR-068, NFR-069, NFR-070)

| Environment | Purpose | Database | Availability target |
|---|---|---|---|
| SIT | System integration testing | its own | 99% monthly |
| UAT | User acceptance by Qatar Airways | its own | 99% monthly |
| Stage | Final rehearsal, production-like size | its own | 99% monthly |
| Production | Live | its own, in two zones, with a DR replica | agreed tier |

Each environment is one entry in `var.environments` (`terraform/tenant-qatar-airways/environments.tf`), so another (NFR, training, performance) is added by adding an entry, from the same definition. Availability is measured by an uptime check from outside every minute. How exclusions are counted (planned maintenance, a fault in their network) is for Qatar Airways to agree.

## Promotion path (proposal)

1. A change passes the pipeline: tests, migration lint, quality gate, SBOM.
2. The image is built once, signed, and referenced by digest.
3. SIT: integration checks run; the synthetic checks and the integration connectivity tests pass.
4. UAT: Qatar Airways accepts against their acceptance steps (to be named).
5. Stage: same size as production; a short soak and the rehearsal checks.
6. Production by canary (below). The same image digest travels all the way; nothing is rebuilt.

Qatar Airways must name its acceptance steps and approvers for UAT and stage (NFR-070), and the release calendar and maintenance windows (NFR-033, NFR-140).

## Canary and rollback (NFR-073, NFR-137, NFR-139)

- Production runs on Cloud Run revisions. Set `stable_revision` to the current revision and `canary_revision` to the new one with `canary_percent` at 5, then apply. Watch the error rate, latency and synthetic checks for the agreed period.
- Raise the share in steps (5, 25, 50, 100). At 100, make the new revision stable.
- **Roll back** by setting `canary_percent` to 0 (or emptying `canary_revision`) and applying: all traffic returns to the stable revision in seconds, without a rebuild. The previous revision is never deleted until the new one has been stable for the agreed period.
- A blue-green release is the same mechanism with the canary share moved from 0 straight to 100 after the new revision passes the checks, keeping the old revision for rollback.

## Zero-downtime upgrades (NFR-033, NFR-136, NFR-140)

Database changes are made so the previous release keeps working while the new one is rolled out ("expand then contract"):

1. **Expand:** add the new column, table or index; make new columns optional or give them a default. Release N+1 writes both.
2. **Switch:** release N+1 reads the new structure.
3. **Contract:** in a later release, remove what nothing uses.

`pnpm migrations:lint` refuses migrations that break this (dropping or renaming a column, changing a type, adding a mandatory column with no default, truncating) unless the migration carries `-- expand-contract: <reason>`. Migrations that pre-date the rule are listed by name in `prisma/migration-lint-baseline.json` and are not re-judged. The migration role runs migrations (`scripts/migrate.mjs`) before the new revision receives any traffic.

Application upgrades need no downtime because instances are replaced gradually behind the load balancer and sessions are carried by tokens, not by instance memory. Database engine and platform maintenance follow the provider's maintenance windows, which Qatar Airways must set. Cloud SQL maintenance on a two-zone database fails over rather than going down, but a brief connection reset is possible, so it belongs in an agreed window.
