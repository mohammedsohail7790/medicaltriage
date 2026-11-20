/**
 * Failure reason and likely cause for alerts (NFR-045). A job or delivery that fails is described with what went wrong, the
 * most likely reason, and what to check first, so whoever receives the alert can act without opening a log. The match is on the
 * error text and is a pointer, not a verdict; the raw message is always kept alongside.
 */

export type Diagnosis = { category: "network" | "timeout" | "authentication" | "rate_limit" | "remote_error" | "database" | "configuration" | "capacity" | "cancelled" | "unknown"; likelyCause: string; firstCheck: string };

const RULES: Array<[RegExp, Diagnosis]> = [
  [/cancel/i, { category: "cancelled", likelyCause: "Someone cancelled the run.", firstCheck: "Look for a run-cancelled entry in the audit trail." }],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|fetch failed|network/i, { category: "network", likelyCause: "The other system could not be reached (it is down, the address is wrong, or the network blocks the call).", firstCheck: "Open Admin, Integrations: check the address is configured and run the connectivity test. Then check egress rules allow the address." }],
  [/ETIMEDOUT|timed? ?out|aborted|AbortError/i, { category: "timeout", likelyCause: "The other system answered too slowly or not at all.", firstCheck: "Check the interface's recent response times in Operations. If they are high, ask the owner of the other system." }],
  [/HTTP 401|HTTP 403|unauthori[sz]ed|forbidden|invalid[_ ]client|invalid token|authentication/i, { category: "authentication", likelyCause: "The credentials were refused: a token or secret has expired, been rotated, or is wrong.", firstCheck: "Check the secret's rotation date under Operations, Secrets, and that the other system accepts the current credential." }],
  [/HTTP 429|rate limit|too many requests/i, { category: "rate_limit", likelyCause: "The other system is limiting how fast we call it.", firstCheck: "Lower the call rate for this interface or ask for a higher limit; retries will back off on their own." }],
  [/HTTP 5\d\d|bad gateway|service unavailable/i, { category: "remote_error", likelyCause: "The other system is failing on its side.", firstCheck: "Check that system's status. The job retries; replay it from the dead-letter list once the system is back." }],
  [/HTTP 4\d\d/i, { category: "remote_error", likelyCause: "The other system rejected the request: its format or content is not what it expects.", firstCheck: "Read the interface log entry for the same correlation id and compare the payload with the other system's specification." }],
  [/prisma|database|P\d{4}|connection pool|deadlock|relation .* does not exist/i, { category: "database", likelyCause: "The database refused or could not complete the operation.", firstCheck: "Check the database alerts (availability, disk, connections) and whether a migration has been applied." }],
  [/not configured|missing|is not set|required config|no handler|unknown handler|approved domain/i, { category: "configuration", likelyCause: "A required setting is missing or wrong.", firstCheck: "Open Admin, Integrations, Registry and see which settings are missing for this integration." }],
  [/backpressure|queue is full|resource|memory|constrained|ENOMEM/i, { category: "capacity", likelyCause: "The service was too busy and refused new work.", firstCheck: "Look at resource pressure under Operations; the work is retried when load eases." }]
];

export function diagnoseFailure(message: string | null | undefined): Diagnosis {
  const text = String(message ?? "");
  for (const [pattern, diagnosis] of RULES) if (pattern.test(text)) return diagnosis;
  return { category: "unknown", likelyCause: "The cause is not recognised from the message.", firstCheck: "Read the full error and the trace for the run, then follow the first steps in the error catalogue." };
}
