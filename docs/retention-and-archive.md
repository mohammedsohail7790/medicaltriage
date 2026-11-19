# Retention, archive and soft delete

## Data types and policies (NFR-055, NFR-057)

Each data type has its own policy row, schedule and legal-hold scope. List them with `GET /api/v1/admin/retention-policies`; change one with `PUT /api/v1/admin/retention-policies/:code` (needs elevation, audited with before and after).

| Code | Data | Archived first |
| --- | --- | --- |
| TRIAGE_QUEUE_ITEM_COMPLETED | Completed queue cases | yes |
| TRIAGE_QUEUE_ITEM_DELETED | Soft-deleted queue cases | yes |
| AVIATION_TRIAGE_ENCOUNTER | Clinical encounters | always (cannot be hard-deleted) |
| DEPENDENT_DELETED, CCP_DRAFT_DELETED, CCP_WEBHOOK_DELETED | Soft-deleted dependents, drafts, inbound messages | yes |
| CCP_WEBHOOK_RECORD, INTEGRATION_INBOUND_LOG | Message and integration records | yes |
| USER_SESSION_EXPIRED, LOGIN_NONCE, EXPORT_APPROVAL | Sessions, sign-in nonces, export approvals | no |

Audit events are not in the list and are never purged.

A policy purges only when it is active and names a period (days), the reference of the decision that approved it and a legal basis. A data type without one is reported and skipped. Records under a legal hold (the record, or its whole organisation) are never purged. Archive and delete happen in one serializable transaction, serialized with every legal-hold change.

Run all or one data type on its own schedule:

    npx tsx src/scripts/runRetention.ts                       # report
    npx tsx src/scripts/runRetention.ts --target=USER_SESSION_EXPIRED --execute

## Archive handoff (NFR-056)

IRISSTAR keeps no clinical archive. Records the retention process archives wait in `archived_records` until `src/scripts/handOffArchive.ts` sends them to the designated archive system (`ARCHIVE_HANDOFF_URL`, signed with `ARCHIVE_HANDOFF_SECRET`). When the system confirms receipt the local content is removed and only a SHA-256 of what was sent stays as proof. A failed handoff leaves the record, raises `ARCHIVE_HANDOFF_FAILED`, and the integrity check `archive-handoff` complains if a record waits longer than `ARCHIVE_HANDOFF_MAX_HOURS` (72).

## Soft delete (NFR-013)

Deleting a dependent, message draft or inbound message marks it deleted with the user and time instead of removing it. Normal reads no longer return it; ask for deleted rows with `where: { deletedAt: { not: null } }`. Queue cases have their own soft delete. Encounters are the clinical record and are never deleted by users. Deleted rows leave only through the retention policy for their type.

## Extraction and portability (NFR-169, NFR-050)

`GET /api/v1/admin/extract` lists the datasets: queue cases, encounters, staff, dependents, users, roles, permissions, retention and password policies, queue transitions, safety logs, the audit ledger and archived records. Passwords, keys and tokens are never exported.

Taking a dataset is approval-gated like every export: `POST /extract/:dataset/requests` (needs `reports.export`), a second administrator approves it, then `GET /extract/:dataset?approvalId=...` in `format=json|csv|parquet`. The approval covers repeated pages until it expires; every page is audited with its size and SHA-256, can be inspected by the DLP tool, and can be disabled with `EXPORTS_DISABLED_KINDS=dataset`.

Incremental: each response carries `nextToken` (also `X-Next-Token`). Passing it as `since` returns only rows added or changed after it, in a stable order, so nothing is missed or repeated. With `consumer=<name>` and no `since`, the service continues from that consumer's stored position; the consumer moves it forward with `POST /extract/:dataset/ack` once it has stored a page, so a failed delivery loses nothing. Softly deleted rows arrive with `deletedAt` set; rows purged by retention appear in `archived-records`, which serves as the list of deletions. Frequency is the consumer's choice (poll as often as it likes); real-time delivery of audit events uses the audit forwarding sinks.
