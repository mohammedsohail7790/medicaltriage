# Rolling back a release and its database changes (NFR-074)

A release is rolled back in two parts: the application revision, and any database change. Keeping the second small is what makes the first safe.

## 1. The application

Set the canary share to 0 (or point `stable_revision` back to the previous revision) and apply: all traffic returns to the previous revision within seconds, without a rebuild (`docs/operations/release-and-environments.md`). Do this first, whatever else is wrong.

## 2. The database

Database changes follow "expand then contract" and are checked by `pnpm migrations:lint`, so **the previous release keeps working against the new schema**. Rolling back the application is then enough, and the new tables or columns are simply left unused until the fix ships. This is the normal case, and nothing in the database needs undoing.

A change that is not backward compatible needs an `-- expand-contract:` note explaining why; it must also name its own undo step in the release notes before it is approved.

## 3. When data itself was damaged by a release

Use a backup, not a hand-written reversal:

1. Stop the damage: roll back the application and, if needed, put the service into maintenance (traffic to zero).
2. Choose the recovery point: the moment before the damage began (point-in-time recovery is on, with a seven-day log).
3. Restore **to a new instance** at that point (never over the live one), in the same approved region.
4. Compare: use the recovery rehearsal checks on the restored copy (row counts, newest audit event, audit chain verifies).
5. Decide with the clinical and security owners: either switch the application to the restored instance, or copy only the damaged records back from it. Anything written after the recovery point is lost from the restored copy, so list what it was from the audit trail first.
6. Record what happened in the audit trail and the incident log.

`scripts/recoveryRehearsal.mjs` exercises steps 3 and 4 on a backup; the first run (2026-11-21) took about 4 seconds on a small local database and every check passed. It has not been run in the tenant.

## What cannot be rolled back

Anything already sent to another system: an email, an EMR note, a webhook delivery, a teleconsultant escalation. These are recorded in the interface log and the audit trail so the other party can be told, but they are not recalled.
