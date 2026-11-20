# Network requirements per user

Measured on 2026-11-21 against the application in simulation mode (25 open cases), as the server sends the responses (gzip). Run `pnpm network:estimate -- --nurses 80 --poll 10` to measure again and to estimate for Qatar Airways' projection.

| What a screen asks for | Size on the wire |
|---|---|
| Queue list (25 cases) | 11.9 KB |
| Queue list on a slow connection (data-saver) | 5.2 KB |
| One case | 2.6 KB |
| Triage note preview | 0.9 KB |
| Session check | 0.8 KB |

A nurse's screen refreshes the queue list about every 15 seconds and opens a few cases per call. With the placeholder projection (50 nurses, 5 manager boards, 6 calls per nurse per hour):

| Figure | Estimate |
|---|---|
| Per nurse | about 7 kbit/s |
| Per manager board | about 6 kbit/s |
| Whole site, average | about 0.4 Mbit/s |
| Whole site, with 50% headroom | about 0.6 Mbit/s |
| Per nurse per month (22 working days) | about 0.5 GB |

These are application traffic only. Voice, the browser's own downloads (the application bundle is fetched once and cached), single sign-on redirects and the load balancer's TLS overhead are extra. The figures are **not final**: the call and user counts are placeholders until Qatar Airways states its projected load (NFR-154), and the queue size grows with the number of open cases.
