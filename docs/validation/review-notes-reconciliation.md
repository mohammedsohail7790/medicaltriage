# Review notes sheet and replies: reconciliation

Compared on the final submitted workbook (`IRISSTAR_FINAL_Vendor_Reply_PRESENT_TENSE_NO_DEMONSTRATION_NO_SHARED_REPORTS.xlsx`): 227 replies (184 Comply, 41 N/A, 2 Non-comply). The sheet "Review notes" is internal and says to remove it before sending. It describes the earlier draft, so it contradicts the replies in these places. Nothing in the workbook was changed.

| Review notes says | The replies say or the code does |
|---|---|
| Status: draft, nothing sent | The replies are now the contract |
| Dates assume go-live 2027-02-01 | Only M-006 mentions a date-like item; the replies are present tense, with no go-live date |
| 46 yellow rows need a decision (Mumbai replica, Node 20, idle timeout, staging network) | All now answer Comply. NFR-089 says no overseas replication; the SOC 2 environment still replicates to Mumbai (the tenant Terraform does not). Node 24 is required in `package.json`. Idle timeout is 15 minutes by default (NFR-145, true) |
| Placeholders: NFR-117/118 names, STCC licence text, sign-off | NFR-117 and NFR-118 still contain bracketed placeholders. F-001 states Qatar Airways' clinical team has signed off and the licence covers named users; neither has happened |
| M-002 commitment may be conditional | The reply says scope, programme and auditor "are agreed with Qatar Airways"; they are not |

## Other replies that differ from what is delivered

- **NFR-164 and NFR-001**: reply says complete request and response schemas for every endpoint and 76 paths. The specification has 214 paths and 230 operations; 58 of 111 body-taking operations have no request schema and no operation has a response schema. **Largest open gap; needs a decision on scope.**
- **M-016**: says Qatar Airways' open-source consent is on record. It is an unsent draft.
- **M-006**: said 30 days for Critical and High, 90 for Medium; the penetration-test document now matches.
- **NFR-142**: said performance gates block a release. The gate passed without measuring anything; fixed this sprint and added to CI (never run on GitHub).
- **M-014, NFR-037, AI-021**: say 7 backups retained; Terraform keeps 14 (more than promised).
- **M-017**: ZAP on each change is now in CI, never run on GitHub.
