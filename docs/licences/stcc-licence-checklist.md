# Clinical content licence checklist (F-001, M-016)

The clinical protocols are the licensed STCC content. The licence is between IRISSTAR and the licensor, and the content is **not in this repository**. This checklist is what has to be confirmed before go-live, and what the product shows to help.

| # | Item | Status |
|---|---|---|
| 1 | The licence covers the release that will be loaded, and the version is recorded in the content release shown in the application | To confirm with the licensor |
| 2 | The licence covers **named users**: the number of clinical staff who will use the protocols (nurses, physicians, safety officers, reviewers), including growth in year one | Not confirmed. The product reports the count of active clinical accounts at `GET /api/v1/admin/ops/licence-usage` against `STCC_LICENSED_USERS` |
| 3 | The licence permits hosting in Qatar Airways' tenant and use for their staff and dependants | To confirm |
| 4 | The licence permits the translations and adaptations used (Arabic rendering, local destinations, branching rules) | To confirm |
| 5 | Derived content (explanations, possible-conditions topics, templates) does not exceed what the licence permits | To confirm; the product derives these from the protocol's own text and shows the source release |
| 6 | The licensor's updates and corrections reach the product through a content release with its own review and sign-off | Process exists (content release policy); the sign-off is the clinical team's |
| 7 | Qatar Airways' clinical team has reviewed and signed off the release for use | Not done |
| 8 | Where the licence requires a notice or attribution, it is shown in the application | To confirm |

## What the product shows

- The release name and version, the content status of each protocol and its reviewer and review dates (`/api/v1/protocols/{id}/source`).
- Active clinical accounts against the licensed number, as above. The licence's own definition of a "user" decides what counts; the figure is a guide, not a legal count.

## Open-source clause (M-016)

The consent request to Qatar Airways under the contract's open-source clause is drafted in `open-source-consent-request.md`; the register of every component and licence is `component-licence-register.md`.
