/**
 * VAIDYADRISHTI AI — Multi-Pass OCR Engine
 *
 * Core innovation: runs 5 parallel Tesseract.js passes with different
 * image preprocessing variants, then builds consensus from all results.
 *
 * For handwritten prescriptions where Tesseract fails, falls back to
 * a vision-capable LLM (GPT-4o, Claude, or Gemini) via llmService.
 * Configure with VISION_PROVIDER in .env
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
} from './preprocessingService.js';
import { buildConsensus, deriveQualityTag } from '../utils/consensus.js';

dotenv.config();

const PREPROCESSING_VARIANTS = [
    { name: 'standard', fn: preprocessStandard },
    { name: 'highContrast', fn: preprocessHighContrast },
    { name: 'binarized', fn: preprocessBinarize },
    { name: 'deskewed', fn: preprocessDeskew },
    { name: 'inverted', fn: preprocessInvert },
];

const VISION_SYSTEM_PROMPT = `You are a document text extraction engine for a healthcare IT digitization system. Your task is to perform OCR — read and transcribe all visible text from the provided document image.

This is used in a hospital's Electronic Health Records (EHR) system to digitize paper documents for record-keeping.

INSTRUCTIONS:
1. Transcribe ALL visible text exactly as written, line by line.
2. Maintain the original line structure.
3. For handwritten text, interpret using contextual clues. For example, in clinical shorthand: "Adv" = Advice, "C/o" = Complaints of, "Imp" = Impression, "OE" = On Examination.
4. If you cannot read a word, write [unclear] in its place.
5. Output ONLY the transcribed text. No commentary. No analysis. No suggestions.`;

const VISION_USER_PROMPT = 'Please perform OCR on this document image and return the transcribed text:';

/**
 * Vision LLM OCR — fallback for handwritten prescriptions.
 * Uses the provider configured by VISION_PROVIDER in .env
 * (default: openai/GPT-4o, also supports anthropic and gemini).
 */
async function visionFallbackOCR(base64DataUri) {
    return visionOCR(base64DataUri, VISION_SYSTEM_PROMPT, VISION_USER_PROMPT);
}

/**
 * Run multi-pass OCR on an image.
 *
 * @param {string|Buffer} imageInput — base64 data URI or raw Buffer
 * @param {object} options
 * @param {number} options.passes — number of passes (3–5, default 5)
 * @param {number} options.minConsensus — min passes to agree (default 2)
 * @param {boolean} options.debug — include per-pass results
 * @returns {Promise<object>} OCR result conforming to OCRResult interface
 */
export async function runMultiPassOCR(imageInput, options = {}) {
    const {
        passes = 5,
        minConsensus = parseInt(process.env.OCR_MIN_CONSENSUS_PASSES || '2', 10),
        debug = false,
    } = options;

    // Store original base64 for GPT-4o Vision fallback
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

    // Select which variants to run (cap at available)
    const selectedVariants = PREPROCESSING_VARIANTS.slice(0, Math.min(passes, 5));

    // Run all passes IN PARALLEL for speed
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
                console.error(`[OCR Pass: ${variant.name}] Error:`, err.message);
                return {
                    variant: variant.name,
                    text: '',
                    confidence: 0,
                };
            }
        })
    );

    // Filter out empty passes
    const validPasses = passResults.filter((p) => p.text.trim().length > 0);

    if (validPasses.length === 0) {
        // All Tesseract passes returned empty — use GPT-4o Vision
        const visionText = await visionFallbackOCR(base64DataUri);
        return {
            final_text: visionText,
            consensus_score: visionText.length > 10 ? 95 : 0,
            quality_tag: visionText.length > 10 ? 'HIGH_CONFIDENCE' : 'LOW_QUALITY',
            passes_completed: passResults.length,
            passes_agreed: 0,
            pass_results: debug ? passResults : undefined,
            fallback_used: `${VISION_PROVIDER}_vision`,
        };
    }

    // Build Tesseract consensus
    const consensusResult = buildConsensus(validPasses, minConsensus);
    const qualityTag = deriveQualityTag(consensusResult.score);

    // ── BEST PASS METRIC ─────────────────────────────────
    const bestPass = validPasses.reduce((best, pass) =>
        pass.confidence > best.confidence ? pass : best
    );

    // ── GPT-4o VISION FALLBACK ────────────────────────────
    // If Tesseract consensus is poor OR best pass confidence is low,
    // use GPT-4o Vision which can handle handwriting much better.
    const TESSERACT_QUALITY_THRESHOLD = 55; // below this, Tesseract is unreliable

    if (bestPass.confidence < TESSERACT_QUALITY_THRESHOLD || consensusResult.score < 30) {
        console.log(`[OCR] Tesseract quality too low (best: ${bestPass.confidence}%, consensus: ${consensusResult.score}%), switching to GPT-4o Vision...`);

        try {
            const visionText = await visionFallbackOCR(base64DataUri);

            if (visionText && visionText.length > 10) {
                return {
                    final_text: visionText,
                    consensus_score: 95, // GPT-4o Vision is highly accurate
                    quality_tag: 'HIGH_CONFIDENCE',
                    passes_completed: passResults.length,
                    passes_agreed: 0,
                    pass_results: debug ? [
                        ...passResults,
                        { variant: `${VISION_PROVIDER}_vision`, text: visionText, confidence: 95 },
                    ] : undefined,
                    fallback_used: `${VISION_PROVIDER}_vision`,
                };
            }
        } catch (err) {
            console.error('[OCR] GPT-4o Vision fallback failed:', err.message);
            // Fall through to use best Tesseract pass
        }
    }

    // ── USE TESSERACT RESULT ─────────────────────────────
    let finalText = consensusResult.text;
    let finalScore = consensusResult.score;
    let finalTag = qualityTag;
    let agreedCount = consensusResult.agreed_count;
    let fallbackUsed = null;

    // If consensus is poor but we have a decent single pass, use that
    if (consensusResult.score < 20 || finalText.trim().length < 10) {
        finalText = bestPass.text.trim();
        finalScore = bestPass.confidence;
        finalTag = deriveQualityTag(finalScore);
        agreedCount = 1;
        fallbackUsed = 'best_single_pass';
        console.log(`[OCR] Using best single pass: ${bestPass.variant} (${bestPass.confidence}%)`);
    }

    return {
        final_text: finalText,
        consensus_score: finalScore,
        quality_tag: finalTag,
        passes_completed: passResults.length,
        passes_agreed: agreedCount,
        pass_results: debug ? passResults : undefined,
        fallback_used: fallbackUsed,
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
        final_text: text.trim(),
        consensus_score: 100,
        quality_tag: 'HIGH_CONFIDENCE',
        passes_completed: 0,
        passes_agreed: 0,
        pass_results: undefined,
    };
}
