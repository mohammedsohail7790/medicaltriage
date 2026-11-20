# Availability, disaster recovery and replication (Qatar Airways tenant)

Status: designed in `terraform/tenant-qatar-airways/` (not applied) and rehearsed on a local database. The tier, the approved locations and the load are Qatar Airways' decisions and are still open; every figure below is a target or a local measurement, not a promise.

## Design

| Requirement | Design | Where |
|---|---|---|
| NFR-034 no single point of failure | Database in two zones with automatic failover; at least two application instances spread over zones by the platform | `sql.tf`, `run.tf` |
| M-015 high availability and DR | In-region high availability, plus a cross-region replica in `dr_region` that can be promoted | `ha_dr.tf` |
| NFR-032 production and DR alike | The replica uses the same engine, tier and network posture as the primary; the application is rebuilt from the same signed image and the same Terraform in the DR region | `ha_dr.tf` |
| NFR-036 replication | Continuous replication to the replica, with lag alerted at the recovery point objective | `ha_dr.tf`, `monitoring.tf` |
| M-014 RPO, M-013 RTO | The tier (`recovery_tier`) sets the targets; the rehearsal is measured against them | `variables.tf`, `scripts/recoveryRehearsal.mjs` |
| NFR-037 backups without hurting service | Daily backup in a quiet window (01:00 Doha), point-in-time recovery, backups kept in the approved region | `sql.tf` |
| NFR-035 limited blast radius | Each non-production environment has its own database and service; a fault or upgrade in one cannot reach another | `environments.tf` |
| NFR-089 no overseas replication | `dr_region` must be an approved region; the replica, its key and its backups stay there | `variables.tf`, `ha_dr.tf` |

Qatar Airways has not yet named the tier or the DR location, so `dr_region` is empty and no replica is created until they do.

## Recovery rehearsal

`pnpm recovery:rehearse` takes a backup of the database, restores it into an empty database, and proves the copy is usable: every table has the same row count, the newest audit event is present, and the audit ledger's hash chain still verifies. It reports each step's time and compares the totals with the tier's RPO and RTO, and it exits non-zero if either is missed.

Measured on 2026-11-21, on a developer machine, against the test database (93 tables, 274 audit events): backup, restore and verification together took about 4 seconds; every table matched; the newest audit event matched; the audit chain verified on the restored copy; data loss between the source and the restore was zero. This shows the procedure works and is repeatable. **It does not show the tenant's recovery time**: that needs the real data size, the cross-region restore, promotion of the replica, redeploying the application in the DR region and switching traffic. Run the rehearsal again in the tenant before go-live and share the result (M-013, AI-021).

## Switching to the DR region

1. Confirm the primary region is lost (not a short fault): the uptime and database alerts have fired and the cloud provider's status says so.
2. Promote the replica (`gcloud sql instances promote-replica aimltriage-db-dr`). This cannot be undone; a promoted replica does not return to being a replica.
3. Apply this module with `region` set to the DR region and `image` set to the current signed image, to create the network, service and load balancer there.
4. Point the secrets at the promoted database and switch the domain's address to the new load balancer.
5. Run the synthetic checks (`POST /api/v1/admin/ops/synthetic`) and the audit chain check before opening to users.
6. Rebuild a replica from the new primary and plan the way back.

## Not done

- A production-and-DR combined-operation test (NFR-032), and a measured replica lag: both need the tenant.
- A standby application tier running in the DR region. Today the application is rebuilt there from code during a failover, which adds to the recovery time.

## A concern about the existing SOC 2 environment

The current SOC 2 environment replicates its database to Mumbai (`ist-triage-postgres-dr-mumbai`, `asia-south1`, see `docs/backup-disaster-recovery-plan.md`). Qatar Airways' requirement is no overseas replication. That replica is outside this tenant design and was not changed, but it must not be carried into the Qatar Airways deployment, and the position should be agreed with them if the SOC 2 environment is ever used for their data.
