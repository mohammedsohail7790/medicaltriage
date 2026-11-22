# Production preflight

`npm run preflight:production` (`scripts/productionPreflight.ts`) checks the environment a production deploy will use and lists every problem at once. The server's own start-up check stops at the first one.

It fails when: `NODE_ENV` is not `production`; `MOCK_MODE` is on; demo credentials are enabled; a signing or encryption secret, the database URLs, the audit secret or any database-persistence flag is missing; or `CALL_CENTER_GATEWAY_SECRET` is not set. It warns when field encryption is not held in Cloud KMS, the scheduler is not external, or no CORS origins are set.

It reads configuration only. It does not connect to the database, Cloud KMS or any other service, so a pass does not show those are reachable.

Related behaviour (22 Nov 2026):
- The built-in call-centre test secret is used only where demo credentials are allowed, never under `NODE_ENV=production` unless an operator turns them on.
- When a safety floor keeps a call at EMERGENCY and a request tries to lower severity, disposition or destination, the attempt is recorded as `QUEUE_SAFETY_FLOOR_DOWNGRADE_BLOCKED` in the audit trail.
- The product name in page headings is set with `window.__APP_BRAND__ = { productName: "..." }` (default "IST Health"). Only page headings, the login card and the SBAR note title use it; help text and seeded destination names still say "IST Health".
