# OWASP Top 10 and ASVS mapping (M-017)

Prepared 2026-11-21 from the code, for inclusion in the scope of the penetration test (`penetration-test-scope-and-programme.md`). Every row names the control and where it lives so a tester can check it, and says plainly where the control is partial or missing. **This is a self-assessment, not an independent verification**: the penetration test is what verifies it. Statuses: **Met** (control exists and is tested here), **Partly** (exists with a stated gap), **Gap** (not in place).

## OWASP Top 10 (2021)

| # | Risk | Controls | Where | Status |
|---|---|---|---|---|
| A01 | Broken access control | Role-based permissions on every route; tenant scoping on queue and encounter data; second-person approval for exports and reveals; just-in-time elevation for privileged changes; separate runtime and migration database roles | `src/services/authorization.ts`, `src/services/queueOrchestration.ts` (tenant checks), `src/services/exportGovernance.ts`, `prisma/roles/least-privilege.sql` | Met. Authorisation tests exist per route family; a tester should look hardest at tenant isolation and at the new roles |
| A02 | Cryptographic failures | TLS 1.2 minimum at the edge; database TLS required in production; field-level AES-256-GCM envelope encryption with wrapped keys and rotation; scrypt for password hashes; no secrets in code, fail-fast in production | `src/services/fieldEncryption.ts`, `src/services/keyProvider.ts`, `src/config/secrets.ts`, `src/config/infrastructureGuards.ts` | Partly. Not every clinical and personal field is encrypted (60 clinical fields, 14 encrypted; see `docs/compliance/data-flow-assessment.md`); the rest are protected by access control and database encryption only |
| A03 | Injection | Request bodies, queries and parameters validated with zod; the database is reached through Prisma with parameters; the few raw queries use tagged templates; no shell calls on user input | `src/routes/*` schemas (OpenAPI shows each), `src/services/*` | Met. Request arrays are bounded (see the patch policy for why) |
| A04 | Insecure design | Rules-first, human-approved clinical flow; the safety kernel cannot be lowered by a nurse or a model; approvals are non-bypassable; threat-modelled exports and reveals | `src/services/safetyKernel.ts`, `src/routes/approvalRouter.ts` | Met for the clinical flow. A formal threat model document is not written |
| A05 | Security misconfiguration | Helmet headers and a strict content security policy; CORS allow-list; IP allow-list option; production refuses to start with missing secrets or a bad region or insecure database URL; infrastructure as code with policy guardrails | `src/app.ts`, `src/config/*`, `terraform/tenant-qatar-airways/` | Met in code. The Terraform is not yet applied or validated |
| A06 | Vulnerable and outdated components | Dependency audit in CI that fails on high or critical; automated update proposals; SBOM and licence register; supported-runtime inventory; critical advisories cleared on 2026-11-21 | `.github/workflows/ci.yml`, `.github/dependabot.yml`, `vulnerability-and-patch-policy.md` | Partly. One high advisory (zod 3.x) has no fix in its major version and is a recorded exception with mitigations |
| A07 | Identification and authentication failures | Local passwords with a governed policy and breach-resistant hashing; TOTP multi-factor; account lock-out; CAPTCHA after repeated failures; encrypted sign-in option; single sign-on with PKCE and state; SSO-only mode; session idle timeout; session-context checks | `src/services/securityAdmin.ts`, `src/services/passwordPolicy.ts`, `src/services/captcha.ts`, `src/services/loginEncryption.ts` | Met. SSO enforcement depends on Qatar Airways' identity provider |
| A08 | Software and data integrity failures | Signed images admitted only with attestation (tenant design); hash-chained, append-only audit ledger verified by a scheduled check; signed webhooks and archive handoff; dependency lock file | `src/services/auditLedger.ts`, `src/services/integrityChecks.ts`, `terraform/tenant-qatar-airways/binauth.tf` | Met in code. Image signing enforcement is part of the unapplied tenant design |
| A09 | Security logging and monitoring failures | Every change audited with before and after values; reads of confidential screens audited; structured logs with redaction; streaming to a SIEM; anomaly detection on sign-in and reveals; alerting on performance, jobs and interfaces | `src/services/securityAdmin.ts`, `src/observability/logStream.ts`, `docs/security/application-intrusion-detection.md` | Met. A live SIEM is Qatar Airways' |
| A10 | Server-side request forgery | Webhook addresses must be https and, in production, not a private or loopback host; outbound calls only to configured integration addresses; tenant egress denied by default | `src/services/webhooks.ts`, `src/integration/externalClient.ts`, `terraform/tenant-qatar-airways/network.tf` | Partly. The webhook check tests the host name, not the addresses it resolves to, so a name that points at a private address is not caught in the application; the tenant network's egress rules are the backstop |

## ASVS 4.0.3 by chapter

| Chapter | Summary | Status |
|---|---|---|
| V1 Architecture | Documented architecture, data classification, least privilege, central access control, central logging. No formal threat model | Partly |
| V2 Authentication | Policy-governed passwords, TOTP, lock-out, CAPTCHA, SSO. Credential recovery is an administrator action, not self-service | Met |
| V3 Session management | Server-tracked sessions, HttpOnly and SameSite=Strict cookie, bearer token option behind the Firebase proxy, idle and absolute timeouts, concurrent-session and context checks, logout invalidation | Met |
| V4 Access control | Deny by default, role and permission checks, tenant scoping, no direct object reference without a check | Met |
| V5 Validation, sanitisation, encoding | zod on every input; React escapes output; rich clinical text is sanitised server-side; JSON only | Met |
| V6 Stored cryptography | Envelope encryption, key provider interface, rotation by re-wrapping, no custom primitives | Partly (coverage of fields; customer-held keys by 2027-08-01) |
| V7 Error handling and logging | Generic client errors with a request id and trace id; no stack traces to clients; log redaction | Met |
| V8 Data protection | Classification catalogue, masking, controlled reveal, approved exports with DLP, retention engine | Met |
| V9 Communication | TLS everywhere, HSTS, TLS 1.2 minimum at the tenant edge | Met (edge applied only in the tenant design) |
| V10 Malicious code | No dynamic code from input; dependencies audited; SBOM | Met |
| V11 Business logic | Sequence checks on the clinical workflow, idempotent completion, dual control, rate limits per route and per consumer | Met |
| V12 Files and resources | No file upload endpoint; PDFs are generated, not accepted; archive handoff is outbound only | Met |
| V13 API and web service | OpenAPI, versioning, authentication on every non-public route, per-consumer budgets, problem+json errors | Met |
| V14 Configuration | Secure defaults, no default credentials in production, dependency and build hygiene, CI gates | Met |

## What the test should concentrate on

1. Tenant isolation across queue items, encounters, exports and the new work items (incidents, referrals, teleconsult).
2. The approval gates: a nurse approving their own referral or escalation, a reviewer reviewing their own call, the clinical safety floor.
3. Authentication around the new consumer tokens and the SSO-only mode.
4. The webhook address check against DNS names that resolve to private addresses.
5. The public pages (developer registration, disclosure policy) and the token endpoint.
