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
import sharp                      from 'sharp';
import { visionOCR, VISION_PROVIDER } from './llmService.js';
import { runPaddleOCR }           from './paddleOcrService.js';
import { loadEnv }                from '../config/env.js';
import { logger }                 from '../utils/logger.js';
import {
    preprocessStandard,
    preprocessHighContrast,
    preprocessBinarize,
    preprocessDeskew,
    preprocessInvert,
    preprocessForVision,
} from './preprocessingService.js';
import { buildConsensus, deriveQualityTag } from '../utils/consensus.js';

loadEnv();

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
    logger.info({ provider: VISION_PROVIDER }, '[OCR] Tier 1 - Vision LLM starting');
    const text = await visionOCR(base64DataUri, VISION_SYSTEM_PROMPT, VISION_USER_PROMPT);
    logger.debug({ length: text?.length || 0, sample: text?.slice(0, 400) }, '[OCR] Vision result');
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
                    logger.warn({ variant: variant.name }, '[OCR Tesseract] Buffer unreadable, skipping');
                    return { variant: variant.name, text: '', confidence: 0 };
                }

                const { data } = await Tesseract.recognize(processedBuffer, 'eng', {
                    tessedit_pageseg_mode: '6',
                    preserve_interword_spaces: '1',
                });
                return { variant: variant.name, text: data.text || '', confidence: data.confidence || 0 };
            } catch (err) {
                logger.warn({ variant: variant.name, err: err.message }, '[OCR Tesseract] Variant failed');
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

    logger.info({
        validPasses: validPasses.length,
        bestConfidence: Number(bestPass.confidence.toFixed(0)),
    }, '[OCR] Tesseract completed');
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
    let imageBuffer;
    if (typeof imageInput === 'string') {
        const base64Data = imageInput.replace(/^data:image\/\w+;base64,/, '');
        imageBuffer = Buffer.from(base64Data, 'base64');
    } else {
        imageBuffer = imageInput;
    }

    // Prepare vision-optimised image (higher res, colour-preserved for LLM)
    const visionDataUri = await prepareForVision(imageBuffer);

    // ── TRUE PARALLEL RACE — all three tiers start simultaneously ─────────────
    //
    // Each tier promise rejects if it produces no usable text.
    // Promise.any() resolves with whichever tier finishes FIRST with good text.
    // This means:
    //   • Tesseract (~10-20s) wins immediately if Vision LLM is slow/times out
    //   • Vision LLM wins if it responds faster (cloud providers: GPT-4o, Gemini)
    //   • We never wait 120s for a Vision timeout before using Tesseract
    //
    // Priority tiebreak: if multiple tiers finish within 5s of each other,
    // Vision > PaddleOCR > Tesseract (tracked via `tier` field).

    // Each tier promise resolves with a result object, or rejects when it
    // produces no usable text. Promise.any() returns the FIRST to resolve —
    // so whichever tier finishes first with good text wins immediately.
    // This means Tesseract (~10-20s) doesn't wait behind Vision's 120s timeout.

    const makeTier = (promise, tier, label, defaultConf) =>
        promise.then(raw => {
            const text = typeof raw === 'string' ? raw : (raw?.text || '');
            const confidence = typeof raw === 'object' ? (raw?.confidence ?? defaultConf) : defaultConf;
            if (!isUsableOCRText(text)) throw new Error(`${label}: no usable text`);
            return { tier, text: text.trim(), confidence, label };
        });

    // Skip Ollama Vision in the OCR race — Ollama processes one request at a time,
    // so running Vision blocks the NLP model that follows OCR. Tesseract is fast
    // and local with no queue contention. Cloud providers (GPT-4o, Gemini, Google)
    // handle parallel calls so Vision is kept for them.
    const skipVision = VISION_PROVIDER === 'ollama';
    if (skipVision) {
        logger.info('[OCR] Skipping Ollama Vision (would block NLP queue)');
    }

    const visionTier = skipVision
        ? Promise.reject(new Error('Ollama Vision skipped — Tesseract is faster'))
        : makeTier(
            runVisionOCR(visionDataUri).catch(err => {
                logger.error({ err: err.message }, '[OCR] Vision LLM error');
                return '';
            }),
            1, `${VISION_PROVIDER}_vision`, 92
        );

    const paddleTier = makeTier(
        runPaddleOCR(imageBuffer).catch(err => {
            const shortMsg = err.message?.split('\n')[0] || err.message;
            logger.warn({ err: shortMsg }, '[OCR] PaddleOCR unavailable');
            return { text: '', confidence: 0 };
        }),
        2, 'paddleocr', 70
    );

    const tessTier = makeTier(
        runTesseractPasses(imageBuffer, Math.min(passes, 3)).catch(err => {
            logger.error({ err: err.message }, '[OCR] Tesseract error');
            return { text: '', confidence: 0 };
        }),
        3, 'tesseract', 0
    );

    // Promise.any resolves with the first tier that produces usable text.
    // If Tesseract finishes in 15s and Vision times out at 120s, we get Tesseract at 15s.
    let best = null;
    try {
        best = await Promise.any([visionTier, paddleTier, tessTier]);
    } catch {
        // AggregateError — all three failed
    }

    if (best) {
        const tierSources = ['', `${VISION_PROVIDER}_vision_primary`, 'paddleocr', 'tesseract'];
        const tierFallback = ['', null, 'paddleocr_fallback', 'tesseract_fallback'];
        logger.info({
            winningTier: best.tier,
            label: best.label,
            textLength: best.text.length,
            confidence: best.confidence,
        }, '[OCR] Tier winner selected');
        return {
            final_text:       best.text,
            consensus_score:  best.confidence,
            quality_tag:      best.tier === 1 ? 'HIGH_CONFIDENCE' : deriveQualityTag(best.confidence),
            passes_completed: passes,
            passes_agreed:    best.tier === 1 ? passes : 1,
            fallback_used:    tierFallback[best.tier],
            ocr_source:       tierSources[best.tier],
        };
    }

    // ── All tiers failed ──────────────────────────────────────────────────────
    logger.error('[OCR] All OCR tiers returned empty results');
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
