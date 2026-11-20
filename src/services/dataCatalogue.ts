import { Prisma } from "@prisma/client";
import { ENCRYPTED_FIELDS } from "./fieldEncryption.js";

/**
 * Data catalogue and classification (AI-016).
 *
 * Every table and field of the database is listed with a classification label, so the data can be
 * discovered and governed from a platform such as Microsoft Purview. The catalogue is built from
 * the live schema, so it cannot drift from it, and a test fails if a field that looks personal or
 * clinical is left unclassified.
 *
 * Classes, from most to least sensitive:
 *   credential   secrets, keys, password hashes, tokens
 *   clinical     health information about a person
 *   personal     identifies a person (name, contact details, staff and licence numbers, date of birth)
 *   security     audit, session, device and network records
 *   operational  system and workflow data
 *   reference    clinical content and configuration that is not about an individual
 */

export type DataClass = "credential" | "clinical" | "personal" | "security" | "operational" | "reference";
const ORDER: DataClass[] = ["credential", "clinical", "personal", "security", "operational", "reference"];

// Explicit decisions for fields whose names do not say what they hold. Key: Model.field
const OVERRIDES: Record<string, DataClass> = {
  "TriageQueueItem.summary": "clinical",
  "TriageQueueItem.vitals": "clinical",
  "TriageQueueItem.clinicalApproval": "clinical",
  "TriageQueueItem.queuePayload": "clinical",
  "TriageQueueItem.istStaffId": "personal",
  "TriageQueueItem.destinationName": "clinical",
  "TriageQueueItem.dispositionCode": "clinical",
  "TriageQueueItem.calculatedSeverity": "clinical",
  "TriageQueueItem.matchedProtocolId": "clinical",
  "AviationTriageEncounter.finalDispositionCode": "clinical",
  "AviationTriageEncounter.initialAcuityScore": "clinical",
  "AviationTriageEncounter.transcriptText": "clinical",
  "AviationTriageEncounter.audioRecordingUrl": "clinical",
  "AviationTriageEncounter.clipboardPayload": "clinical",
  "AviationTriageEncounter.nurseId": "personal",
  "SafetyAuditDeviationLog.nurseOverrideRationale": "clinical",
  "SafetyAuditDeviationLog.explainabilityTrace": "clinical",
  "SafetyAuditDeviationLog.originalAiRecommendation": "clinical",
  "StaffMember.istStaffId": "personal",
  "StaffMember.dateOfBirth": "personal",
  "StaffMember.insuranceProvider": "personal",
  "Dependent.fullName": "personal",
  "Dependent.dateOfBirth": "personal",
  "Dependent.biologicalSex": "personal",
  "Dependent.age": "personal",
  "VoiceAssessmentTurn.transcriptText": "clinical",
  "VoiceAssessmentTurn.structuredAnswer": "clinical",
  "VoiceAssessmentTurn.interpreterEvidence": "clinical",
  "VoiceAssessmentTurn.nurseCorrectedAnswer": "clinical",
  "VoiceAssessmentTurn.validationComment": "clinical",
  "VoiceAssessmentTurn.promptTextSnapshot": "reference",
  "CcpDraft.body": "personal",
  "CcpWebhookRecord.body": "personal",
  "CcpWebhookRecord.queueNote": "personal",
  "CcpWebhookRecord.attachments": "personal",
  "CcpWebhookRecord.rawPayload": "personal",
  "ApplicationUser.fullName": "personal",
  "ApplicationUser.employeeId": "personal",
  "ApplicationUser.hrmsId": "personal",
  "ApplicationUser.jobTitle": "personal",
  "ArchivedRecord.payload": "clinical",
  "AuditEvent.metadata": "security",
  "AuditEvent.userId": "personal",
  "UserSession.sessionPayload": "credential",
  "PasswordHistory.passwordHash": "credential",
  "LoginNonce.nonce": "security",
  "WebhookSubscription.name": "operational",
  "ApiConsumer.name": "operational",
  "ApiConsumer.decisionNote": "operational",
  "ApiConsumer.organization": "operational",
  "ApiConsumer.contactEmail": "personal",
  "ApiConsumer.purpose": "operational",
  "ApiConsumer.clientSecretHash": "credential",
  "EventRule.name": "operational",
  "WebhookSubscription.url": "operational",
  "IntegrationJob.payload": "operational",
  "WebhookDelivery.payload": "operational",
  "EventRule.condition": "operational",
  "InterfaceLog.payload": "operational",
  // Reviewed: names of configuration objects and schema elements, not data about a person.
  "Organization.name": "operational",
  "CallCenterSession.queueName": "operational",
  "RagRetrievalEvent.retrievedSnippetHashes": "operational",
  "LlmShadowSuggestion.modelName": "operational",
  "ModelEvaluationRun.runName": "operational",
  "ModelEvaluationRun.modelName": "operational",
  "ModelEvaluationRun.failureSummary": "operational",
  "Role.name": "operational",
  "Responsibility.name": "operational",
  "AccessProfile.name": "operational",
  "AccessScope.name": "operational",
  "ClinicalScope.name": "operational",
  "IntegrationScope.name": "operational",
  "SegregationOfDutyRule.name": "operational",
  "AuthenticationProvider.name": "operational",
  "DataClassification.name": "operational",
  "SensitiveDataField.entityName": "operational",
  "SensitiveDataField.fieldName": "operational",
  "EncryptionPolicy.name": "operational",
  "MaskingPolicy.name": "operational",
  "RevealPolicy.name": "operational",
  "RevealRequest.fieldName": "operational",
  "RevealEvent.fieldName": "operational",
  "RetentionPolicy.name": "operational",
  "RetentionPolicy.entityName": "operational",
  "ArchivedRecord.entityName": "operational",
  "MdbAlgorithm.typeName": "operational",
  "MdbAlgorithm.systemName": "operational",
  "MdbSupplemental.filename": "operational",
  // Reviewed: a hash of the caller's number, and free-text notes on a privacy request.
  "CallCenterSession.aniHash": "personal",
  "PrivacyRequest.notes": "personal"
};

// Name patterns, tried in order; the first match decides. Applied to the field name.
const RULES: Array<[RegExp, DataClass]> = [
  [/(password|passwd|secret|token|ciphertext|apikey|api_key|privatekey|hmac|salt|credential|sessionhash|blindindex|otp)/i, "credential"],
  [/(transcript|vitals?|symptom|diagnos|disposition|triage|severity|acuity|clinical|narrative|rationale|prescription|protocol|assessment)/i, "clinical"],
  [/(ipaddress|useragent|device|session|eventhash|previoushash|keyversion|sequencenumber|actor|auditsignature)/i, "security"],
  [/(fullname|firstname|lastname|email|mobile|phone|birth|dob|licen[cs]e|address|nationality|staffid|employeeid|identifier)/i, "personal"]
];

// Tables that hold clinical content or configuration rather than anything about a person.
const REFERENCE_MODELS = /^(Mdb|Algorithm|InitialAssessmentQuestion|Protocol|Content|Clinical(?!Scope)|Stcc|Role$|Permission$|Responsibility$|DataClassification$|RetentionPolicy$|PasswordPolicy$)/;

export type CatalogueField = {
  name: string;
  column: string;
  type: string;
  nullable: boolean;
  classification: DataClass;
  basis: "override" | "rule" | "default";
  encrypted: boolean;
  isId: boolean;
};

export type CatalogueTable = {
  entity: string;
  table: string;
  classification: DataClass;
  containsPersonalData: boolean;
  containsClinicalData: boolean;
  fields: CatalogueField[];
};

export function classifyField(entity: string, field: string): { classification: DataClass; basis: CatalogueField["basis"] } {
  const override = OVERRIDES[`${entity}.${field}`];
  if (override) return { classification: override, basis: "override" };
  if (/^(id|createdAt|updatedAt|createdBy|updatedBy|status|code|deletedAt|deletedBy)$/.test(field)) return { classification: "operational", basis: "rule" };
  for (const [pattern, label] of RULES) if (pattern.test(field)) return { classification: label, basis: "rule" };
  return { classification: REFERENCE_MODELS.test(entity) ? "reference" : "operational", basis: "default" };
}

export function buildDataCatalogue(): { generatedAt: string; schemaVersion: string; tables: CatalogueTable[] } {
  const tables = Prisma.dmmf.datamodel.models.map((model): CatalogueTable => {
    const encrypted = ENCRYPTED_FIELDS[model.name] ?? {};
    const fields = model.fields
      .filter((field) => field.kind !== "object")
      .map((field): CatalogueField => {
        const { classification, basis } = classifyField(model.name, field.name);
        return {
          name: field.name,
          column: field.dbName ?? field.name,
          type: field.kind === "enum" ? `enum ${field.type}` : field.type,
          nullable: !field.isRequired,
          classification,
          basis,
          encrypted: Boolean(encrypted[field.name]) || /ciphertext/i.test(field.name),
          isId: field.isId
        };
      });
    const present = new Set(fields.map((field) => field.classification));
    return {
      entity: model.name,
      table: model.dbName ?? model.name,
      classification: ORDER.find((label) => present.has(label)) ?? "operational",
      containsPersonalData: present.has("personal") || present.has("clinical"),
      containsClinicalData: present.has("clinical"),
      fields
    };
  });
  return { generatedAt: new Date().toISOString(), schemaVersion: Prisma.prismaVersion.client, tables };
}

const csvCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;

/** One row per field, the shape most governance platforms import. */
export function dataCatalogueCsv(catalogue = buildDataCatalogue()): string {
  const header = ["table", "entity", "table_classification", "column", "field", "type", "nullable", "classification", "encrypted_at_rest"];
  const rows = catalogue.tables.flatMap((table) =>
    table.fields.map((field) => [table.table, table.entity, table.classification, field.column, field.name, field.type, field.nullable, field.classification, field.encrypted].map(csvCell).join(","))
  );
  return [header.join(","), ...rows].join("\n");
}

/** Fields whose names suggest sensitive data but that fell through to a default label. */
export function unreviewedSensitiveFields(): string[] {
  const hint = /(name|email|mobile|phone|birth|licen|transcript|summary|note|vital|narrative|address|password|secret|token|hash|cipher)/i;
  return buildDataCatalogue().tables.flatMap((table) =>
    table.fields.filter((field) => field.basis === "default" && hint.test(field.name)).map((field) => `${table.entity}.${field.name}`)
  );
}
