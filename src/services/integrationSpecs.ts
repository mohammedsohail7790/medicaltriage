import { INTEGRATIONS } from "./integrationRegistry.js";
import { buildDataCatalogue } from "./dataCatalogue.js";

/**
 * The specification of every data handoff and integration (NFR-054, NFR-155): what is exchanged, how, how often, what happens on
 * error and who is responsible. The registry (integrationRegistry.ts) says whether each is configured and live; this says what it is.
 * docs/integration-handoff-spec.md and docs/compliance/data-flow-assessment.md are generated from it, and a test fails if an
 * integration in the registry has no specification here.
 */

export type IntegrationSpec = {
  name: string;
  direction: "outbound" | "inbound" | "both";
  purpose: string;
  protocol: string;
  authentication: string;
  trigger: string;
  data: string[];
  dataClasses: Array<"personal" | "clinical" | "security" | "operational" | "credential">;
  mapping: string;
  errors: string;
  irisstarResponsible: string;
  customerResponsible: string;
  status: string;
};

const RETRY = "Calls go through the shared outbound client: a failure on the network or a 5xx is retried with doubling back-off (INTEGRATION_<NAME>_RETRIES, default 3), a 4xx never is, and a full queue refuses with 503. Every call is in the interface log with its correlation id.";

export const INTEGRATION_SPECS: IntegrationSpec[] = [
  { name: "qhie", direction: "outbound", purpose: "Check a patient's consent and read exchange data before a note is written back.", protocol: "HTTPS, FHIR R4 JSON", authentication: "Bearer token (QHIE_ACCESS_TOKEN)", trigger: "One consent check per EMR write-back.", data: ["Patient identifier (Qatar ID)", "Consent resource query"], dataClasses: ["personal"], mapping: "Patient identifier to the FHIR Consent search parameter; the result decides whether the write-back proceeds.", errors: `${RETRY} A denied or unavailable consent stops the write-back and the nurse copies the note instead.`, irisstarResponsible: "The client, retries, logging and fallback.", customerResponsible: "The endpoint, credentials, consent model and availability.", status: "Built. Live endpoint and credentials depend on Qatar Airways." },
  { name: "emr-fhir", direction: "outbound", purpose: "Write the completed note to the hospital record.", protocol: "HTTPS, FHIR R4 DocumentReference (Cerner Millennium or Epic)", authentication: "Bearer token (FHIR_ACCESS_TOKEN or per-destination token)", trigger: "Once per completed case, on the nurse's request or queued (EMR_WRITEBACK_ASYNC).", data: ["Patient identifier", "Practitioner identifier", "SBAR note (text, base64)", "LOINC document type"], dataClasses: ["personal", "clinical"], mapping: "The compiled note becomes a DocumentReference attachment; patient and practitioner map to the subject and author references.", errors: `${RETRY} A queued write-back retries up to its limit, then moves to the dead-letter list for replay; the note stays in the encounter.`, irisstarResponsible: "The mapping, queue, retries and replay.", customerResponsible: "The FHIR endpoint, credentials, profiles and acceptance of the document type.", status: "Built and tested against stubs. Live endpoints depend on Qatar Airways." },
  { name: "oracle-hcm", direction: "inbound", purpose: "Keep staff and dependants current from the HR directory.", protocol: "HTTPS REST, JSON", authentication: "Credentials for the HR directory (ORACLE_HEALTH_BASE_URL and its secret)", trigger: "Scheduled directory sync, and on demand.", data: ["Staff identifier", "Name, department, job title, duty status", "Dependants", "Date of birth"], dataClasses: ["personal"], mapping: "HR fields to staff and dependant records; roles from directory groups.", errors: "A failed sync leaves the previous directory in place and is logged; it is retried on the next run.", irisstarResponsible: "The sync and its mapping.", customerResponsible: "The directory, its API and the group-to-role rules.", status: "Built. Live access depends on Qatar Airways." },
  { name: "teleconsult", direction: "outbound", purpose: "Hand a case to a teleconsultant physician after the nurse approves.", protocol: "HTTPS, JSON", authentication: "Bearer token (TELECONSULT_TOKEN)", trigger: "Once per approved escalation.", data: ["Case reference", "Urgency", "Nurse's question and case summary", "Nurse identifier"], dataClasses: ["personal", "clinical"], mapping: "The escalation record as sent; the answer is entered by the physician in this application.", errors: `${RETRY} A rejection is shown to the nurse and the escalation stays pending.`, irisstarResponsible: "The adapter, approval gate and queue.", customerResponsible: "The physician service, its endpoint and response times.", status: "Built; a dry run until the service address is set and the integration is switched live." },
  { name: "dlp", direction: "outbound", purpose: "Inspect an approved export before it is released.", protocol: "HTTPS, JSON", authentication: "As the DLP service requires (EXPORT_DLP_URL)", trigger: "Once per export.", data: ["Export metadata: kind, row count, field names"], dataClasses: ["operational"], mapping: "Metadata only; record contents are not sent.", errors: "EXPORT_DLP_FAIL_MODE decides whether an unavailable service blocks the export (closed) or lets it through with an audit entry (open).", irisstarResponsible: "The hook and its fail mode.", customerResponsible: "The DLP tool and its policy.", status: "Built. Depends on Qatar Airways' DLP tool." },
  { name: "archive-handoff", direction: "outbound", purpose: "Hand archived records to the designated archive system before local content is removed.", protocol: "HTTPS, signed JSON", authentication: "HMAC signature (ARCHIVE_HANDOFF_SECRET)", trigger: "Per retention run, per archived record.", data: ["The archived record, decrypted", "Record type and reference", "Content hash"], dataClasses: ["personal", "clinical"], mapping: "Record as stored, with its type and hash; the archive confirms receipt by hash.", errors: "A failed handoff keeps the record locally, raises an alert and fails the integrity check after 72 hours; nothing is removed until receipt is confirmed.", irisstarResponsible: "Signing, confirmation and the local purge rule.", customerResponsible: "The archive system, its storage and retention.", status: "Built. Depends on Qatar Airways' archive system." },
  { name: "captcha", direction: "outbound", purpose: "Verify a challenge solved at sign-in after repeated failures.", protocol: "HTTPS, form post", authentication: "Provider secret (CAPTCHA_SECRET)", trigger: "Sign-in attempts that need a challenge.", data: ["Challenge token", "Client address"], dataClasses: ["security"], mapping: "Token to the provider's verification endpoint.", errors: "CAPTCHA_FAIL_MODE decides whether an unavailable provider blocks sign-in or admits it with a log entry.", irisstarResponsible: "The check and its fail mode.", customerResponsible: "Choice of provider and its availability.", status: "Built; a self-hosted challenge is the default." },
  { name: "message-broker", direction: "outbound", purpose: "Publish platform events (CloudEvents) to Pub/Sub or a JMS bridge.", protocol: "HTTPS (Pub/Sub REST) or signed HTTPS bridge", authentication: "Google identity or token; HMAC for the bridge", trigger: "Each audited event.", data: ["Event type, reference and changed field names; never record contents"], dataClasses: ["operational"], mapping: "Audit event to a CloudEvents 1.0 envelope.", errors: "Published through the integration queue with retries and dead-letter; an outage never blocks the product.", irisstarResponsible: "The publisher and event catalogue (docs/asyncapi.json).", customerResponsible: "The topic, subscribers and consumption.", status: "Built." },
  { name: "audit-sink", direction: "outbound", purpose: "Forward the audit ledger to the security information and event management system.", protocol: "HTTPS, signed JSON batches", authentication: "HMAC signature (AUDIT_FORWARD_SECRET)", trigger: "Each committed audit event, in batches.", data: ["Audit events with their chain hashes"], dataClasses: ["security", "personal"], mapping: "Ledger entry as stored, with sequence number and hashes so the receiver can verify the chain.", errors: "Retried with back-off; a failing store never affects the ledger; replay is available.", irisstarResponsible: "Forwarding, signing and replay.", customerResponsible: "The collector and its retention.", status: "Built. Depends on Qatar Airways' collector." },
  { name: "twilio", direction: "both", purpose: "Voice, SMS and WhatsApp with staff, and the inbound call-centre events.", protocol: "HTTPS, form-encoded", authentication: "HMAC-SHA1 signature inbound; basic authentication outbound", trigger: "One request per message or call event.", data: ["Phone numbers", "Message text", "Call event metadata"], dataClasses: ["personal"], mapping: "Provider fields to inbound message records and outbound drafts approved by a nurse.", errors: RETRY, irisstarResponsible: "Verification, drafting, approval and sending.", customerResponsible: "The provider account and number ownership.", status: "Built; a dry-run transport until configured." },
  { name: "msgraph-mail", direction: "outbound", purpose: "Send approved email, including referral letters with their PDF attached.", protocol: "HTTPS, Microsoft Graph JSON", authentication: "OAuth client credentials", trigger: "One request per approved message.", data: ["Recipient address", "Subject and body", "Attachment (referral PDF)"], dataClasses: ["personal", "clinical"], mapping: "Message to a Graph sendMail request; recipients are limited to approved domains.", errors: RETRY, irisstarResponsible: "Approval, domain restriction and sending.", customerResponsible: "The mailbox, tenant consent and approved recipient domains.", status: "Built; a dry-run transport until configured." }
];

export function renderIntegrationSpec(): string {
  const registry = new Map(INTEGRATIONS.map((i) => [i.name, i]));
  const sections = INTEGRATION_SPECS.map((s) => {
    const r = registry.get(s.name);
    return `## ${r?.label ?? s.name} (\`${s.name}\`)

${s.purpose}

| | |
|---|---|
| Direction | ${s.direction} |
| Protocol | ${s.protocol} |
| Authentication | ${s.authentication} |
| When it runs | ${s.trigger} |
| Data exchanged | ${s.data.join("; ")} |
| Kinds of data | ${s.dataClasses.join(", ")} |
| Mapping | ${s.mapping} |
| Settings it needs | ${(r?.requiredConfig ?? []).map((c) => `\`${c}\``).join(", ") || "none"} |
| Errors and retries | ${s.errors} |
| IRISSTAR is responsible for | ${s.irisstarResponsible} |
| The customer is responsible for | ${s.customerResponsible} |
| Status | ${s.status} |
`;
  });
  return `# Integration and data-handoff specification

Generated by \`pnpm evidence:generate\` from \`src/services/integrationSpecs.ts\` and the integration registry. It covers every integration the application can run today: what is exchanged, how, how often, what happens on error and who is responsible (NFR-054, NFR-155). Whether each is configured and live in a deployment is shown in Admin, Integrations, Registry; an integration is live only when it is fully configured and explicitly set live.

A handoff that Qatar Airways agrees in addition to these is added as a new entry, with its fields, mapping, frequency, error handling and owners, before it is switched live. The older \`docs/integration-connectivity-touchpoints.md\` lists network addresses and sizes for firewall rules; this document is the current specification.

${sections.join("\n")}`;
}

export function renderDataFlowAssessment(): string {
  const catalogue = buildDataCatalogue();
  const fields = catalogue.tables.flatMap((t) => t.fields);
  const byClass = (c: string) => fields.filter((f) => f.classification === c);
  const encrypted = (c: string) => byClass(c).filter((f) => f.encrypted).length;
  const rows = ["clinical", "personal", "credential", "security", "operational", "reference"].map((c) => `| ${c} | ${byClass(c).length} | ${encrypted(c)} |`);
  const flows = INTEGRATION_SPECS.filter((s) => s.dataClasses.includes("personal") || s.dataClasses.includes("clinical")).map((s) => `| ${s.name} | ${s.direction} | ${s.dataClasses.join(", ")} | ${s.data.join("; ")} |`);
  return `# Data-flow assessment

Generated by \`pnpm evidence:generate\`. For review with the Data Protection Officer. It is a description of what the system holds and sends, drawn from the data catalogue (every table and field, classified) and the integration specification. It is not a legal opinion.

## What is held

The schema has ${catalogue.tables.length} tables and ${fields.length} fields. ${catalogue.tables.filter((t) => t.containsPersonalData).length} tables hold personal data and ${catalogue.tables.filter((t) => t.containsClinicalData).length} hold clinical data. Fields by kind, and how many of each are encrypted at rest with per-value envelope keys:

| Kind | Fields | Encrypted at rest |
|---|---|---|
${rows.join("\n")}

The full list is served by the catalogue endpoint (\`/api/v1/admin/data-catalogue\`, JSON or CSV), and a test fails when a field that looks personal or clinical is left unclassified.

## Where personal or clinical data leaves the system

| Integration | Direction | Kinds | Data |
|---|---|---|---|
${flows.join("\n")}

Events, webhooks and the message broker carry references and the names of changed fields, never record contents. Exports to the security information system are the audit ledger, which holds user and resource references. Every export of records needs approval by a second administrator and passes the DLP hook.

## Controls on those flows

- Transport: TLS on every outbound call; the database connection must require TLS in production.
- At rest: field-level encryption of clinical and personal fields; keys wrapped by a key provider with rotation; no key in code.
- Access: roles with least privilege; reads of confidential screens are audited; personal data is masked until a controlled reveal is approved.
- Retention: per-data-type policies, approved before any purge, with legal holds; clinical data is archived before removal; audit events are never purged.
- Residency: the deployment checks every region it uses against an approved list at start-up.

## Open points for the Data Protection Officer

- The lawful basis and the notice given to staff and dependants for each flow above.
- Retention periods per data type (the engine enforces what is approved; the periods are Qatar Airways' to set).
- Whether data may leave the approved regions for any integration (the design assumes not).
- The processor and sub-processor list for any live integration.
`;
}
