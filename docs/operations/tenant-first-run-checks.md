# Checks to run in the tenant (they cannot be run anywhere else)

Each item below was built and tested against local stand-ins only. This is how to prove it in the real tenant, and what to record.

| What | How | Record |
|---|---|---|
| **Fortanix key provider** (M-019, M-020, AI-012) | Set `FIELD_ENCRYPTION_PROVIDER=fortanix`; sign in, create a case with a patient name, read it back; query the table directly and confirm the stored value is ciphertext; run `encryptStoredFields` as a dry run. The provider was written from Fortanix's public documentation; the wire names `tag`, `tag_len`, `ad`, `expires_in` and the error body are unconfirmed. If sign-in or an encrypt call fails, those are the first suspects | Pass/fail, Fortanix response excerpts with secrets removed |
| **Cloud KMS provider** | Same, with `gcp-kms` | Same |
| **GitHub workflows** | After the first push: confirm the `dast`, `zap-baseline` and `dast-probe` workflows start. `dast` builds and starts the app with `node dist/index.js` and no database, so first check that this works in CI. Set the repository variable `DAST_TARGET_URL` for the weekly probe | Run links; any change the workflows needed |
| **Content Security Policy** (NFR-152) | `curl -sI https://<tenant host>/`; compare with `docs/security/content-security-policy.md`; the load balancer may add or change headers | Header capture |
| **Load test at the peak** (AI-027, NFR-005, NFR-133) | See below | Report and the database tier chosen |
| **Scheduler job** (NFR-130) | In Cloud Scheduler confirm the trigger fires each minute and the job succeeds; create a `demo.wait` schedule from the operations screen and see the run recorded | Execution history |
| **Recovery** | Repeat `pnpm recovery:rehearse` against a restored copy; compare with the tier's targets | Measured time and data loss |
| **Residency** | Confirm every storage, log and replica location is in an approved region; the SOC 2 environment's Mumbai replica must not exist in the tenant | Inventory |

## Load test at Qatar Airways' peak

1. Get the peak number of concurrent nurses and the working hours from Qatar Airways. The reply promises a test at that peak.
2. Load realistic data first (`pnpm growth:test` shows how a scratch database is filled).
3. From a machine in the tenant's network: `TEST_NURSE_PASSWORD=<test account password> node scripts/loadTest.mjs https://<tenant host> <peak concurrent users> 40 > load-test.json`, then `node scripts/qualityGate.mjs --load load-test.json` (limits: p95 2,000 ms, errors 1%; the gate fails if the file has no figures).
4. For several accounts and think time, use `scripts/capacityLoadTest.mjs`.
5. Watch CPU, instance count and database load in Cloud Monitoring during the run. Set `database_tier` from what it shows, and run again.
6. Attach the results to `docs/performance/sizing-and-load-test.md`. Until then the replies to AI-027, NFR-005 and NFR-133 are built but not proven at peak.
