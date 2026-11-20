import type { TriageCompleteRequest } from "../types/triage.js";

/** Set by the server from the signed-in session, never taken from the request (F-015). */
export type NoteRequest = TriageCompleteRequest & { nurseName?: string };

function adviceLine(request: NoteRequest, arabic: boolean): string {
  if (!request.adviceDelivery) return arabic ? "تسليم نصائح الرعاية: غير مسجل" : "Care advice: not recorded";
  if (arabic) return `تسليم نصائح الرعاية: ${request.adviceDelivery === "give_now" ? "قُدمت أثناء المكالمة" : "ستُرسل لاحقاً"}`;
  return `Care advice: ${request.adviceDelivery === "give_now" ? "given to the caller now" : "to be sent later"}`;
}

function destinationLine(request: NoteRequest, arabic: boolean): string {
  const d = request.destinationContact;
  if (!d) return arabic ? `الوجهة: ${request.routingDestination}` : `Destination: ${request.routingDestination}`;
  const parts = [d.name, d.phone && `${arabic ? "هاتف" : "phone"} ${d.phone}`, d.hours && `${arabic ? "الساعات" : "hours"} ${d.hours}`, d.address].filter(Boolean);
  return `${arabic ? "الوجهة" : "Destination"}: ${parts.join("; ")}`;
}

function line(label: string, value?: string | number): string {
  if (value === undefined || value === null || value === "") {
    return `${label}: Not recorded`;
  }
  return `${label}: ${value}`;
}

function vitalsLine(request: NoteRequest): string {
  if (!request.vitals) {
    return "Vitals: Not recorded in completion payload";
  }

  return [
    `HR ${request.vitals.heartRate} bpm`,
    `RR ${request.vitals.respiratoryRate}/min`,
    `SpO2 ${request.vitals.spo2}%`,
    `Temp ${request.vitals.temperatureC} C`,
    `Conscious ${request.vitals.consciousLevel}`
  ].join("; ");
}

function aviationTags(request: NoteRequest): string {
  return request.customAviationTags.length > 0 ? request.customAviationTags.join(", ") : "None recorded";
}

export function compileBilingualSoapSbarMarkdown(request: NoteRequest): string {
  const generatedAt = new Date().toISOString();
  const patientLabel =
    request.patientName ??
    (request.istStaffId ? `IST staff ${request.istStaffId}` : "Patient identity held in active session");

  return [
    "# IST Qatar Tele-Triage SOAP/SBAR Note",
    "",
    "## English",
    "",
    "### SOAP",
    line("Subjective", request.subjective ?? request.chiefComplaint),
    line("Objective", request.objective ?? vitalsLine(request)),
    line("Assessment", request.assessment ?? request.safetyRationale ?? request.finalDispositionCode),
    line("Plan", request.recommendation ?? request.routingDestination),
    "",
    "### SBAR",
    `Situation: ${patientLabel} reports ${request.chiefComplaint}.`,
    `Background: Encounter ${request.encounterId ?? "not persisted"}; nurse ${request.nurseName ? `${request.nurseName} (${request.nurseId})` : request.nurseId ?? "not recorded"}; age ${request.patientAgeYears ?? "not recorded"}; aviation tags ${aviationTags(request)}.`,
    `Assessment: Final deterministic disposition ${request.finalDispositionCode}. ${request.safetyRationale ?? "No additional rationale recorded."}`,
    `Recommendation: Route to ${request.routingDestination}.`,
    destinationLine(request, false),
    adviceLine(request, false),
    "",
    "## العربية - ملخص الحالة السريرية",
    "",
    "### SOAP",
    line("الشكوى", request.subjective ?? request.chiefComplaint),
    line("الملاحظات الموضوعية", request.objective ?? vitalsLine(request)),
    line("التقييم", request.assessment ?? request.safetyRationale ?? request.finalDispositionCode),
    line("الخطة", request.recommendation ?? request.routingDestination),
    "",
    "### SBAR",
    `الحالة: ${patientLabel} - ${request.chiefComplaint}.`,
    `الخلفية: رقم المقابلة ${request.encounterId ?? "غير محفوظ"}؛ الممرض/ة ${request.nurseName ? `${request.nurseName} (${request.nurseId})` : request.nurseId ?? "غير مسجل"}؛ العمر ${request.patientAgeYears ?? "غير مسجل"}؛ وسوم الطيران ${aviationTags(request)}.`,
    `التقييم: المسار النهائي المحدد بالقواعد ${request.finalDispositionCode}. ${request.safetyRationale ?? "لا توجد ملاحظات إضافية."}`,
    `التوصية: التحويل إلى ${request.routingDestination}.`,
    destinationLine(request, true),
    adviceLine(request, true),
    "",
    "## Governance",
    "- Rules-first, AI-second: this note records deterministic routing. AI may assist transcription/explanation only.",
    "- PHI persistence: this Markdown is returned to the active client session for clipboard use; the MVP API does not persist it.",
    `- Generated at: ${generatedAt}`
  ].join("\n");
}
