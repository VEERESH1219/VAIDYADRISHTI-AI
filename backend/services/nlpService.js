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

const SYSTEM_PROMPT = `You are a medical data extraction engine. Extract medicines and diagnosis from prescription text.

OUTPUT: Return ONLY a valid JSON object. No explanation, no markdown, no extra text.

RULES:
- brand_name: the medicine name (e.g. "Paracetamol", "Amoxicillin", "Cetirizine"). NEVER null if a medicine is present.
- brand_variant: numeric strength suffix only (e.g. "500", "625", "10"). null if no numeric variant.
- form_normalized: ONLY set if EXPLICITLY written in the text (e.g. "Tab" → "Tablet", "Cap" → "Capsule", "Inj" → "Injection", "Syr" → "Syrup"). If the form is NOT written, set null. Do NOT guess or infer.
- frequency_per_day: integer. BD=2, OD=1, TDS=3, QID=4, HS=1, SOS=1. null if not stated.
- duration_days: integer number of days. null if not stated.
- medical_condition: the diagnosis or condition string. null if not found.
- Ignore: X-rays, MRI, blood tests, physiotherapy, patient names, dates, clinic details.

JSON FORMAT (return exactly this structure):
{"medicines":[{"brand_name":"string","brand_variant":"string or null","form_normalized":"Tablet or Capsule or Injection or Syrup or null","frequency_per_day":2,"duration_days":5}],"medical_condition":"string or null"}

EXAMPLE 1 (form stated in text):
Input: "Diagnosis: Type 2 Diabetes. Tab Metformin 500mg OD x 30 days. Cap Amoxicillin 625 TDS x 7 days."
Output: {"medicines":[{"brand_name":"Metformin","brand_variant":"500","form_normalized":"Tablet","frequency_per_day":1,"duration_days":30},{"brand_name":"Amoxicillin","brand_variant":"625","form_normalized":"Capsule","frequency_per_day":3,"duration_days":7}],"medical_condition":"Type 2 Diabetes"}

EXAMPLE 2 (form NOT stated in text):
Input: "Diagnosis: Fever. Paracetamol 500mg BD x 5 days. Amoxicillin 625mg TDS x 7 days."
Output: {"medicines":[{"brand_name":"Paracetamol","brand_variant":"500","form_normalized":null,"frequency_per_day":2,"duration_days":5},{"brand_name":"Amoxicillin","brand_variant":"625","form_normalized":null,"frequency_per_day":3,"duration_days":7}],"medical_condition":"Fever"}
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
