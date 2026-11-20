# Supported-component inventory

Reviewed on 2026-11-20. Lifecycle statements below come from the team's knowledge at the review date and must be checked against each vendor's published lifecycle page at every review and before go-live.

| Component | Kind | In use | Tracked major | Status | Supported until | Action |
|---|---|---|---|---|---|---|
| node | runtime | 24 (container), 24 (this machine) | 24 | long-term-support | 2028-04 | None. Container image, CI and local development all use Node 24. |
| postgresql | database | 16 (test and target database) | 16 | supported | 2028-11 | Plan the move to a newer major with Qatar Airways' database team. |
| express | package | ^4.19.2 | 4 | maintenance | review | Review the Express 5 migration before go-live; regression-test every route. |
| prisma | package | ^5.22.0 | 5 | superseded-major | review | Review the next Prisma major before go-live; the migration needs the full database test run. |
| typescript | package | ^5.6.3 | 5 | supported | n/a | Keep to the current 5.x. |
| zod | package | ^3.23.8 | 3 | supported | n/a | Zod 4 exists; the OpenAPI generator depends on zod-to-json-schema for Zod 3, so move both together. |
| react | package | ^19.0.0 | 19 | supported | review | Keep to the current 19.x. |
| vite | package | ^6.4.3 | 6 | supported | review | Review at each release. |
| pdfkit | package | 0.15.2 | 0 | supported | n/a | Its Arabic shaping fails on some marks; the code strips them. Re-test on upgrade. |

Review this table at every release and again before go-live. A component whose status is not "supported" or "long-term-support" has an action that must be closed or accepted in writing by the security owner.
