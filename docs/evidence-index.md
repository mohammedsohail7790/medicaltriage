# Evidence index: documents and external evidence

For each document or evidence item Qatar Airways asked for, what exists, and what is still needed from someone else. "Ready" means the document is written from the code and checked by tests; it does not mean the thing it describes has been independently verified. Items that need an outside party, a decision or a commitment are marked, and nothing is presented as done that is not.

| Ref | Item | Document or code | Status | Still needed |
|---|---|---|---|---|
| F-001 | Clinical content licence and sign-off | `licences/stcc-licence-checklist.md`; licence usage at `/api/v1/admin/ops/licence-usage` | **Process; not done** | Licensor's confirmation of named users; Qatar Airways' clinical sign-off |
| M-017 | OWASP Top 10 and ASVS mapping | `security/owasp-asvs-mapping.md` | Ready (self-assessment) | The independent test to verify it |
| M-006, NFR-163 | Penetration test, twice yearly | `security/penetration-test-scope-and-programme.md` | **Scope ready; test not done** | Tester, scope agreement, test environment, schedule |
| NFR-157 | Third-party patching | `security/vulnerability-and-patch-policy.md`; critical advisories cleared | Ready | Qatar Airways to agree the High service level |
| NFR-160 | Zero-trust alignment | `security/zero-trust-alignment.md` | Ready | Their architects' judgement against their model |
| NFR-162 | Vulnerability disclosure | `/security/disclosure`, `/.well-known/security.txt`; `security/vulnerability-disclosure-policy.md` | Built; **off until a contact is set** | IRISSTAR to name the mailbox and approve the wording |
| NFR-121 | Caching and revocation | `operations/caching-and-freshness.md`; cross-instance session revocation fixed and tested | Ready | |
| M-029 | SLIs and SLOs | `operations/slos.md`; `terraform/tenant-qatar-airways/slo.tf` | Proposed; **dashboard not live** | Their agreed targets; the tenant |
| NFR-095 | Manual fall-back procedures | `operations/manual-contingency-procedures.md` | **Draft** | Their procedures, forms and contacts; a rehearsal |
| NFR-054, NFR-155 | Handoff and integration documentation | `integration-handoff-spec.md` (generated) | Ready for what is built | Their endpoints; each agreed handoff added as it is agreed |
| NFR-067, NFR-141, NFR-119 | Technology roadmap | `roadmap.md` | Proposal | Annual review with Qatar Airways |
| NFR-074 | Database rollback | `operations/database-rollback.md` | Ready; not rehearsed in the tenant | |
| NFR-142 | Quality gates | `quality-gates.md`; `.github/workflows/ci.yml` | Ready | |
| M-016 | Component and licence register; open-source consent | `licences/component-licence-register.md` (generated); `licences/open-source-consent-request.md` | Register ready; **consent letter is a draft, not sent** | IRISSTAR to sign; Qatar Airways' consent; the STCC licence confirmation |
| M-032, NFR-171 | Accessibility | `accessibility/accessibility-self-evaluation.md` | Self-evaluation only | **An independent evaluator's conformance report** |
| NFR-047 | Regulatory applicability | `compliance/regulatory-applicability.md`; `compliance/data-flow-assessment.md` (generated) | Ready for review | Their Data Protection Officer and counsel |
| NFR-117 | Executive sponsor | `commercial/sponsor-and-team.md` | **Not filled in** | IRISSTAR management |
| NFR-118 | Dedicated named team | `commercial/sponsor-and-team.md` | **Not filled in** | IRISSTAR management |
| NFR-170 | Environmental commitment | `compliance/sustainability.md` | Partly: the product's footprint; **provider documents not attached** | The provider's published reports; IRISSTAR's policy |

## Sprint 10: validation and handover

| Ref | Item | Document or code | Status | Still needed |
|---|---|---|---|---|
| AI-002 | Dynamic security testing | `.github/workflows/ci.yml` (job `dast`), `.github/workflows/dast-probe.yml`, `scripts/dastProbe.mjs` | Workflows written; **never run on GitHub** | Push and first run; set `DAST_TARGET_URL`; authenticated testing is part of the penetration test |
| AI-027, NFR-005, NFR-133 | Sizing and load test | `performance/sizing-and-load-test.md`; `terraform/tenant-qatar-airways/run.tf` (2 to 20 instances) | Scale-out built; **no load test at the specified peak** | Qatar Airways' peak; the tenant |
| AI-041 | Approval before any write or message | `security/human-approval-checkpoint.md`; `src/services/safetyKernel.ts` | Built; production no longer bypasses it | |
| NFR-130 | Background jobs apart from interactive traffic | `operations/background-jobs-and-database-isolation.md`; `terraform/tenant-qatar-airways/jobs.tf`; `src/schedulerJob.ts` | Built; **Terraform not validated** | `terraform plan` in the tenant |
| NFR-152 | CSP directives | `security/content-security-policy.md` | Ready; inline styles allowed | Capture from the tenant |
| Handover | Test both builds | `validation/handover-to-reshma.md`; `validation/reply-verification-register.csv`; `scripts/compareBuilds.mjs` | Pack ready; **testing not done** | Reshma |

## What changed in the product while this was written

Writing the caching and revocation document showed that a session ended on one instance kept working on the others until it expired. That is fixed: other instances now ask the shared store at least every 15 seconds, and the fix is tested against PostgreSQL. Checking the replies against the code in Sprint 10 showed that the approval checkpoint was skipped in a production runtime left in demonstration mode (fixed), that scheduled jobs ran inside the API instances although the reply says separate jobs (a scheduler job and `SCHEDULER_MODE=external` added), and that the weekly probe and per-change scan the reply names were not scheduled anywhere (workflows added). Writing the patch policy showed 3 critical and 25 high dependency advisories; the critical ones and all but one high are now cleared, and the one that remains is a recorded exception.
