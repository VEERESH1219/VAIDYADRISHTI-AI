/**
 * VAIDYADRISHTI AI — Multi-Pass OCR Engine  (Vision-First + PaddleOCR)
 *
 * Three-tier strategy (best quality → fallback):
 *
 *   TIER 1 — Vision LLM  (PRIMARY)
 *     Best for handwritten prescriptions. Uses llava / llava-llama3 via Ollama
 *     (or GPT-4o / Gemini if configured). Returns immediately when ≥25 chars.
 *
 *   TIER 2 — PaddleOCR  (FALLBACK — printed text specialist)
 *     Runs in parallel with Vision LLM from the start.
 *     Dramatically better than Tesseract on printed/typed prescriptions:
 *       • Complex layouts and dense text
 *       • Mixed-case drug names and numeric dosages
 *       • Multi-orientation detection (rotated/skewed pages)
 *     Install: pip install paddleocr paddlepaddle
 *
 *   TIER 3 — Tesseract  (LAST RESORT)
 *     Used only if both Vision LLM and PaddleOCR fail.
 *     No Python dependency — always available as safety net.
 *
 * Configure VISION_PROVIDER in .env:
 *   ollama  (default, free) — upgrade to llava-llama3 for best handwriting
 *   gemini  — Gemini Flash 2.0, free 1500/day, excellent
 *   openai  — GPT-4o, most accurate
 *   google  — Google Cloud Vision, best for printed text
 */

import Tesseract                  from 'tesseract.js';
import { visionOCR, VISION_PROVIDER } from './llmService.js';
import { runPaddleOCR }           from './paddleOcrService.js';
import dotenv                     from 'dotenv';
import {
    preprocessStandard,
    preprocessHighContrast,
    preprocessBinarize,
    preprocessDeskew,
    preprocessInvert,
    preprocessForVision,
} from './preprocessingService.js';
import { buildConsensus, deriveQualityTag } from '../utils/consensus.js';

dotenv.config();

// Tesseract preprocessing variants (Tier 3 only)
const PREPROCESSING_VARIANTS = [
    { name: 'standard',     fn: preprocessStandard     },
    { name: 'highContrast', fn: preprocessHighContrast },
    { name: 'binarized',    fn: preprocessBinarize     },
    { name: 'deskewed',     fn: preprocessDeskew       },
    { name: 'inverted',     fn: preprocessInvert       },
];

// ── Vision LLM prompt — precision-tuned for Indian handwritten prescriptions ──
const VISION_SYSTEM_PROMPT = `You are an expert medical transcriptionist with 20 years of experience reading handwritten Indian doctor prescriptions.

Your task: Read this prescription image and transcribe EVERY piece of text you can see.

WHAT TO EXTRACT (in order of importance):
1. Each medicine line — name, strength, form, frequency, duration
   Examples: "Tab. Paracetamol 500mg BD x 5 days"
             "Augmentin 625 TDS 7/7"
             "Pantop 40 OD AC 1/12"
             "Cetirizine 10mg 0-0-1 x 10 days"
2. Diagnosis / Dx / Impression / C/o line at top
3. Doctor name, hospital, date — if visible
4. Any special instructions (e.g., "avoid spicy food", "complete course")

COMMON INDIAN PRESCRIPTION SHORTHAND (recognize these):
Frequency:  OD=once daily  BD=twice daily  TDS=three times  QID=four times
            SOS=as needed  HS=bedtime  1-0-1=morning-noon-night  1-1-1=all three
Timing:     AC=before food  PC=after food  CC=with food
Form:       Tab.=Tablet  Cap.=Capsule  Inj.=Injection  Syr.=Syrup  Oint.=Ointment
Duration:   x5d or 5/7=5 days  1/52=1 week  1/12=1 month
Dx prefix:  Dx=Diagnosis  C/o=Complaints  O/E=On Examination  Rx=Treatment

IMPORTANT RULES:
- If a word is unclear, make your best medical educated guess based on context
- DO NOT write [unclear] or skip anything — attempt every word
- A prescription may have 2-8 medicines — list ALL of them
- Output ONLY the transcribed text, line by line, nothing else
- Do not add any commentary, headings, or explanations`;

const VISION_USER_PROMPT = 'Transcribe all text from this prescription image:';

// ── Minimum character threshold to consider OCR output "meaningful" ──────────
const MIN_TEXT_LENGTH = 25;

/**
 * Checks if a vision/OCR output looks like real readable text (not garbage).
 * Rejects outputs like "<unk>", "<s>", "!$##", random symbols from bad LLM outputs.
 * - At least 35% of characters must be alphabetic letters
 * - Must contain at least one word with 3+ consecutive letters
 */
function isUsableOCRText(text) {
    if (!text || text.trim().length < MIN_TEXT_LENGTH) return false;
    const t = text.trim();
    const letters = (t.match(/[a-zA-Z]/g) || []).length;
    if (letters / t.length < 0.35) return false;       // mostly symbols/numbers
    return /[a-zA-Z]{3,}/.test(t);                     // has at least one real word
}

/**
 * Prepare image for Vision LLM.
 * Returns a high-quality base64 data URI optimised for vision models.
 */
async function prepareForVision(imageBuffer) {
    try {
        const enhanced = await preprocessForVision(imageBuffer);
        return 'data:image/jpeg;base64,' + enhanced.toString('base64');
    } catch {
        return 'data:image/jpeg;base64,' + imageBuffer.toString('base64');
    }
}

/**
 * Tier 1 — Vision LLM OCR.
 */
async function runVisionOCR(base64DataUri) {
    console.log(`[OCR] Tier 1 — Vision LLM (${VISION_PROVIDER}) starting...`);
    const text = await visionOCR(base64DataUri, VISION_SYSTEM_PROMPT, VISION_USER_PROMPT);
    console.log(`[OCR] Vision result (${text?.length || 0} chars):\n`, text?.slice(0, 400));
    return text || '';
}

/**
 * Tier 3 — Tesseract (last resort, no Python dependency).
 * Runs 3 parallel preprocessing variants and picks the best consensus.
 */
async function runTesseractPasses(imageBuffer, passes = 3) {
    const selectedVariants = PREPROCESSING_VARIANTS.slice(0, Math.min(passes, 5));

    const passResults = await Promise.all(
        selectedVariants.map(async (variant) => {
            try {
                const processedBuffer = await variant.fn(imageBuffer);

                // Tesseract.js v7 throws an uncaught process.nextTick exception
                // on unreadable buffers — validate with sharp first to prevent server crash.
                try {
                    await sharp(processedBuffer).metadata();
                } catch {
                    console.warn(`[OCR Tesseract: ${variant.name}] buffer unreadable, skipping`);
                    return { variant: variant.name, text: '', confidence: 0 };
                }

                const { data } = await Tesseract.recognize(processedBuffer, 'eng', {
                    tessedit_pageseg_mode: '6',
                    preserve_interword_spaces: '1',
                });
                return { variant: variant.name, text: data.text || '', confidence: data.confidence || 0 };
            } catch (err) {
                console.warn(`[OCR Tesseract: ${variant.name}] ${err.message}`);
                return { variant: variant.name, text: '', confidence: 0 };
            }
        })
    );

    const validPasses = passResults.filter((p) => p.text.trim().length > 10);
    if (validPasses.length === 0) return { text: '', confidence: 0 };

    const consensusResult = buildConsensus(validPasses, 2);
    const bestPass = validPasses.reduce((best, p) => p.confidence > best.confidence ? p : best);

    const finalText = consensusResult.score >= 20 ? consensusResult.text : bestPass.text;
    const finalConf = consensusResult.score >= 20 ? consensusResult.score : bestPass.confidence;

    console.log(`[OCR] Tesseract: ${validPasses.length} valid passes, best confidence ${bestPass.confidence.toFixed(0)}%`);
    return { text: finalText, confidence: finalConf };
}

/**
 * Run multi-pass OCR on an image using the three-tier engine.
 *
 * Tier 1: Vision LLM   — primary, best for handwriting
 * Tier 2: PaddleOCR    — fallback, best for printed text
 * Tier 3: Tesseract    — last resort, no extra dependencies
 *
 * @param {string|Buffer} imageInput — base64 data URI or raw Buffer
 * @param {object}        options
 * @param {number}        options.passes — hint for Tesseract passes (3–5)
 * @returns {Promise<object>} OCR result with final_text, consensus_score, etc.
 */
export async function runMultiPassOCR(imageInput, options = {}) {
    const { passes = 5 } = options;

    // ── Normalise input ───────────────────────────────────────────────────────
    let base64DataUri;
    let imageBuffer;

    if (typeof imageInput === 'string') {
        base64DataUri = imageInput;
        const base64Data = imageInput.replace(/^data:image\/\w+;base64,/, '');
        imageBuffer = Buffer.from(base64Data, 'base64');
    } else {
        imageBuffer = imageInput;
        base64DataUri = 'data:image/png;base64,' + imageInput.toString('base64');
    }

    // Prepare vision-optimised image (higher res, colour-preserved for LLM)
    const visionDataUri = await prepareForVision(imageBuffer);

    // ── Launch Tier 2 & 3 in background immediately ──────────────────────────
    // Both start NOW so their result is ready the moment Vision LLM fails.
    // PaddleOCR (Tier 2) is significantly more accurate than Tesseract.
    const paddlePromise = runPaddleOCR(imageBuffer).catch(err => {
        console.warn('[OCR] PaddleOCR unavailable (is Python + paddleocr installed?):', err.message);
        return { text: '', confidence: 0 };
    });

    const tesseractPromise = runTesseractPasses(imageBuffer, Math.min(passes, 3)).catch(err => {
        console.error('[OCR] Tesseract error:', err.message);
        return { text: '', confidence: 0 };
    });

    // ── Tier 1: Vision LLM ────────────────────────────────────────────────────
    const visionText = await runVisionOCR(visionDataUri).catch(err => {
        console.error('[OCR] Vision LLM error:', err.message);
        return '';
    });

    if (isUsableOCRText(visionText)) {
        console.log(`[OCR] ✓ Tier 1 Vision LLM succeeded (${visionText.trim().length} chars) — returning immediately`);
        // Background processes can finish silently
        paddlePromise.catch(() => {});
        tesseractPromise.catch(() => {});
        return {
            final_text:       visionText.trim(),
            consensus_score:  92,
            quality_tag:      'HIGH_CONFIDENCE',
            passes_completed: passes,
            passes_agreed:    passes,
            fallback_used:    null,
            ocr_source:       `${VISION_PROVIDER}_vision_primary`,
        };
    }

    // ── Tier 2: PaddleOCR ─────────────────────────────────────────────────────
    console.warn('[OCR] Tier 1 failed — awaiting Tier 2 PaddleOCR...');
    const paddleResult = await paddlePromise;

    if (isUsableOCRText(paddleResult.text)) {
        console.log(`[OCR] ✓ Tier 2 PaddleOCR succeeded — ${paddleResult.confidence}% confidence, ${paddleResult.text.trim().length} chars`);
        tesseractPromise.catch(() => {});
        return {
            final_text:       paddleResult.text.trim(),
            consensus_score:  paddleResult.confidence,
            quality_tag:      deriveQualityTag(paddleResult.confidence),
            passes_completed: passes,
            passes_agreed:    1,
            fallback_used:    'paddleocr_fallback',
            ocr_source:       'paddleocr',
        };
    }

    // ── Tier 3: Tesseract ─────────────────────────────────────────────────────
    console.warn('[OCR] Tier 2 failed — awaiting Tier 3 Tesseract...');
    const tesseractResult = await tesseractPromise;

    if (isUsableOCRText(tesseractResult.text)) {
        console.log('[OCR] ✓ Tier 3 Tesseract fallback succeeded');
        return {
            final_text:       tesseractResult.text.trim(),
            consensus_score:  tesseractResult.confidence,
            quality_tag:      deriveQualityTag(tesseractResult.confidence),
            passes_completed: 3,
            passes_agreed:    1,
            fallback_used:    'tesseract_fallback',
            ocr_source:       'tesseract',
        };
    }

    // ── All tiers failed ──────────────────────────────────────────────────────
    console.error('[OCR] ✗ All three OCR tiers returned empty results');
    return {
        final_text:       '',
        consensus_score:  0,
        quality_tag:      'LOW_QUALITY',
        passes_completed: 3,
        passes_agreed:    0,
        fallback_used:    'none',
        ocr_source:       'failed',
    };
}

/**
 * Raw text input bypass — skips OCR entirely.
 *
 * @param {string} text — raw prescription text
 * @returns {object} OCR-compatible result
 */
export function runRawTextInput(text) {
    return {
        final_text:       text.trim(),
        consensus_score:  100,
        quality_tag:      'HIGH_CONFIDENCE',
        passes_completed: 0,
        passes_agreed:    0,
        ocr_source:       'raw_text',
    };
}
