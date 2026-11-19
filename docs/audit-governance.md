# Audit governance

This document is the written form of the answer given for NFR-011 (disabling auditing on specific data elements).

## Position

Auditing cannot be disabled, for any data element or for the system as a whole. This is a deliberate design choice and meets the intent of the requirement, which is that the audit trail is complete and trustworthy.

## What guarantees it

| Guarantee | How |
| --- | --- |
| No switch exists | No setting in the code base turns auditing off. A test fails the build if a setting with that purpose is added. |
| Durable storage in production | The service refuses to start in production without database-backed audit storage and its signing secret. |
| Tamper evidence | Each entry is signed and hash-chained to the previous one. The chain can be verified at any time (`GET /api/v1/admin/audit-events/integrity`). |
| Append only | The database rejects updates and deletes of audit entries, including from the application's own audit account. |
| Completeness of change history | Changes to users, roles, permissions and the agreed clinical entities carry before and after values. |

## What can be configured, and how a change is governed

Only two things about auditing are configurable: how long entries are kept (`AUDIT_RETENTION_DAYS`, unset meaning the life of the contract) and where copies are sent (`AUDIT_FORWARD_SINKS`).

1. A written change request states what changes and why.
2. The security owner reviews and approves it. Where it affects Qatar Airways' data, Qatar Airways agrees in writing.
3. It is applied through the normal release and configuration process.
4. At every start the service writes `AUDIT_CONFIGURATION_LOADED` to the audit ledger, with before and after values when the configuration differs from the previous start. The approved change is therefore visible in the ledger itself.

The current statement is available at `GET /api/v1/admin/audit-policy`.
