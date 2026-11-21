# Quality gates in the delivery pipeline (NFR-082, NFR-142)

What must pass before a change is merged and before it is released. The pipeline is `.github/workflows/ci.yml`; each gate fails the build.

| Gate | What it checks | Where |
|---|---|---|
| Backend and frontend type checks | The code compiles under strict settings | `typecheck-and-test` job |
| Migration lint | A database change keeps the previous release working (`pnpm migrations:lint`) | same job |
| Tests against a real database | About 1,000 backend tests, including the database-backed suites, and about 100 frontend tests | same job |
| Coverage threshold | Backend coverage of lines, statements, functions and branches must not fall below `quality-thresholds.json` (80% lines measured on 2026-11-21; the floor is 78/77/77/62) | `pnpm test:coverage`, `pnpm quality:gate` |
| Performance threshold | Given a load-test result, p95 latency and error rate must stay within `quality-thresholds.json` | `pnpm quality:gate --load <result>` |
| Dependency vulnerabilities | No high or critical advisory except a recorded exception | `dependency-audit` job |
| Licences | Only the allowed licence families (`docs/licences/component-licence-register.md`) | same job |
| Software bill of materials | A CycloneDX SBOM is produced and kept as a build artifact | same job |
| Container build | The image builds | `docker-build` job |
| End-to-end and accessibility | The browser suite and the accessibility audit | run on release (not on every change) |

Thresholds are raised as coverage improves and are never lowered without the security owner's sign-off. The performance gate needs a load-test result from the environment under test, which is why it is run at release against the stage environment, not on every change. Image signing and Binary Authorization are enforced in the tenant (`terraform/tenant-qatar-airways/binauth.tf`), not in this pipeline.

**Not yet in the pipeline:** static security analysis of the source (a tool Qatar Airways may name), and the browser and accessibility suites on every change.
