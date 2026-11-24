# Deployment checklist: first deployment to the Qatar Airways tenant

Nothing here has been done. The code is built and tested locally; nothing is pushed or deployed, and the existing demo (73beab9) and SOC 2 environment are not part of this. Do the steps in order and stop at the first failed check. Every command is one that exists in this repository.

## 0. Before anything

| # | Step | Done when |
|---|---|---|
| 0.1 | Qatar Airways has named the approved regions, the project, the load balancer and identity provider details, and the Fortanix endpoint and key (or confirmed Cloud KMS) | Values recorded in a terraform.tfvars file made from `terraform/tenant-qatar-airways/terraform.tfvars.example` |
| 0.2 | The code is pushed and the CI run is green, including the new `dast` job | CI run link recorded. GitHub access is needed; the current login has none |
| 0.3 | A container image is built from that commit, signed, and its provenance recorded | `container-image-signing.md` followed; image reference known |

## 1. Infrastructure (`terraform/tenant-qatar-airways/`)

1. `terraform init`, then `terraform validate` (passed on 21 Nov 2026 on Terraform 1.17.2).
2. `terraform plan`. **Never run so far.** Read it; expect the network, Cloud SQL (regional), KMS, secrets, the service (2 to 20 instances), the scheduler job and its trigger, monitoring alerts, SLO and the DR replica. Anything unexpected stops the deployment.
3. `terraform apply` only after Qatar Airways IT and a second engineer have read the plan.

## 2. Secrets

Create each secret the Terraform declares (`secrets.tf`): signing and encryption secrets, `AUDIT_HMAC_SECRET`, database URLs (runtime role and migration role are different), `CALL_CENTER_GATEWAY_SECRET`, and the Fortanix API key if used. Never reuse the demo's secrets. Rotation reminders are already declared.

## 3. Database

1. `MIGRATION_DATABASE_URL=<migration role url> node scripts/migrate.mjs` (refuses the runtime role). There are 40+ migrations; the last ones only add.
2. Apply `prisma/roles/least-privilege.sql` so the runtime role has no more power than it needs, and set `DB_ROLE_CHECK=enforce`.
3. Field encryption of existing rows: **only if the database already holds data.** A new tenant database is empty and needs nothing. Otherwise: `npx tsx src/scripts/encryptStoredFields.ts` (a dry run) and read the report, then `--execute`.

## 4. Settings the service must have

`NODE_ENV=production`, `MOCK_MODE=false`, no demo credentials, `SCHEDULER_MODE=external` (set by the Terraform), all persistence flags, `FIELD_ENCRYPTION_PROVIDER=gcp-kms` or `fortanix`, `CORS_ALLOWED_ORIGINS`. Optional until the contact exists: `SECURITY_CONTACT` (the disclosure pages stay off without it), `STCC_LICENSED_USERS`, `STCC_LICENSE_TEXT`.

Check with `pnpm run preflight:production` before deploying. It reads configuration only; it does not prove the database or key service is reachable.

## 5. Deploy and verify

1. Deploy the image to a canary revision (`canary_percent` in the Terraform) and check `/api/v1/runtime/environment`, a nurse sign-in, and one full triage in the stage environment first.
2. Run the checks in `tenant-first-run-checks.md` against the tenant.
3. Raise the canary to 100% only when the checks pass. Roll back by setting the canary share to 0.

## 6. After go-live

Scheduler job running (Cloud Scheduler history); an alert test fired; first backup and a restore rehearsal (`pnpm recovery:rehearse`, then repeat in the tenant); the SLO dashboard showing data; the first quarterly access review scheduled.

## What this checklist cannot tell you

It lists what the code and Terraform need. It does not replace Qatar Airways' own change process, security review or acceptance criteria, which have not been supplied.
