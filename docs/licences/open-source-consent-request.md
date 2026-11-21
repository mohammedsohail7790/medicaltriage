# Request for consent: use of open-source components (M-016)

**Draft for IRISSTAR management to review, sign and send. Not sent.**

To: Qatar Airways (contract owner and legal)
From: IRISSTAR Technologies LLC
Subject: Consent under the open-source clause for the AiMlTriage service

The AiMlTriage service is built on third-party components, most of them open source. We ask for your consent to their use under the contract's open-source clause, and give you what you need to decide.

1. **Register.** The attached component and licence register lists every production component with its version and licence (the production npm packages, and the non-package components: runtime, base image, database, fonts). All are under permissive licences (MIT, Apache 2.0, BSD, ISC and similar), plus two font packages under the SIL Open Font Licence, which allows use and embedding. None is under a strong copyleft licence and none needs source disclosure of the service.
2. **Process.** The register is generated from the software bill of materials at each release, and the build fails if a component arrives under a licence outside the allowed families. New components are added only through that process.
3. **Notices.** The licence notices of the components are kept with them and can be provided on request.
4. **Clinical content.** The protocol content is not open source: it is licensed to IRISSTAR by its licensor. Our confirmation that the licence covers the named users is a separate item (`stcc-licence-checklist.md`).
5. **Your rights.** Please tell us if you wish to exclude any component, or require a notice or approval for particular licence families. We will agree the change and record it.

We ask you to confirm in writing that the use of the components in the register is acceptable, and that components under the same licence families may be added through the process above, with the register updated at each release.

Signed: ______________________ (IRISSTAR management)   Date: ____________
