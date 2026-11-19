# Transaction boundaries (NFR-060)

Every flow that writes more than one row was reviewed for atomicity. A flow is atomic when a failure at any point leaves either all of its writes or none of them.

## Result of the review

| Flow | Writes | Before | Now |
| --- | --- | --- | --- |
| Complete an encounter (`persistCompletedEncounter`) | encounter + safety audit log | Two statements. A failure between them left a completed encounter with no safety audit log. | One nested create: both or neither. |
| Queue claim, move, release and complete | queue item + signed transition log | Two statements. A failure between them left a changed case with no log entry. | One transaction (`saveRecordWithTransition`). |
| FHIR write-back failure record | read, extend and write back the deviation log trace | Read then write, unprotected. Two failures recorded at once could overwrite each other. | Serializable transaction with retry. |
| Clinical approval review | read, extend and write back the deviation log trace | As above. | Serializable transaction with retry. |
| Governed account create and credential issue | account row + role assignments | Already one transaction. | Unchanged. |
| Password change | new hash + history entry + prune | Already one transaction. | Unchanged. |
| Export approval use | single conditional update | Single statement, atomic by itself. | Unchanged. |
| Login nonce | single insert, unique key | Single statement. | Unchanged. |
| Retention purge (`purgeExpiredQueueData`) | archive copy + delete | Already one serializable transaction. | Unchanged. |
| Audit ledger append | read last hash + insert | Already one transaction under an advisory lock. | Unchanged. |

Single-statement writes are atomic in PostgreSQL and were not changed.

## Rules for new code

1. A function that changes more than one row calls `runInTransaction` (`src/services/dbTransaction.ts`) or uses a nested create.
2. A read-then-write of the same row (appending to a JSON trace, incrementing a counter) uses `{ serializable: true }`; the helper retries on a serialization failure.
3. Audit events are written by the ledger writer, which has its own transaction; they are not part of the business transaction, so a failed audit write never blocks the action it describes (the existing, documented policy).
