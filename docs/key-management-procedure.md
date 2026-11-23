# Key Management Procedure

_Closes Cloud CSQ IS.38 ("maintain key management procedures"). Documents
the real, currently-operating secret-rotation-reminder mechanism, and is
explicit about the one thing it does not cover: encryption-key management
proper, which is entirely GCP-managed for this application's infrastructure._

## Purpose

Defines how application secrets (database credentials, JWT signing
secrets, audit HMAC secrets) are stored, and how rotation is ensured to
never be silently forgotten.

## Scope

Covers the 3 real secrets provisioned for the soc2 environment:
`ist-triage-soc2-database-url`, `ist-triage-soc2-auth-jwt-secret`,
`ist-triage-soc2-audit-hmac-secret` (`terraform/main.tf`).

## Roles and responsibilities

- **DevOps lead**: owns the Secret Manager resources and responds to
  rotation-reminder notifications.
- **Backend eng**: performs the actual rotation (generate new value,
  update the Cloud Run revision, verify, disable the old version).

## Control requirements

1. Every application secret must live in GCP Secret Manager, never
   hardcoded or committed to source control.
2. Every secret must have a defined rotation period with a real reminder
   mechanism - a rotation must never be simply forgotten.
3. Rotating a secret must not cause an outage - the old version stays
   valid until the new one is confirmed working.

## Operating procedure

1. **Storage**: all 3 secrets are provisioned via
   `google_secret_manager_secret` Terraform resources
   (`terraform/main.tf:96,118,134`), injected into the Cloud Run service
   at deploy time via `--set-secrets`, never baked into the container
   image.
2. **Rotation reminder**: each secret has a `rotation { rotation_period =
   "7776000s" }` block (90 days, `terraform/main.tf:103-104`), publishing
   to a real `google_pubsub_topic.secret_rotation_notifications` Pub/Sub
   topic (`terraform/main.tf:86`) when the reminder fires - first
   reminder due 2026-11-02 per `docs/sli-slo-definitions.md`.
3. **Manual rotation on reminder**: DevOps lead generates a new value
   (new DB password via `gcloud sql users set-password`, or a newly
   generated JWT/HMAC secret), updates the Secret Manager secret version,
   redeploys the Cloud Run service with the new version, verifies the
   service is healthy, then disables (not deletes) the prior secret
   version.
4. **What this is NOT**: GCP Secret Manager's rotation feature is a
   *reminder*, not automated rotation - there is no generic mechanism to
   regenerate a database password or signing key on its own. This
   procedure is honest about that: rotation itself remains a manual,
   verified operation each time the reminder fires.

## Encryption-key management (explicitly out of scope for this document)

Cloud SQL's disk-level encryption-at-rest keys and TLS certificate
management are entirely Google Cloud-managed - there is no customer-
managed key (CMEK) currently enabled on the existing Cloud SQL instance
(investigated 2026-08-04: GCP does not support enabling CMEK on an
already-created instance, creation-time only - see `master-compliance-
register.csv` rows IS.33/IS.34 for the full finding). This procedure
covers *application secret* rotation, which is genuinely IST Health's own
responsibility and control; it does not claim to cover encryption-key
management proper, which remains GCP's.

## Field-level encryption keys (Google Cloud KMS provider)

Personal and clinical fields are encrypted with a fresh data key per value, and each data key is wrapped by a
key-encryption key held by a key provider (`src/services/keyProvider.ts`).

| Setting | Meaning |
|---|---|
| `FIELD_ENCRYPTION_PROVIDER` | `local` (default: a key from Secret Manager), `gcp-kms` or `fortanix`. Any other value stops the service from starting to use it, so a typo cannot fall back to local keys. |
| `FIELD_ENCRYPTION_KMS_KEY` | A Cloud KMS crypto key name, `projects/.../locations/.../keyRings/.../cryptoKeys/...`. A key version name is refused. The key's region must be in `APPROVED_DATA_REGIONS` when that is set. |
| `FIELD_ENCRYPTION_KMS_KEY_PREVIOUS` | Optional, comma separated. Older crypto keys still needed to unwrap data after a move to a different key. |

- **Rotation inside one key:** Cloud KMS rotates versions of the crypto key (the Terraform sets the rotation period)
  and unwraps with whichever version wrapped the data. Nothing needs re-wrapping.
- **Moving to a different key** (for example a Qatar Airways-held key): set the new name, list the old one under
  `..._PREVIOUS`, then run `npx tsx src/scripts/encryptStoredFields.ts --execute --rewrap` so stored values move to the new key (it is a dry run without `--execute`).
- **No fallback:** if Cloud KMS refuses or is unreachable, encryption and decryption fail. No local key is used.
- **Access:** only the runtime service account holds `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the field key.
  For a Qatar Airways-held key, Qatar Airways grants that role to the runtime service account.
- **Production start-up:** with `gcp-kms`, `FIELD_ENCRYPTION_KEY` is not required, and `FIELD_ENCRYPTION_KMS_KEY` is.
- **Not tested against real Cloud KMS.** The tests use a stand-in KMS that enforces the same additional
  authenticated data. The first run in the Qatar Airways tenant is the first real test, and Terraform has been
  validated but not planned or applied.

## Fortanix vault (Qatar Airways-held key)

With `FIELD_ENCRYPTION_PROVIDER=fortanix` the key-encryption key stays in the Qatar Airways Fortanix DSM vault. Each data key is
encrypted and decrypted by a call to the vault. The application holds no key-encryption material.

| Setting | Meaning |
|---|---|
| `FORTANIX_ENDPOINT` | The vault's https address. Plain http is accepted only for localhost outside production. |
| `FORTANIX_API_KEY` | The application's API key, a secret from Secret Manager (`fortanix-api-key`). |
| `FORTANIX_KEY_ID` | UUID of the AES key (or `FORTANIX_KEY_NAME`). |
| `FORTANIX_KEY_ID_PREVIOUS` | Optional, comma separated UUIDs of older keys, so a key change needs no re-wrap. |

- **How it calls the vault:** it signs in with the API key (`POST /sys/v1/session/auth`, Basic), then calls
  `POST /crypto/v1/encrypt` and `/crypto/v1/decrypt` with AES-GCM and additional authenticated data. It does not use the vault's
  wrap and unwrap calls.
- **In the vault:** create an app with an API key, an enabled AES key, and give the app the Encrypt and Decrypt operations on it.
- **No fallback:** if the vault refuses or is unreachable, encryption and decryption fail. No local key is used.
- **Network:** add the vault's address to `integration_egress_cidrs`, set `fortanix_endpoint`, `fortanix_key_id` and
  `fortanix-api-key` in the tenant Terraform. The Cloud KMS settings are then not used.
- **Built to Fortanix's public documentation and tested against a stand-in vault only. Not confirmed against a real tenant:**
  the wire names `tag`, `tag_len` and `ad`, the unit of `expires_in` (assumed seconds), and the error body. Run
  `tests/fortanixKeyProvider.test.ts` and then a smoke test in the Qatar Airways tenant before relying on it.
- **Fortanix** is Qatar Airways' vault (NFR-048). No Fortanix adapter exists; one would implement the same
  `KeyProvider` interface once Qatar Airways gives the interface and key design.

## Review cadence

Reviewed alongside the annual risk-register cadence
(`docs/risk-register-2026-08-04.md`, next review 2026-11-04), and
triggered ad hoc whenever a rotation reminder fires (first: 2026-11-02).

## Approval requirement

Describes an existing, already-operating technical mechanism - no
separate approval gate needed to publish as-is.

## Evidence generated

- `terraform/main.tf` rotation blocks (verified zero-diff against live
  state).
- The Pub/Sub notification itself, once the first reminder fires
  (2026-11-02) - not yet observed, since the 90-day window hasn't
  elapsed.

## Exceptions process

If a rotation reminder is missed or a rotation is delayed past a
reasonable window after the reminder fires, this must be logged in the
next risk-register review rather than silently skipped.

## Related questionnaire IDs

IS.38 (this document). IS.33/IS.34 (CMEK investigation, referenced, not
re-litigated here).

## Related implementation references

- `terraform/main.tf:81-149` (secret resources, rotation config, Pub/Sub
  topic)
- `docs/sli-slo-definitions.md` (secret rotation reminders section)
