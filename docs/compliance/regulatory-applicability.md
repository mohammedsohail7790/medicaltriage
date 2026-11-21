# Regulatory applicability statement (NFR-047)

**For review by Qatar Airways' Data Protection Officer and counsel. This is a statement of how the product is built and where each regime may apply. It is not legal advice and does not say that the product is certified under any of them.** The data-flow assessment (`data-flow-assessment.md`) is the factual basis.

## Who is who (to be confirmed)

Qatar Airways is expected to be the controller of its staff's and dependants' health information; IRISSTAR operates the service for it as a processor. The roles, the contract terms between them and the list of sub-processors (cloud provider, messaging and email providers, the clinical content licensor) are for the contract and the DPO to settle.

## Regimes

| Regime | Does it apply? | Why, and what the product does |
|---|---|---|
| **Qatar: Law No. 13 of 2016 on Personal Data Privacy Protection** and the regulator's guidance on health data | **Yes, expected.** The data subjects are in Qatar and the service is hosted there | Purpose limitation and minimisation (classification catalogue, masked views, controlled reveal); security (encryption in transit and at rest, access control, audit); retention (per-type policies, approved before any purge); breach handling (privacy incident procedure and notification template in `docs/security/`); data stays in approved regions (start-up check, organisation policy). Cross-border transfer rules: none planned; any proposed transfer needs the DPO's decision first |
| **Qatar: Ministry of Public Health requirements for health information** | **Likely**, because the product handles clinical records | Clinical records are held in the encounter, audited, retained per policy, and written to the hospital record through the EMR integration. The product supports a clinician's decision and does not replace it; every disposition is reviewed by a nurse |
| **GDPR (EU and UK)** | **Only if** data subjects in the EU or UK are covered, or the contract applies it by agreement. Staff based in or travelling from those places could bring individual data within scope | If applied: a lawful basis and notice per flow, data-subject rights (access, correction, deletion subject to clinical retention), records of processing (the catalogue and integration specification), breach notification within 72 hours (the procedure supports it), and transfer safeguards. The product has no self-service data-subject request tool: requests are handled by administrators with the export and retention features |
| **HIPAA (US)** | **Not directly**, unless a US covered entity or business associate relationship exists. Qatar Airways is not a US covered entity by reason of this service | The technical safeguards (access control, audit, integrity, transmission security, encryption) line up with the HIPAA Security Rule's categories, which is useful as a benchmark, but the product is not assessed against it |
| **Aviation and employment rules on fitness to fly** | For Qatar Airways and its regulators | The product records a fit-to-fly status for staff as a result of triage; the rules that decide fitness are Qatar Airways' and are configured with them |

## Open points

1. The controller and processor roles, and the sub-processor list, in the contract.
2. The lawful basis and the notice to staff and dependants for each flow.
3. Whether any transfer outside the approved regions is ever needed, and the safeguard if so.
4. Which of GDPR and HIPAA, if any, Qatar Airways wants applied by agreement.
5. Data-subject request handling: whether the administrator process is enough or a tool is needed.
6. A data protection impact assessment: the data-flow assessment is the input; the assessment itself is the DPO's.
