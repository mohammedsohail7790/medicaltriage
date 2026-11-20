import path from "node:path";
import PDFDocument from "pdfkit";

/**
 * Referral letter as a bilingual PDF (F-017): English on the left, Arabic on the right (right to left, shaped
 * with Noto Sans Arabic). Each field is a row; its label is printed in both languages and its value in the font
 * that can draw it. Letters are marked DRAFT until a nurse has approved them.
 */

export type ReferralFields = {
  patientName?: string;
  istStaffId?: string;
  patientAgeYears?: number;
  destinationName: string;
  destinationPhone?: string;
  destinationHours?: string;
  destinationAddress?: string;
  reason: string;
  assessment: string;
  recommendation: string;
  adviceDelivery?: "give_now" | "send_later";
  nurseName: string;
  issuedAtIso: string;
  reference: string;
};

function arabicFontPath(): string {
  return path.resolve(process.cwd(), "node_modules", "@fontsource", "noto-sans-arabic", "files", "noto-sans-arabic-arabic-400-normal.woff");
}

const ARABIC = /[\u0600-\u06FF]/;
// The shaping library used by the PDF writer fails on some combining marks (vowel signs), so they are removed.
const MARKS = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const forArabicFont = (text: string) => text.replace(MARKS, "");

const ROWS: Array<{ en: string; ar: string; value: (f: ReferralFields) => string | undefined }> = [
  { en: "Reference", ar: "المرجع", value: (f) => f.reference },
  { en: "Date", ar: "التاريخ", value: (f) => f.issuedAtIso.slice(0, 10) },
  { en: "Patient", ar: "المريض", value: (f) => f.patientName ?? (f.istStaffId ? `IST staff ${f.istStaffId}` : undefined) },
  { en: "Age", ar: "العمر", value: (f) => (f.patientAgeYears === undefined ? undefined : String(f.patientAgeYears)) },
  { en: "Referred to", ar: "محال إلى", value: (f) => f.destinationName },
  { en: "Telephone", ar: "الهاتف", value: (f) => f.destinationPhone },
  { en: "Opening hours", ar: "ساعات العمل", value: (f) => f.destinationHours },
  { en: "Address", ar: "العنوان", value: (f) => f.destinationAddress },
  { en: "Reason for referral", ar: "سبب الإحالة", value: (f) => f.reason },
  { en: "Assessment", ar: "التقييم", value: (f) => f.assessment },
  { en: "Recommendation", ar: "التوصية", value: (f) => f.recommendation },
  { en: "Care advice", ar: "نصائح الرعاية", value: (f) => (f.adviceDelivery ? (f.adviceDelivery === "give_now" ? "Given to the caller during the call" : "To be sent later") : undefined) },
  { en: "Triage nurse", ar: "ممرضة الفرز", value: (f) => f.nurseName }
];

type Doc = InstanceType<typeof PDFDocument>;

/**
 * Draws Arabic text right-aligned and returns the height used. Ordinary spaces are drawn as no-break spaces (the
 * PDF writer's own wrapping reorders Arabic words around them), so lines are broken here instead. If the shaping
 * library cannot lay a string out, the letter still renders without it.
 */
function arabicText(doc: Doc, text: string, x: number, y: number, options: { width: number }): number {
  const lineHeight = doc.currentLineHeight(true);
  try {
    const lines: string[] = [];
    let current: string[] = [];
    for (const word of forArabicFont(text).split(/\s+/).filter(Boolean)) {
      const candidate = [...current, word].join("\u00A0");
      if (current.length > 0 && doc.widthOfString(candidate) > options.width) {
        lines.push(current.join("\u00A0"));
        current = [word];
      } else {
        current.push(word);
      }
    }
    if (current.length > 0) lines.push(current.join("\u00A0"));
    lines.forEach((line, index) => doc.text(line, x, y + index * lineHeight, { width: options.width, align: "right", lineBreak: false }));
    return Math.max(lines.length, 1) * lineHeight;
  } catch {
    doc.font("Helvetica").text("-", x, y, { width: options.width, align: "right" });
    return lineHeight;
  }
}

export function renderReferralPdf(fields: ReferralFields, options: { approved: boolean }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Referral ${fields.reference}`, Author: "IST Tele-Triage" } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.registerFont("ar", arabicFontPath());
    const left = 48;
    const width = doc.page.width - 96;
    const half = width / 2 - 8;
    const rightX = left + width / 2 + 8;

    doc.font("Helvetica-Bold").fontSize(16).fillColor("#111827").text("Referral letter", left, 48, { width: half });
    doc.font("ar").fontSize(18);
    arabicText(doc, "خطاب إحالة", rightX, 46, { width: half });
    doc.moveTo(left, 82).lineTo(left + width, 82).strokeColor("#d1d5db").stroke();
    if (!options.approved) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#b45309").text("DRAFT - not approved by the nurse, do not send", left, 88, { width });
    }

    let y = 108;
    for (const row of ROWS) {
      const value = row.value(fields);
      if (!value) continue;
      const arabicValue = ARABIC.test(value);
      const valueFont = arabicValue ? "ar" : "Helvetica";
      const shown = arabicValue ? forArabicFont(value) : value;
      doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text(row.en.toUpperCase(), left, y, { width: half });
      doc.font("ar").fontSize(10).fillColor("#6b7280");
      arabicText(doc, row.ar, rightX, y - 2, { width: half });
      y += 14;
      doc.font(valueFont).fontSize(11).fillColor("#111827");
      let height = 14;
      if (arabicValue) {
        height = arabicText(doc, shown, left, y, { width });
      } else {
        height = doc.heightOfString(shown, { width });
        doc.text(shown, left, y, { width });
      }
      y += Math.max(height, 14) + 8;
      if (y > doc.page.height - 120) {
        doc.addPage();
        y = 60;
      }
    }

    doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text(
      "This letter was prepared from a tele-triage assessment and reviewed by the triage nurse named above. It is not a diagnosis.",
      left, doc.page.height - 90, { width }
    );
    doc.font("ar").fontSize(9);
    arabicText(doc, ("أُعدّ هذا الخطاب بناءً على تقييم الفرز عن بُعد وراجعته الممرضة المذكورة أعلاه، وهو ليس تشخيصا."), left, doc.page.height - 74, { width });
    doc.end();
  });
}
