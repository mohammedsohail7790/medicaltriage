# Caching, freshness and access revocation (NFR-121)

What is cached, for how long, and what happens to a cached value when access is taken away. The platform caches master, seed and configuration data to keep screens fast; nothing clinical or personal about a case is cached across users.

## What is cached

| What | Where | How long it can be stale | When it is refreshed |
|---|---|---|---|
| Clinical content package (protocols, questions, care advice) | Loaded into memory at start-up | Until the next release | A new content release is a deployment; every instance reloads at start |
| Protocol list responses | Browser, `Cache-Control: private, max-age=300` | 5 minutes | A reload after 5 minutes; the content does not change between releases |
| Role and permission catalogue | In memory per instance, refreshed from the database | 30 seconds (`ROLE_CATALOG_REFRESH_SECONDS`) | Periodic refresh; the instance that makes a change applies it at once. Sessions already open are ended on a change, as below |
| API consumer record (status, role, limits) | In memory per instance | 15 seconds | Expiry; a suspension on the instance that made it applies at once |
| Business rules and the Initial Assessment setting | In memory per instance | 5 seconds (`BUSINESS_RULES_TTL_MS`) | Expiry; the instance that makes a change applies it at once |
| Performance thresholds | Read when a check runs | One check interval | Each check |
| Prepared protocol match per queue case | Stored with the case | Until the case's reason or content release changes | Recomputed when the reason changes or the content release moves on |
| Sessions | Server memory and the shared session store | Session lifetime (30 minutes idle by default); a revocation within 15 seconds on every instance | See below |

Responses that carry a person's data (the queue, a case, sessions, tokens, exports, secrets) are sent `no-store` or are not cached by the browser; only the protocol library is cacheable, because it is the same for every user.

## Revocation: when access is taken away

A session carries the permissions its user had when they signed in; they are not looked up again on every request. Access is therefore taken away by **ending the sessions**, not by re-reading the role:

- **A user is deactivated, or their account is changed in a way that revokes access:** all of that user's sessions are ended, in memory and in the shared session store.
- **A permission is granted to or removed from a role:** every session holding that role is ended and the people sign in again, so the new permissions apply from their next sign-in.
- **A single session is terminated by an administrator:** that session is ended.
- **Other instances:** a session ended on one instance is marked revoked in the shared store. Every other instance asks the store about each session it holds at most every 15 seconds (`SESSION_REVOCATION_CHECK_SECONDS`) and drops a revoked one. Before 2026-11-21 other instances kept using their own copy until it expired; that gap is closed and tested against PostgreSQL.
- **An API consumer is suspended:** the instance that took the action refuses it immediately; any other instance refuses it within 15 seconds when its cached record expires. Tokens last one hour at most.
- **Elevation:** a privileged action needs a current, MFA-verified elevation that lasts 15 minutes and can be ended at any time.

So the longest a revoked user, role or session stays effective anywhere is **15 seconds** when the shared session store is on (`SESSION_DB_PERSISTENCE`); without it, each instance keeps only its own sessions and a revocation reaches it only if it made the change. An API access token already issued cannot outlive its hour, and is refused as soon as its consumer record is seen as suspended.

## What is deliberately not cached

Audit trails, anything read through the controlled reveal, and the safety floor of a case: each is computed from current data on every request. Permission checks use the permissions the session holds, which is why a change to a role ends its sessions.

## Not done

A shared cache across instances (for example Redis) is not built; each instance caches for itself, which is why the lifetimes above are short. If Qatar Airways requires a shared cache, it is new work, and its freshness and revocation rules would be added here.
