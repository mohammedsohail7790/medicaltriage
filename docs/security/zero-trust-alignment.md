# Zero-trust alignment (NFR-160)

How the solution lines up with the usual zero-trust principles, with where it stops. "Today" is what the code does; "tenant design" is in `terraform/tenant-qatar-airways/` and is not yet applied.

| Principle | Today | Tenant design | Not yet |
|---|---|---|---|
| Never trust the network; verify every request | Every API route needs an authenticated session or consumer token; no route is trusted by address. An IP allow-list is optional and additional, never a substitute | Application reachable only through the load balancer and web application firewall; private network, default-deny firewalls, egress denied except listed systems | Mutual TLS between services (there is one application service, so little internal traffic) |
| Verify explicitly: strong identity | Single sign-on; TOTP multi-factor; SSO-only mode with named break-glass accounts; consumer tokens by client credentials; session-context checks (viewport, address changes) | Administrators come from the organisation's managed group | Device posture checks (needs Qatar Airways' endpoint tooling) |
| Least privilege | Roles with the fewest permissions; privileged permissions need a time-boxed, MFA-verified elevation; API consumers cannot hold privileged roles; runtime database role cannot change the schema or the audit ledger | No standing human administrator: access is requested, approved and limited to four hours; runtime service account has only the secrets and connections it needs | |
| Assume breach: limit blast radius | Tenant-scoped data; the audit ledger is append-only and hash-chained; field-level encryption; secrets rotate; each non-production environment has its own database | Separate projects and databases per environment; keys held by the tenant; replica in an approved region only | Network micro-segmentation inside a service |
| Continuous monitoring and response | Audit of every change and of confidential reads; anomaly detection; alerts on performance, interfaces, jobs, rotation; traces and metrics; streaming to a SIEM | Security findings streamed to the SIEM; availability, database and backup alerts | A 24-hour security operations function (Qatar Airways' or a provider's) |
| Protect data wherever it is | Encryption in transit and at rest; masking and controlled reveal; approval and DLP on exports; per-type retention | Customer-managed keys by 2027-08-01; organisation policies keep data in approved regions | Encryption of every personal and clinical field (see the data-flow assessment) |

This is a description, not a certification. Whether it meets Qatar Airways' zero-trust standard is for their security architects to judge against their own reference model.
