# Penetration testing: scope, programme and report format (M-006, NFR-163)

**Status: not yet commissioned.** An independent test has not been carried out. This document is what is ready to hand to Qatar Airways or its chosen tester so the first test can be scoped and scheduled. It does not claim any result.

## What Qatar Airways asked for

An executive summary, in PDF, of an independent penetration test of the web application, the APIs and the cloud infrastructure; independent tests twice a year, the first before go-live; agreed findings remediated.

## Proposed scope

| Area | In scope | Notes |
|---|---|---|
| Web application | The single-page application for nurse, service manager, administrator, safety officer, reviewer and physician roles | Test roles are given to the tester |
| API | Everything in `/api-docs/openapi.json` (227 operations in versions 1 and 2), including the token endpoint and developer registration | The specification is the checklist; see `owasp-asvs-mapping.md` for where to look hardest |
| Authentication | Local sign-in, multi-factor, single sign-on, consumer tokens, session handling, SSO-only mode | |
| Infrastructure | The tenant project: load balancer and web application firewall, private network, database access path, secrets, service accounts, organisation policies | Only after the Terraform is applied |
| Public pages | Developer page, disclosure policy, health endpoint | |

Out of scope unless Qatar Airways adds them: their identity provider, EMR, QHIE and SIEM; denial-of-service and volume testing; social engineering; physical access.

## What the tester needs

- A **dedicated test environment** that mirrors production (the tenant's stage environment is the intended one), with synthetic data only. No real staff or patient data is used.
- Accounts for each role, with and without multi-factor, and API consumer credentials for each role a consumer can hold.
- Written rules of engagement: dates, source addresses, contacts, an emergency stop, and permission from Qatar Airways for any testing of its own systems.
- The OpenAPI specification, the architecture notes and `docs/security/`.

## Remediation

Findings are rated by the tester. Critical findings are fixed or mitigated within 30 calendar days of our becoming aware, following `vulnerability-and-patch-policy.md`; high and other findings on a schedule agreed with Qatar Airways. Each is recorded with its fix, retested, and reported back. Findings that need Qatar Airways' action are handed over with the evidence.

## The report we will ask for

An executive summary in PDF (scope, dates, method, number and rating of findings, overall assessment, the tester's name and accreditation) and a detailed technical report. The summary is shared with Qatar Airways; the detailed report is shared under confidentiality. A letter of attestation after retesting closes the loop.

## Programme

| When | What |
|---|---|
| Before go-live | First full test of the web application, API and the tenant infrastructure; findings fixed and retested |
| Twice a year after that | A full test, and a retest of earlier findings; also after any major change to authentication, the API or the network design |
| Continuously | Dependency audit in every build, weekly header and path probe (`scripts/dastProbe.mjs`), the checks in `docs/security/application-vulnerability-scanning.md` |

The scope, tester, window and cost are for Qatar Airways and IRISSTAR to agree (NFR-163 is "subject to agreed scope and cost"). The self-checks above are **not** a substitute for the independent test.
