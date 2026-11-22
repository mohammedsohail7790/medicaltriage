# Qatar Airways tenant: infrastructure design and runbook

Status: **written and validated, not planned or applied.** The Terraform in `terraform/tenant-qatar-airways/` passed `terraform validate` on 21 Nov 2026 (details under "Not validated" below). `terraform plan` has not been run, because there is no tenant to plan against, and it is covered by guardrail tests. It must be planned in Qatar Airways' tenant, and the plan reviewed by their IT, before anything is applied. It shares no state, backend, provider or project with the existing SOC 2 environment (`terraform/main.tf`), which it does not touch.

## What each requirement is answered by

| Requirement | Control | Where |
|---|---|---|
| AI-009 soft delete and purge protection | Keys and key rings cannot be removed by Terraform; destroyed key versions wait out a 30-day window; secrets are in Secret Manager with no deletion role granted | `kms.tf`, `secrets.tf` |
| AI-010 restrict access to secrets | One binding: the runtime service account. A person goes through the privileged access request | `secrets.tf`, `iam.tf` |
| AI-011 / M-040 threat detection | Security Command Center findings of high or critical severity stream to the SIEM topic; Binary Authorization blocks unsigned images | `security.tf`, `binauth.tf` |
| AI-005 policy frameworks | Project policies: approved locations only, no public database address, no external VM addresses, uniform and non-public buckets, no service-account keys, customer keys required, ingress only from the load balancer | `orgpolicy.tf` |
| AI-006 / AI-007 private network | Cloud Run accepts only load-balancer traffic; database has a private address only; egress is denied except the database, Google APIs and listed integrations | `run.tf`, `network.tf`, `sql.tf` |
| AI-008 / M-038 firewall and WAF | Cloud Armor with SQL injection, XSS, file inclusion and remote-code rules, rate limiting, approved networks only, deny by default, layer-7 DDoS defence; TLS 1.2 minimum | `network.tf` |
| AI-012 / M-019 / M-020 customer-managed keys and field-level encryption | Keys in the tenant (an HSM key for data at rest and a separate `field-encryption` key), or a Qatar Airways-held key through `customer_managed_key` (due by 2027-08-01). The service wraps each field data key in Cloud KMS (`FIELD_ENCRYPTION_PROVIDER=gcp-kms`), so it holds no key-encryption material | `kms.tf`, `run.tf`, `variables.tf`, `src/services/gcpKmsKeyProvider.ts` |
| AI-013 / M-018 database controls | Private IP, TLS required, password policy, query and connection logging, backups in region, deletion protection | `sql.tf` |
| AI-015 / NFR-167 central logs | Regional central log bucket and a sink to the SIEM topic; audit logs for every service | `logging.tf`, `iam.tf` |
| NFR-153 runtime and migration roles | Two database users; `prisma/roles/least-privilege.sql` and `scripts/migrate.mjs`; start-up check `DB_ROLE_CHECK=enforce` | `sql.tf`, `src/services/databaseRole.ts` |
| NFR-151 sign-in only through SSO | `SSO_ENFORCED=true` refuses local passwords except named `BREAK_GLASS_USERS`, and audits each refusal | `src/routes/auth.ts`, `run.tf` |
| NFR-158 signed releases | Binary Authorization requires an attestation by the release pipeline's key | `binauth.tf`, `docs/container-image-signing.md` |
| NFR-159 privileged access | Privileged Access Manager: eligible group, one approval, four-hour limit, no standing administrator | `iam.tf` |
| NFR-161 secret rotation | Keys and secrets carry a rotation period; the application reports each secret's age and alerts when one is overdue | `secrets.tf`, `src/services/secretRotation.ts` |
| M-028, NFR-063, NFR-087, NFR-088, NFR-089 residency | Every region is checked against `approved_regions` in Terraform and at application start-up; the inventory below | `variables.tf`, `outputs.tf`, `src/config/infrastructureGuards.ts` |

## Residency inventory (for Qatar Airways' approval)

Everything is held in the regions in `approved_regions`. The default is `me-central1` (Doha) alone.

| Item | Location |
|---|---|
| Application (Cloud Run) | primary region |
| Database and its point-in-time logs | primary region |
| Database backups | primary region |
| Encryption keys | primary region |
| Secrets | approved regions only (replicas are created only there) |
| Central logs | primary region |
| SIEM feed topic | must be in an approved region (a variable the tenant supplies) |
| Disaster recovery | **not decided**: `dr_region` is empty until Qatar Airways IT names an approved pair; there is no overseas replication |
| Edge load balancer | a global address; it forwards to the primary region and stores nothing |

`terraform output residency_inventory` prints the actual values after a plan or apply, and the application refuses to start in production if `DATA_REGION`, `BACKUP_REGION`, `DR_REGION`, `LOG_REGION`, `KMS_REGION` or `SECRETS_REGION` names a region outside `APPROVED_DATA_REGIONS`.

## What Qatar Airways has to give

- The tenant project, the approved regions and the DR location (AI-005, M-028, NFR-089).
- Approved ingress networks, the host name, and the addresses of the systems the application calls (AI-006, AI-008, M-038).
- The groups for administrators and approvers (NFR-159), and the SIEM topic (AI-015).
- Their key, if they hold it (AI-012), and the rotation interval (NFR-161).
- Their Security Command Center tier, the High-severity remediation time, and sign-off on the Critical rule: **Critical findings are remediated within 30 calendar days of awareness** (M-040).
- The projected load, so per-user network requirements can be stated (NFR-154).

## Order of work

1. Create the tenant project and a state bucket in an approved region.
2. Copy `terraform.tfvars.example` to `terraform.tfvars` and fill it in. `terraform init -backend-config="bucket=..." -backend-config="prefix=aimltriage"`.
3. `terraform validate`, then `terraform plan`, and have Qatar Airways IT review the plan.
4. Apply in two passes: everything except the Cloud Run service (it needs a signed image), then sign the first release image and apply the rest.
5. Run `prisma/roles/least-privilege.sql` as the database administrator after the first migration (migrations use `scripts/migrate.mjs` and the migration role). Set `DB_ROLE_CHECK=enforce`.
6. Turn on `SSO_ENFORCED` once single sign-on is live, with one or two named break-glass accounts.
7. Record each secret's rotation date as `<NAME>_ROTATED_AT` whenever it is rotated, and schedule the `secrets.rotation_check` job.

## Not validated

- `terraform validate`: **passed on 21 Nov 2026** for this configuration (`terraform/tenant-qatar-airways`, 91 resources including the environment module). It was run on a scratch copy with Terraform 1.17.2, Google provider 6.50.0 and Random provider 3.9.1, after `terraform init -backend=false`, with no credentials. The download checksums were checked against HashiCorp's published list. The older top-level `terraform/` files (which require Terraform ~> 1.14) also passed, on Terraform 1.14.9. Validate checks syntax and internal consistency only; it does not show that the resources can be created. `terraform fmt -check` flags one cosmetic alignment in `secrets.tf` (not changed).
- `terraform plan`: not run. It needs the tenant project, real variable values and credentials. Nothing has been applied.
- Whether Qatar Airways' Google Cloud organisation offers Privileged Access Manager, Security Command Center and Cloud Armor Adaptive Protection at the tier needed.
- Cloud Run reaching Google APIs with all egress forced through the connector: private DNS for `googleapis.com` to the restricted range is written (`network.tf`) but untested; confirm with Qatar Airways IT that the design suits their network.
