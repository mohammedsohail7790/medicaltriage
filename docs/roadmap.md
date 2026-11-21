# Technology roadmap (NFR-067, NFR-141, NFR-119)

A forward-looking plan, reviewed with Qatar Airways each year and at the intervals agreed for roadmap reviews. It is built from what the engineering work has found and from Qatar Airways' open requirements, and it is a **proposal**: nothing below is a contractual commitment until agreed. Dates are not given because they depend on the tenant, the clinical sign-offs and Qatar Airways' priorities; the order is the point.

## Now: before go-live

| Item | Why | Depends on |
|---|---|---|
| Validate and apply the tenant infrastructure; run the recovery rehearsal and a load test there | The Terraform is written and tested for guardrails but not applied | Qatar Airways' tenant, tier, locations and workload |
| Independent penetration test and a WCAG 2.1 AA evaluation | Required evidence; neither has been done | Qatar Airways' tester and an independent evaluator |
| Clinical content licence and sign-offs (protocol release, guideline mappings, adaptive question rules, Initial Assessment rule, possible-conditions view) | The code is ready; the content and approvals are the clinicians' | STCC licence; Qatar Airways' clinical team |
| Live integrations: single sign-on, EMR, QHIE, email, teleconsultant service, SIEM | Built and tested against stubs | Their endpoints and credentials |

## Next: first year of operation

| Item | Why |
|---|---|
| Move to Express 5 and a current Prisma major, with the full regression run | Both are flagged in the supported-component inventory |
| Zod 4 with the OpenAPI generator, which also clears the one standing dependency exception | `docs/security/vulnerability-and-patch-policy.md` |
| Per-tenant configuration sets (protocol sets, rules, templates) so a customer's change never reaches another | The customisation guide describes tenant-scoped rules; per-tenant protocol sets are not yet built |
| A standby application tier in the disaster-recovery region | Shortens recovery time (today the application is rebuilt there during a failover) |
| Screens for the operations features: schedules, business rules, thresholds, usage insights, traces | Today they are API-only |
| A text-first call view and measured behaviour on throttled networks | Slow-connection support is partly built |
| Encrypt every personal and clinical field, not only the most sensitive | 60 clinical fields exist, 14 are encrypted at rest |
| Self-service data-subject requests, if the DPO wants them | Today administrators handle them |

## Later: as needed

| Item | Note |
|---|---|
| Kafka-compatible event export and a shared cache (Redis protocol) | Named in the open-standards list as not built; new work if Qatar Airways needs them |
| Further languages and regional protocol variants | Arabic and English are supported today |
| Additional integration profiles (FHIR resources beyond DocumentReference) | As the EMR integration is agreed |
| Assistive features that explain or draft (never decide) | Only with Qatar Airways' clinical and regulatory approval; the rules engine stays the authority |

## How it is reviewed

Once a year, and at the roadmap-review intervals agreed for the contract, IRISSTAR presents what was delivered, what moved and why, and what is proposed next. Qatar Airways can ask for an item to move up; an item that changes scope or cost goes through the change process.
