# Human approval checkpoint (AI-041)

No record is written to a patient's record system, and no message is sent to a patient or employee, until a nurse has recorded a signed clinical approval for the case.

## Where it is enforced

| Action | Code | Rule |
|---|---|---|
| Write-back to the EMR (queued or direct) | `executeWriteback` in `src/integration/fhirWriteback.ts` calls `assertHumanApprovalForExport(..., "EMR_WRITEBACK")` | Refuses with 403 unless the encounter has a nurse approval whose signature verifies |
| Message to a patient or employee | `sendApprovedDraft` in `src/services/ccpCommunication.ts` calls `assertHumanApprovalForExport(..., "CCP_SEND")` | Same; the message draft also needs its own nurse approval |
| Referral letter, teleconsult hand-off e-mail | `requireApprovalIfConfigured` in `src/services/clinicalHandoff.ts` | Refuses with 409 `SIGNED_APPROVAL_REQUIRED` in production, or when `HANDOFF_REQUIRES_SIGNED_APPROVAL=true` |

The approval is made in the cockpit (`POST /api/v1/approval/reviews/:encounterId`). It is written to the hash-chained audit ledger as `HITL_CLINICAL_APPROVAL` with an HMAC signature, and the check re-computes that signature, so an approval that was edited afterwards does not count. Reviewing the reasoning for each feature is part of what is signed.

## What this sprint changed

The check used to be skipped whenever the service ran in demonstration mode (`MOCK_MODE`, which is the default). A production service started without `MOCK_MODE=false` would therefore have let a write-back or message through with no approval. A production runtime (`NODE_ENV=production`) now always asks for the signed approval, whatever `MOCK_MODE` says. Demonstration mode outside production still lets the screens run without a database; that is how the demo behaves.

## Limits

- The referral and hand-off checks read the audit ledger's 200 most recent approval events; a very old approval would not be found. They err on the side of refusing.
- Operational e-mails (privacy incident notices, reports, event rules) are not patient messages and are not gated by a clinical approval.
