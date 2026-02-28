/**
 * VAIDYADRISHTI AI — NLP Extraction Service
 *
 * Uses the configured LLM (via llmService) for clinical Named Entity Recognition.
 * Supports: openai (GPT-4o), anthropic (Claude), gemini, ollama (local).
 * Switch provider with MODEL_PROVIDER in .env
 */

import { chatJSON } from './llmService.js';
import dotenv from 'dotenv';

dotenv.config();

const SYSTEM_PROMPT = `You are an expert clinical pharmacist and medical data extraction engine. Extract all medicines and diagnosis from prescription text — including handwritten, abbreviated, and OCR-scanned prescriptions.

OUTPUT: Return ONLY a valid JSON object. No explanation, no markdown, no extra text.

MEDICINE NAME RULES:
- brand_name: the medicine/drug name. NEVER null if a medicine is present.
  Accept all formats: brand names (Crocin, Augmentin, Pantop, Sinarest, Dolo, Combiflam),
  generic names (Paracetamol, Amoxicillin, Cetirizine), abbreviations (PCM=Paracetamol).
  Fix OCR noise: "Paracetamcl"→"Paracetamol", "Amoxlcllin"→"Amoxicillin", "Cet1rizine"→"Cetirizine".
- brand_variant: numeric strength only (e.g. "500", "625", "10", "40"). null if absent.
- form_normalized: ONLY if explicitly written — Tab/T./Tab.=Tablet, Cap/C.=Capsule,
  Inj=Injection, Syr/Syp=Syrup, Oint/Cream=Ointment, Drops/Gtt=Drops. null if not written.

FREQUENCY RULES (convert to integer per day):
- OD / o.d. / once daily / 0-0-1 or 1-0-0 = 1
- BD / b.d. / twice daily / 1-0-1 = 2
- TDS / t.d.s. / thrice / 1-1-1 = 3
- QID / four times = 4
- SOS / p.r.n. / if required = 1
- HS / at bedtime / night only = 1
- null if not stated

DURATION RULES (convert to integer days):
- "x 5 days" / "5/7" / "for 5 days" = 5
- "1 week" / "1/52" = 7  |  "2 weeks" / "2/52" = 14
- "1 month" / "1/12" = 30
- null if not stated

OTHER RULES:
- medical_condition: the diagnosis or chief complaint. Expand abbreviations when confident:
  URTI=Upper Respiratory Tract Infection, UTI=Urinary Tract Infection, T2DM=Type 2 Diabetes Mellitus,
  HTN=Hypertension, GERD=Gastroesophageal Reflux Disease, CAP=Community Acquired Pneumonia.
  null if not found.
- IGNORE: X-rays, MRI, blood tests, physiotherapy, patient names, dates, clinic details,
  advice lines, follow-up instructions.
- Fix obvious OCR misspellings of known drug names.

JSON FORMAT (return exactly this structure):
{"medicines":[{"brand_name":"string","brand_variant":"string or null","form_normalized":"Tablet or Capsule or Injection or Syrup or Ointment or Drops or null","frequency_per_day":2,"duration_days":5}],"medical_condition":"string or null"}

EXAMPLE 1 — typed prescription:
Input: "Dx: URTI. Tab. Augmentin 625mg TDS x 7/7. Tab. Paracetamol 500 BD SOS. Syp. Benadryl 10ml TDS x 5d."
Output: {"medicines":[{"brand_name":"Augmentin","brand_variant":"625","form_normalized":"Tablet","frequency_per_day":3,"duration_days":7},{"brand_name":"Paracetamol","brand_variant":"500","form_normalized":"Tablet","frequency_per_day":2,"duration_days":null},{"brand_name":"Benadryl","brand_variant":"10","form_normalized":"Syrup","frequency_per_day":3,"duration_days":5}],"medical_condition":"Upper Respiratory Tract Infection"}

EXAMPLE 2 — OCR-garbled handwritten text:
Input: "Fev3r + cough. Paracetamcl 5OOmg 1-1-1 x5d Amoxlcllin 625 TDS 7days Cetirizlne 10mg HS 10/7"
Output: {"medicines":[{"brand_name":"Paracetamol","brand_variant":"500","form_normalized":null,"frequency_per_day":3,"duration_days":5},{"brand_name":"Amoxicillin","brand_variant":"625","form_normalized":null,"frequency_per_day":3,"duration_days":7},{"brand_name":"Cetirizine","brand_variant":"10","form_normalized":null,"frequency_per_day":1,"duration_days":10}],"medical_condition":"Fever with cough"}

EXAMPLE 3 — Indian shorthand:
Input: "Imp: T2DM. Tab Metformin 500 OD AC. Tab Glimepiride 1mg OD PC. Cap Methylcobalamin 500 BD x 1/12"
Output: {"medicines":[{"brand_name":"Metformin","brand_variant":"500","form_normalized":"Tablet","frequency_per_day":1,"duration_days":null},{"brand_name":"Glimepiride","brand_variant":"1","form_normalized":"Tablet","frequency_per_day":1,"duration_days":null},{"brand_name":"Methylcobalamin","brand_variant":"500","form_normalized":"Capsule","frequency_per_day":2,"duration_days":30}],"medical_condition":"Type 2 Diabetes Mellitus"}
`;

/**
 * Extract structured medicine entities from OCR text using OpenAI GPT-4o.
 *
 * @param {string} ocrText — raw OCR text from the consensus engine
 * @returns {Promise<Array>} — array of StructuredMedicine objects
 */
export async function runNLPExtraction(ocrText) {
  if (!ocrText || ocrText.trim().length === 0) {
    return { medicines: [], medical_condition: null };
  }

  let retries = 0;
  const maxRetries = 2;

  while (retries <= maxRetries) {
    try {
      const userMessage = `Process the following prescription text:\n\n${ocrText}`;

      console.log('[NLP] Input Length:', ocrText.length);
      console.log('[NLP] Full Input Text:\n', ocrText);

      const parsed = await chatJSON(SYSTEM_PROMPT, userMessage, 0);
      console.log('[NLP] Parsed result:', JSON.stringify(parsed));
      const medicines = Array.isArray(parsed.medicines) ? parsed.medicines : [];
      const medicalCondition = parsed.medical_condition || null;

      return {
        medicines: medicines.map((med, idx) => ({
          id: `ext_${String(idx + 1).padStart(3, '0')}`,
          brand_name: med.brand_name || '',
          brand_variant: med.brand_variant || null,
          form: med.form_normalized || null,
          frequency_per_day: typeof med.frequency_per_day === 'number' ? med.frequency_per_day : null,
          duration_days: typeof med.duration_days === 'number' ? med.duration_days : null,
        })),
        medical_condition: medicalCondition
      };
    } catch (err) {
      retries++;
      if (retries > maxRetries) {
        console.error('[NLP] All retries failed:', err.message);
        throw err;
      }
      console.warn(`[NLP] Attempt ${retries} failed, retrying...`);
    }
  }
  return { medicines: [], medical_condition: null };
}
