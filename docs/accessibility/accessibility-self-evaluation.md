# Accessibility self-evaluation against WCAG 2.1 AA (M-032, NFR-171)

**This is not a VPAT or an Accessibility Conformance Report, and it does not claim WCAG 2.1 AA conformance.** Qatar Airways asked for a current VPAT or conformance report from an independent evaluator (NFR-171); that has not been commissioned. This document says what IRISSTAR has itself tested, what it found, and what the independent evaluation must cover. It builds on `accessibility-validation-report.md` and `accessibility-known-limitations.md`, which remain the detailed record for the pages they cover.

## What was tested on 2026-11-21

Automated checks with axe-core 4.12.1 (rule sets WCAG 2.0 A and AA, 2.1 A and AA) run in a real browser against the current build, on the pages added since the earlier reports:

| Page | Result |
|---|---|
| Sign-in page | One violation: the small legal line in the footer had a contrast ratio of 2.8:1 (needs 4.5:1). **Fixed** (the text is now 5.4:1) |
| Clinical workspace: safety dashboard, incidents, review sampling | No violations on any of the three tabs |
| Nurse cockpit, clinical actions panel (red-flag check, escalation, referral letter, incident form) | No violations in the panel |

Automated tools find roughly a third to a half of accessibility problems. No violations from the tool is not evidence of conformance: keyboard operation, focus order, screen-reader announcements, zoom and reflow, and the meaning of labels and error messages need a person.

## What was not tested

- Manual keyboard and screen-reader testing of the new screens (the checklists exist: `manual-accessibility-checklist.md`, `screen-reader-validation-checklist.md`).
- The Arabic right-to-left layout of the new screens with assistive technology.
- The admin portal cards added since the earlier reports, the quality reviewer and physician pages, and the PDF referral letter (tagged-PDF structure is not generated; the letter is for printing or email, and an accessible alternative is the same content in the case note).
- Mobile and tablet layouts of the new screens.

## What the independent evaluation must cover

All of the application's roles and screens (nurse cockpit, service manager board, administration, clinical workspace, sign-in and password flows, developer page, help), in English and Arabic, on the browser matrix Qatar Airways confirms (`docs/browser-matrix.md`), with assistive technology (a screen reader, speech input, magnification, keyboard only). The deliverable is a conformance report (WCAG 2.1 AA, in the VPAT format Qatar Airways prefers), a list of defects with severity, and a retest after fixes. Findings are fixed before go-live under the process in `docs/security/vulnerability-and-patch-policy.md` adapted for accessibility defects.

Acceptance criteria are Qatar Airways' to state; until they do, the target is WCAG 2.1 level AA.
