# Caching, freshness and access revocation (NFR-121)

What is cached, for how long, and what happens to a cached value when access is taken away. The platform caches master, seed and configuration data to keep screens fast; nothing clinical or personal about a case is cached across users.

## What is cached

| What | Where | How long it can be stale | When it is refreshed |
|---|---|---|---|
| Clinical content package (protocols, questions, care advice) | Loaded into memory at start-up | Until the next release | A new content release is a deployment; every instance reloads at start |
| Protocol list responses | Browser, `Cache-Control: private, max-age=300` | 5 minutes | A reload after 5 minutes; the content does not change between releases |
| Role and permission catalogue | In memory per instance, refreshed from the database | 30 seconds (`ROLE_CATALOG_REFRESH_SECONDS`) | Periodic refresh; the instance that makes a change applies it at once |
| API consumer record (status, role, limits) | In memory per instance | 15 seconds | Expiry; a suspension on the instance that made it applies at once |
| Business rules and the Initial Assessment setting | In memory per instance | 5 seconds (`BUSINESS_RULES_TTL_MS`) | Expiry; the instance that makes a change applies it at once |
| Performance thresholds | Read when a check runs | One check interval | Each check |
| Prepared protocol match per queue case | Stored with the case | Until the case's reason or content release changes | Recomputed when the reason changes or the content release moves on |
| Sessions | Server memory and the database | Session lifetime (30 minutes idle by default) | See below |

Responses that carry a person's data (the queue, a case, sessions, tokens, exports, secrets) are sent `no-store` or are not cached by the browser; only the protocol library is cacheable, because it is the same for every user.

## Revocation: when access is taken away

- **A session or a user's role is changed or removed:** the session is checked against the current user and role on every request, not only at sign-in, so a removed role stops working on the next request. A deactivated account's sessions are ended.
- **An API consumer is suspended:** the instance that took the action refuses it immediately; any other instance refuses it within 15 seconds when its cached record expires. Tokens last one hour at most.
- **A permission is removed from a role:** applied on the instance that made the change at once and on others within 30 seconds.
- **Elevation:** a privileged action needs a current, MFA-verified elevation that lasts 15 minutes and can be ended at any time.

The longest a revoked permission can stay effective anywhere is therefore the longest cache lifetime above (30 seconds), except for an API access token already issued, which cannot outlive its hour but is refused as soon as its consumer record is seen as suspended.

## What is deliberately not cached

Authorisation decisions for a case, audit trails, anything read through the controlled reveal, and the safety floor of a case: each is computed from current data on every request.

## Not done

A shared cache across instances (for example Redis) is not built; each instance caches for itself, which is why the lifetimes above are short. If Qatar Airways requires a shared cache, it is new work, and its freshness and revocation rules would be added here.
