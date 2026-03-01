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

const SYSTEM_PROMPT = `You are a strict medical data extraction engine. Your task is to extract medicine-related entities and the overall medical condition/diagnosis from the given text.

RULES:
1. Extract ONLY medicines, tablets, injections, capsules, and syrups.
2. Normalize medicine names and forms.
3. Focus on brand names and their numeric variants (suffixes like 625, 650, 500).
4. Extract numeric suffixes as "brand_variant".
5. Normalize frequency: BD=2, OD=1, TDS=3, SOS=1, HS=1, QID=4.
6. Extract duration as an integer.
7. Ignore header text, clinic details, patient names, and dates.
8. Explicitly ignore non-drug orders: X-rays, MRI, blood tests, Physiotherapy, exercise, or lifestyle advice.
9. High Priority: Extract the "medical_condition" or "diagnosis" (e.g., "Hypoglycemia", "Respiratory Infection", "Hypertension", "Fever"). Look for keywords like "Impression", "Imp", "Diagnosis", "Diag", "Suffering from", "C/o", or "Advised for".
10. If multiple conditions are found, join them into a single concise string.
11. If no medicines or diagnosis are found, return {"medicines": [], "medical_condition": null}.

JSON SCHEMA:
{
  "medicines": [
    {
      "brand_name": "string",
      "brand_variant": "string or null",
      "form_normalized": "Tablet | Capsule | Injection | Syrup | null",
      "frequency_per_day": integer or null,
      "duration_days": integer or null
    }
  ],
  "medical_condition": "string or null"
}

EXAMPLE:
Input: "Diagnosis: Type 2 Diabetes. Metformin 500mg OD x 30 days"
Output: {
  "medicines": [...],
  "medical_condition": "Type 2 Diabetes"
}

NOTE: The medical_condition field is mandatory in the JSON output, even if it is null.
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
