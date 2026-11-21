# Validation handover: testing the sprint build against the baselines

For Reshma. The sprint build must do everything the baselines did, plus what the sprints added, and every difference must be explained. Nothing here is pushed or deployed; both baselines are untouched.

## The three builds

| Build | What it is | Where |
|---|---|---|
| Sprint build | The SOC 2 line plus Sprints 1 to 10 | branch `sprint-1-mandatory`, this folder |
| SOC 2 baseline | The starting point of the sprints | git tag `baseline-soc2-1cb733d` |
| Demo baseline | The frozen GCP demo | git tag `baseline-demo-73beab9` (31 commits behind the SOC 2 line; **never to be updated**) |

## Already done by the build team (so you do not repeat it, and so you can challenge it)

- **Automated tests.** The sprint build passes 1,032 backend tests on a freshly migrated PostgreSQL database (the baseline passes 572), 101 frontend tests, the web typecheck and the production build. Reports: `gap-analysis/AiMlTriage_Sprint*_Gate_Report.html`.
- **Side-by-side API comparison against the SOC 2 baseline**, run with `scripts/compareBuilds.mjs` (result in `docs/validation/side-by-side-baseline-soc2-1cb733d.json`). It signed in to both with a nurse account and an administrator account and called 86 read-only endpoints each: 172 comparisons. 90 gave the same status and the same fields. 80 are endpoints that exist only in the sprint build (new work). 2 gave one extra field (`idleTimeoutSeconds` in the session answer). **None was missing, changed status, or lost a field.** Limits: read-only endpoints without identifiers only, demonstration mode, two accounts, and not run against the demo baseline.

## What you do

1. **Run the same comparison against the demo baseline** and against your test environment:

   ```bash
   COMPARE_PASSWORD=<test password> node scripts/compareBuilds.mjs <sprint build URL> <baseline URL> differences.json
   ```

   Anything under "status differs", "missing from sprint build" or "fields removed" is a regression until explained.
2. **Go through `reply-verification-register.csv`** (173 rows, one per submitted reply). For each row, try the behaviour the reply describes, mark pass, fail or difference, and write what you saw. Rows that name a file only prove the file exists. The reply is the contract: if it says the product does something, the product must do it.
3. **Use the interface**, not only the API: sign in as each role, run a triage from call to approval, open the new screens (clinical actions panel, safety, quality sampling, note templates, operations), and repeat the same steps on the demo baseline. Note anything that moved, vanished or got slower.
4. **Report every difference**, even a good one, in `differences.json` or the CSV. Broken behaviour is fixed and retested by the build team; nothing is left unexplained.

## Things you will meet

- The product starts in demonstration mode unless `MOCK_MODE=false` and the production settings are present. In demonstration mode there is no real database and some checks (for example the clinical approval gate) are relaxed. A production-mode run needs the production secrets and a database.
- New features are off or inert until configured: the vulnerability disclosure pages need `SECURITY_CONTACT`; licence usage needs `STCC_LICENSED_USERS`; external scheduling needs `SCHEDULER_MODE=external` and the scheduler job.
- The Terraform (`terraform/tenant-qatar-airways/`) passed `terraform validate` on 21 Nov 2026 but has not been planned or applied; it cannot be tested further until the tenant exists.

## What cannot be validated yet

See `docs/evidence-index.md` for the external items, and `docs/performance/sizing-and-load-test.md` for the load test that needs Qatar Airways' peak figure. The reply-by-reply check is a human task; this pack only makes it systematic.
