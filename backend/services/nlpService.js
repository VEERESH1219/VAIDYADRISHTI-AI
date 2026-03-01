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

CRITICAL ANTI-HALLUCINATION RULES (highest priority):
- ONLY extract medicine names that are EXPLICITLY written in the input text.
- NEVER invent, guess, assume, or suggest medicine names that are not present in the text.
- NEVER use your training knowledge to fill in medicines. Only what is in the text.
- If the text is garbled, unreadable, random characters, or contains no recognizable medicine names → return {"medicines":[],"medical_condition":null}
- If you are not confident a word is a medicine name, do NOT include it.
- If the text is too short, unclear, or meaningless → return {"medicines":[],"medical_condition":null}

MEDICINE NAME RULES:
- brand_name: the medicine/drug name. NEVER null if a medicine is present.
  Accept all formats: brand names (Crocin, Augmentin, Pantop, Sinarest, Dolo, Combiflam),
  generic names, abbreviations (PCM=Paracetamol, MTF=Metformin, ASP=Aspirin).
  Fix minor OCR noise only when the corrected name is unambiguously clear from context.
- brand_variant: numeric STRENGTH only — e.g. "500", "625", "50", "20". null if absent.
  IMPORTANT: Dosage patterns like "0+0+1", "1+0+1", "1-0-1", "2+0+2" are FREQUENCIES, NOT brand_variant. Set brand_variant=null when only a dosage pattern is present.
- form_normalized: ONLY if explicitly written — Tab/T./Tab.=Tablet, Cap/C.=Capsule,
  Inj=Injection, Syr/Syp=Syrup, Oint/Cream=Ointment, Drops/Gtt=Drops. null if not written.

FREQUENCY RULES (convert to total tablets/doses per day as integer):
Standard shorthand:
- OD / once daily = 1
- BD / twice daily = 2
- TDS / thrice = 3
- QID / four times = 4
- SOS / PRN / if needed = 1
- HS / bedtime / night only = 1

Dash-notation (morning-afternoon-night, count the non-zero positions):
- 0-0-1 or 1-0-0 = 1  |  1-0-1 = 2  |  1-1-1 = 3

Plus-notation used in Indian prescriptions (morning+afternoon+night, sum the values):
- 0+0+1 or 1+0+0 = 1  |  1+0+1 = 2  |  1+1+1 = 3  |  2+0+2 = 4
- Always sum the three numbers: A+B+C → frequency = A+B+C (if all ≤ 2)
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

JSON FORMAT (return exactly this structure):
{"medicines":[{"brand_name":"string","brand_variant":"string or null","form_normalized":"Tablet or Capsule or Injection or Syrup or Ointment or Drops or null","frequency_per_day":2,"duration_days":5}],"medical_condition":"string or null"}

EXAMPLE 1 — typed prescription:
Input: "Dx: URTI. Tab. Augmentin 625mg TDS x 7/7. Tab. Dolo 650 BD SOS. Syp. Benadryl 10ml TDS x 5d."
Output: {"medicines":[{"brand_name":"Augmentin","brand_variant":"625","form_normalized":"Tablet","frequency_per_day":3,"duration_days":7},{"brand_name":"Dolo","brand_variant":"650","form_normalized":"Tablet","frequency_per_day":2,"duration_days":null},{"brand_name":"Benadryl","brand_variant":"10","form_normalized":"Syrup","frequency_per_day":3,"duration_days":5}],"medical_condition":"Upper Respiratory Tract Infection"}

EXAMPLE 2 — OCR-garbled unreadable text (RETURN EMPTY):
Input: "Fev3r xyzabc 5OOmg 1-1-1 x5d qwrtlmn 625 TDS 7days zzzpqr 10mg HS 10/7"
Output: {"medicines":[],"medical_condition":null}

EXAMPLE 3 — Indian shorthand:
Input: "Imp: T2DM. Tab Metformin 500 OD AC. Tab Glimepiride 1mg OD PC. Cap Methylcobalamin 500 BD x 1/12"
Output: {"medicines":[{"brand_name":"Metformin","brand_variant":"500","form_normalized":"Tablet","frequency_per_day":1,"duration_days":null},{"brand_name":"Glimepiride","brand_variant":"1","form_normalized":"Tablet","frequency_per_day":1,"duration_days":null},{"brand_name":"Methylcobalamin","brand_variant":"500","form_normalized":"Capsule","frequency_per_day":2,"duration_days":30}],"medical_condition":"Type 2 Diabetes Mellitus"}

EXAMPLE 4 — Cardiac/HTN prescription:
Input: "Dx: HTN + GERD. Tab Metoprolol 50mg BD x 30d. Tab Atorvastatin 10mg OD HS. Tab Pantoprazole 40mg OD AC."
Output: {"medicines":[{"brand_name":"Metoprolol","brand_variant":"50","form_normalized":"Tablet","frequency_per_day":2,"duration_days":30},{"brand_name":"Atorvastatin","brand_variant":"10","form_normalized":"Tablet","frequency_per_day":1,"duration_days":null},{"brand_name":"Pantoprazole","brand_variant":"40","form_normalized":"Tablet","frequency_per_day":1,"duration_days":null}],"medical_condition":"Hypertension"}
`;

/**
 * Heuristic check: does the text look like real prescription content?
 * Returns false if the text is too short or has too few alphabetic characters
 * (i.e. looks like OCR noise / garbled output).
 */
function looksLikePrescription(text) {
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;                         // too short
  const letters = (trimmed.match(/[a-zA-Z]/g) || []).length;
  const ratio = letters / trimmed.length;
  if (ratio < 0.4) return false;                                 // mostly numbers/symbols
  // Must contain at least one word with 4+ letters (real medical word)
  const hasRealWord = /[a-zA-Z]{4,}/.test(trimmed);
  return hasRealWord;
}

export async function runNLPExtraction(ocrText) {
  if (!ocrText || ocrText.trim().length === 0) {
    return { medicines: [], medical_condition: null };
  }

  // Guard: skip NLP if OCR output looks garbled/unreadable
  if (!looksLikePrescription(ocrText)) {
    console.warn('[NLP] OCR text too short or garbled — skipping NLP to prevent hallucination.');
    console.warn('[NLP] Rejected text:', ocrText.substring(0, 120));
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
        medicines: medicines.map((med, idx) => {
          // Sanitize brand_variant: must be numeric strength only
          // Reject: "null" string, dosage patterns ("0+0+1", "1-0-1"), units ("50mg")
          let variant = med.brand_variant;
          if (!variant || variant === 'null' || variant === 'undefined') {
            variant = null;
          } else {
            // Strip units (mg, ml, mcg, g, iu) to get bare number
            const stripped = String(variant).replace(/\s*(mg|ml|mcg|g|iu|%)\s*/gi, '').trim();
            // Accept only if it's a pure number after stripping
            variant = /^\d+(\.\d+)?$/.test(stripped) ? stripped : null;
          }
          return {
            id: `ext_${String(idx + 1).padStart(3, '0')}`,
            brand_name: med.brand_name || '',
            brand_variant: variant,
            form: med.form_normalized || null,
            frequency_per_day: typeof med.frequency_per_day === 'number' ? med.frequency_per_day : null,
            duration_days: typeof med.duration_days === 'number' ? med.duration_days : null,
          };
        }),
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
