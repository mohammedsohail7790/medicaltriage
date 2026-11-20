# Browser and version matrix (UX-NFR-004, M-031)

Proposal for Qatar Airways IT to confirm or change. The application is tested in Chrome and Edge today (`playwright.config.ts`).

| Browser | Versions | Status |
|---|---|---|
| Google Chrome | current and previous | Tested in the end-to-end suite |
| Microsoft Edge | current and previous | Tested in the end-to-end suite |
| Mozilla Firefox | current | Proposed: add to the suite once Qatar Airways confirms it is used |
| Safari | current | Proposed: add once confirmed (macOS and iPad) |
| Mobile browsers | current iOS and Android | Not in scope unless Qatar Airways asks |

Once the list is agreed, each browser is added as a Playwright project, the suite is run, and defects are fixed before go-live. The end-to-end suite was not run in this build.
