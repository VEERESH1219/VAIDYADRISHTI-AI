/**
 * VAIDYADRISHTI AI — NLP Extraction Service (v2 — Strict 5-Step Normalization)
 *
 * Uses the configured LLM (via llmService) for strict medical text normalization.
 * 5-step pipeline: Raw → Clean → Expand → Extract → Matching Query
 *
 * Supports: openai (GPT-4o), anthropic (Claude), gemini, ollama (local).
 * Switch provider with MODEL_PROVIDER in .env
 */

import { chatJSON } from './llmService.js';
import { loadEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

loadEnv();

// ── Strict 5-Step Medical Text Normalization Prompt ──────────────────────────
const SYSTEM_PROMPT = `You are a strict medical text normalization engine.
Your job is NOT to interpret, guess, or expand medicines beyond known abbreviations.
Your job is to:
1. Preserve original OCR text.
2. Normalize text safely for database matching.
3. Expand only known common abbreviations.
4. Extract medicine entities without hallucinating.
5. Never invent dosage or strength.
6. Never change a brand to a generic unless explicitly written.

Process prescription text through exactly 5 steps.

OUTPUT: Return ONLY valid JSON. No explanation, no markdown, no extra text.

STEP 1 — PRESERVE RAW:
Return the exact OCR text under "raw_text".

STEP 2 — CLEAN TEXT (Non-destructive normalization):
Perform:
  - Lowercase conversion
  - Remove extra spaces
  - Remove special characters EXCEPT medical units (mg, ml, g, mcg, iu) and form keywords (tab, cap, syrup, inj, syr)
  - Keep strength values exactly as written
  - Do NOT modify spelling
Return under "cleaned_text".

STEP 3 — ABBREVIATION EXPANSION (Controlled):
Expand ONLY from this exact dictionary:
  PCM → paracetamol, amox → amoxicillin, azee → azithromycin,
  metro → metronidazole, crocin → paracetamol, dolo → paracetamol,
  pantop → pantoprazole, MTF → metformin, ASP → aspirin
If a word is NOT in this dictionary and you are uncertain, do NOT expand it.
Return under "expanded_text".

STEP 4 — MEDICINE EXTRACTION (Strict):
Extract medicines as structured objects. For each medicine include:
  - detected_name: exact medicine name as appears after expansion. NEVER null if a medicine exists.
  - strength: strength with unit if present (e.g. "500mg", "625", "10ml"). null if absent.
  - dosage_form: Tab/Tablet, Cap/Capsule, Syrup, Injection, Ointment, Drops — only if explicitly written. null otherwise.
  - frequency: the original frequency text exactly as written (e.g. "BD", "1-0-1", "TDS", "0+0+1"). null if not stated.
  - frequency_per_day: integer total doses per day. Conversion rules:
    OD/once daily=1, BD/twice daily=2, TDS/thrice=3, QID=4, SOS/PRN=1, HS/bedtime=1.
    Dash notation (count non-zero): 0-0-1=1, 1-0-1=2, 1-1-1=3.
    Plus notation (sum values): 0+0+1=1, 1+0+1=2, 2+0+2=4.
    null if not stated.
  - duration: original duration text. null if not stated.
  - duration_days: integer days (x 5 days=5, 1 week/1/52=7, 2 weeks/2/52=14, 1 month/1/12=30). null if not stated.
  - confidence_score: 0.00 to 1.00 — how confident you are this IS a real medicine name.
    If confidence < 0.5, do NOT include the medicine.
If something is unclear, set it to null. DO NOT GUESS.

STEP 5 — MATCHING QUERY OUTPUT:
For each extracted medicine, generate:
  "normalized_query" = medicine_name + strength (if exists, without unit).
  Do NOT include frequency or duration in the query.
  Examples: "Augmentin 625", "Dolo 650", "Metformin 500", "Benadryl"

ADDITIONAL RULES:
- medical_condition: the diagnosis or chief complaint if mentioned. Expand common abbreviations:
  URTI=Upper Respiratory Tract Infection, UTI=Urinary Tract Infection, T2DM=Type 2 Diabetes Mellitus,
  HTN=Hypertension, GERD=Gastroesophageal Reflux Disease. null if not found.
- IGNORE: X-rays, MRI, blood tests, physiotherapy, patient names, dates, clinic details, advice lines.
- If the text is garbled, unreadable, or contains no recognizable medicine names → return empty medicines array.

CRITICAL ANTI-HALLUCINATION RULES (highest priority):
- ONLY extract medicine names EXPLICITLY written in the input text.
- NEVER invent, guess, assume, or suggest medicines not present in the text.
- NEVER use training knowledge to fill in medicines.
- If confidence_score < 0.5 for a word, do NOT include it.

JSON FORMAT:
{
  "raw_text": "...",
  "cleaned_text": "...",
  "expanded_text": "...",
  "medicines": [
    {
      "detected_name": "...",
      "strength": "...",
      "dosage_form": "...",
      "frequency": "...",
      "frequency_per_day": 2,
      "duration": "...",
      "duration_days": 5,
      "normalized_query": "...",
      "confidence_score": 0.95
    }
  ],
  "medical_condition": "string or null"
}

EXAMPLE 1 — typed prescription:
Input: "Dx: URTI. Tab. Augmentin 625mg TDS x 7/7. Tab. Dolo 650 BD SOS."
Output: {"raw_text":"Dx: URTI. Tab. Augmentin 625mg TDS x 7/7. Tab. Dolo 650 BD SOS.","cleaned_text":"dx urti tab augmentin 625mg tds x 7/7 tab dolo 650 bd sos","expanded_text":"dx urti tab augmentin 625mg tds x 7/7 tab paracetamol 650 bd sos","medicines":[{"detected_name":"Augmentin","strength":"625mg","dosage_form":"Tablet","frequency":"TDS","frequency_per_day":3,"duration":"7/7","duration_days":7,"normalized_query":"Augmentin 625","confidence_score":0.98},{"detected_name":"Dolo","strength":"650","dosage_form":"Tablet","frequency":"BD SOS","frequency_per_day":2,"duration":null,"duration_days":null,"normalized_query":"Dolo 650","confidence_score":0.95}],"medical_condition":"Upper Respiratory Tract Infection"}

EXAMPLE 2 — OCR-garbled unreadable text (RETURN EMPTY):
Input: "Fev3r xyzabc 5OOmg 1-1-1 x5d qwrtlmn 625 TDS 7days zzzpqr 10mg HS 10/7"
Output: {"raw_text":"Fev3r xyzabc 5OOmg 1-1-1 x5d qwrtlmn 625 TDS 7days zzzpqr 10mg HS 10/7","cleaned_text":"fev3r xyzabc 500mg 1-1-1 x5d qwrtlmn 625 tds 7days zzzpqr 10mg hs 10/7","expanded_text":"fev3r xyzabc 500mg 1-1-1 x5d qwrtlmn 625 tds 7days zzzpqr 10mg hs 10/7","medicines":[],"medical_condition":null}

EXAMPLE 3 — Indian plus-notation:
Input: "R knee pain. Ultrafin Plus 0+0+1, Relentas 0+0+1, Bogrich 2+0+2"
Output: {"raw_text":"R knee pain. Ultrafin Plus 0+0+1, Relentas 0+0+1, Bogrich 2+0+2","cleaned_text":"r knee pain ultrafin plus 0+0+1 relentas 0+0+1 bogrich 2+0+2","expanded_text":"r knee pain ultrafin plus 0+0+1 relentas 0+0+1 bogrich 2+0+2","medicines":[{"detected_name":"Ultrafin Plus","strength":null,"dosage_form":null,"frequency":"0+0+1","frequency_per_day":1,"duration":null,"duration_days":null,"normalized_query":"Ultrafin Plus","confidence_score":0.85},{"detected_name":"Relentas","strength":null,"dosage_form":null,"frequency":"0+0+1","frequency_per_day":1,"duration":null,"duration_days":null,"normalized_query":"Relentas","confidence_score":0.80},{"detected_name":"Bogrich","strength":null,"dosage_form":null,"frequency":"2+0+2","frequency_per_day":4,"duration":null,"duration_days":null,"normalized_query":"Bogrich","confidence_score":0.80}],"medical_condition":"Right knee pain"}`;

/**
 * Heuristic check: does the text look like real prescription content?
 * Returns false if the text is too short or has too few alphabetic characters
 * (i.e. looks like OCR noise / garbled output).
 */
function looksLikePrescription(text) {
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;
  const letters = (trimmed.match(/[a-zA-Z]/g) || []).length;
  const ratio = letters / trimmed.length;
  if (ratio < 0.4) return false;
  return /[a-zA-Z]{4,}/.test(trimmed);
}

/**
 * Convert the new 5-step NLP output format to the internal format
 * that matchingEngine.js, prescription.js, and the frontend all expect.
 *
 * New format:  { detected_name, strength, dosage_form, frequency_per_day, duration_days, normalized_query, confidence_score }
 * Internal:    { id, brand_name, brand_variant, form, frequency_per_day, duration_days, normalized_query, confidence_score }
 */
function mapToInternalFormat(nlpResult) {
    const medicines = (nlpResult.medicines || []).map((med, idx) => {
        // Extract bare numeric strength for brand_variant
        let variant = med.strength;
        if (variant) {
            const stripped = String(variant).replace(/\s*(mg|ml|mcg|g|iu|%)\s*/gi, '').trim();
            variant = /^\d+(\.\d+)?$/.test(stripped) ? stripped : null;
        } else {
            variant = null;
        }

        return {
            id: `ext_${String(idx + 1).padStart(3, '0')}`,
            brand_name: med.detected_name || '',
            brand_variant: variant,
            form: med.dosage_form || null,
            frequency_per_day: typeof med.frequency_per_day === 'number' ? med.frequency_per_day : null,
            duration_days: typeof med.duration_days === 'number' ? med.duration_days : null,
            // New fields carried through for matching engine
            normalized_query: med.normalized_query || null,
            confidence_score: typeof med.confidence_score === 'number' ? med.confidence_score : null,
        };
    });

    return {
        medicines,
        medical_condition: nlpResult.medical_condition || null,
        // Carry diagnostic text fields for logging
        _raw_text: nlpResult.raw_text || null,
        _cleaned_text: nlpResult.cleaned_text || null,
        _expanded_text: nlpResult.expanded_text || null,
    };
}

export async function runNLPExtraction(ocrText) {
    if (!ocrText || ocrText.trim().length === 0) {
        return { medicines: [], medical_condition: null };
    }

    if (!looksLikePrescription(ocrText)) {
        logger.warn('[NLP] OCR text too short or garbled - skipping NLP to prevent hallucination.');
        logger.warn({ sample: ocrText.substring(0, 120) }, '[NLP] Rejected text');
        return { medicines: [], medical_condition: null };
    }

    let retries = 0;
    const maxRetries = 2;

    while (retries <= maxRetries) {
        try {
            const userMessage = `Process the following prescription text:\n\n${ocrText}`;
            logger.info({ inputLength: ocrText.length }, '[NLP] Input length');
            const parsed = await chatJSON(SYSTEM_PROMPT, userMessage, 0);
            logger.debug({ parsed }, '[NLP] 5-step result');

            const result = mapToInternalFormat(parsed);
            if (result._cleaned_text) {
                logger.debug({ cleaned_text: result._cleaned_text }, '[NLP] cleaned_text');
            }
            if (result._expanded_text) {
                logger.debug({ expanded_text: result._expanded_text }, '[NLP] expanded_text');
            }
            return result;
        } catch (err) {
            retries++;
            if (retries > maxRetries) {
                logger.error({ err: err.message }, '[NLP] All retries failed');
                throw err;
            }
            logger.warn({ attempt: retries, err: err.message }, '[NLP] Attempt failed, retrying');
        }
    }
    return { medicines: [], medical_condition: null };
}
