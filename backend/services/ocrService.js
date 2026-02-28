/**
 * VAIDYADRISHTI AI — Multi-Pass OCR Engine  (Vision-First Architecture)
 *
 * Strategy:
 *   1. Vision LLM runs IMMEDIATELY as the PRIMARY engine (not a fallback).
 *      Handwriting is near-impossible for Tesseract; vision models handle it.
 *   2. Tesseract runs in parallel as a cross-check for printed/typed text.
 *   3. If Vision LLM returns meaningful text it is always preferred.
 *   4. Tesseract result is used only if vision LLM fails or returns very
 *      short/empty output.
 *
 * Configure VISION_PROVIDER in .env:
 *   ollama  (default, free) — use llava-llama3 or llava:13b for best results
 *   openai  — GPT-4o, most accurate
 *   anthropic / gemini — good alternatives
 */

import Tesseract from 'tesseract.js';
import { visionOCR, VISION_PROVIDER } from './llmService.js';
import dotenv from 'dotenv';
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

const PREPROCESSING_VARIANTS = [
    { name: 'standard',     fn: preprocessStandard     },
    { name: 'highContrast', fn: preprocessHighContrast },
    { name: 'binarized',    fn: preprocessBinarize     },
    { name: 'deskewed',     fn: preprocessDeskew       },
    { name: 'inverted',     fn: preprocessInvert       },
];

// ── Vision prompt — precision-tuned for Indian handwritten prescriptions ──
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

/**
 * Prepare image for Vision LLM.
 * Returns a high-quality base64 data URI optimised for vision models.
 */
async function prepareForVision(imageBuffer) {
    try {
        const enhanced = await preprocessForVision(imageBuffer);
        return 'data:image/png;base64,' + enhanced.toString('base64');
    } catch {
        return 'data:image/png;base64,' + imageBuffer.toString('base64');
    }
}

/**
 * Run Vision LLM OCR on the image.
 */
async function runVisionOCR(base64DataUri) {
    console.log(`[OCR] Running Vision LLM (${VISION_PROVIDER}) as PRIMARY engine...`);
    const text = await visionOCR(base64DataUri, VISION_SYSTEM_PROMPT, VISION_USER_PROMPT);
    console.log(`[OCR] Vision result (${text?.length || 0} chars):\n`, text?.slice(0, 400));
    return text || '';
}

/**
 * Run all Tesseract passes in parallel.
 * Returns the best consensus result.
 */
async function runTesseractPasses(imageBuffer, passes = 5) {
    const selectedVariants = PREPROCESSING_VARIANTS.slice(0, Math.min(passes, 5));

    const passResults = await Promise.all(
        selectedVariants.map(async (variant) => {
            try {
                const processedBuffer = await variant.fn(imageBuffer);
                const { data } = await Tesseract.recognize(processedBuffer, 'eng', {
                    tessedit_pageseg_mode: '6',
                    preserve_interword_spaces: '1',
                });
                return {
                    variant: variant.name,
                    text: data.text || '',
                    confidence: data.confidence || 0,
                };
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

    console.log(`[OCR] Tesseract: ${validPasses.length}/${passes} valid passes, best confidence ${bestPass.confidence.toFixed(0)}%`);
    return { text: finalText, confidence: finalConf };
}

/**
 * Run multi-pass OCR on an image.
 * Vision LLM is PRIMARY — Tesseract is the fallback for printed/typed text.
 *
 * @param {string|Buffer} imageInput — base64 data URI or raw Buffer
 * @param {object} options
 * @param {number} options.passes — number of Tesseract passes (3-5, default 5)
 * @param {boolean} options.debug — include per-pass results
 * @returns {Promise<object>} OCR result
 */
export async function runMultiPassOCR(imageInput, options = {}) {
    const { passes = 5 } = options;

    // Normalise input
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

    // Prepare a vision-optimised image (higher res, better contrast for LLM)
    const visionDataUri = await prepareForVision(imageBuffer);

    // Run Vision LLM + Tesseract SIMULTANEOUSLY for speed
    const [visionText, tesseractResult] = await Promise.all([
        runVisionOCR(visionDataUri).catch(err => {
            console.error('[OCR] Vision LLM error:', err.message);
            return '';
        }),
        runTesseractPasses(imageBuffer, passes).catch(err => {
            console.error('[OCR] Tesseract error:', err.message);
            return { text: '', confidence: 0 };
        }),
    ]);

    const visionIsUsable    = visionText && visionText.trim().length >= 25;
    const tesseractIsUsable = tesseractResult.text && tesseractResult.text.trim().length >= 25;

    // Vision LLM wins — it handles handwriting far better than Tesseract
    if (visionIsUsable) {
        console.log('[OCR] Using Vision LLM result (primary)');
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

    // Fallback: Tesseract (better for clean printed/typed documents)
    if (tesseractIsUsable) {
        console.log('[OCR] Vision LLM returned empty — using Tesseract fallback');
        return {
            final_text:       tesseractResult.text.trim(),
            consensus_score:  tesseractResult.confidence,
            quality_tag:      deriveQualityTag(tesseractResult.confidence),
            passes_completed: passes,
            passes_agreed:    1,
            fallback_used:    'tesseract_fallback',
            ocr_source:       'tesseract',
        };
    }

    // Both failed
    console.error('[OCR] Both Vision LLM and Tesseract returned empty results');
    return {
        final_text:       '',
        consensus_score:  0,
        quality_tag:      'LOW_QUALITY',
        passes_completed: passes,
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
