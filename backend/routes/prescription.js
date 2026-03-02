/**
 * VAIDYADRISHTI AI - Prescription Processing Route
 *
 * POST /api/process-prescription
 *
 * Dual-path parallel extraction for maximum accuracy:
 *
 *   Path A - OCR -> NLP (current pipeline, robust for typed/clear handwriting)
 *     Image -> Vision OCR (transcribe text) -> NLP (extract medicines from text)
 *
 *   Path B - Direct extraction (one shot, bypasses OCR errors)
 *     Image -> Vision LLM (output medicine JSON directly from image)
 *
 * Both paths run simultaneously. Results are MERGED: if Path B detects a
 * medicine that Path A missed (OCR garbled it), it is added to the final list.
 * This gives the highest possible medicine recall with zero extra latency.
 */

import { Router } from 'express';
import { runMultiPassOCR, runRawTextInput } from '../services/ocrService.js';
import { runNLPExtraction } from '../services/nlpService.js';
import { matchMedicines } from '../services/matchingEngine.js';
import { visionDirectExtract, VISION_PROVIDER } from '../services/llmService.js';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const router = Router();

/**
 * Merge medicines from two extraction paths.
 * Path A (OCR->NLP) is the primary. Medicines found in Path B that are NOT
 * already in Path A are appended. Deduplication is by brand_name (case-insensitive).
 *
 * @param {Array} pathA - medicines from OCR->NLP pipeline
 * @param {Array} pathB - medicines from direct vision extraction
 * @returns {Array} merged, deduplicated list
 */
function mergeMedicines(pathA, pathB) {
    if (!pathB || pathB.length === 0) return pathA;
    if (!pathA || pathA.length === 0) {
        return pathB.map((m, idx) => ({
            id: `ext_${String(idx + 1).padStart(3, '0')}`,
            brand_name: m.brand_name || '',
            brand_variant: m.brand_variant || null,
            form: m.form_normalized || null,
            frequency_per_day: typeof m.frequency_per_day === 'number' ? m.frequency_per_day : null,
            duration_days: typeof m.duration_days === 'number' ? m.duration_days : null,
        }));
    }

    const seen = new Set(pathA.map((m) => m.brand_name?.toLowerCase().trim()));
    const merged = [...pathA];
    let idx = pathA.length;

    for (const m of pathB) {
        const key = m.brand_name?.toLowerCase().trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push({
            id: `ext_${String(++idx).padStart(3, '0')}`,
            brand_name: m.brand_name || '',
            brand_variant: m.brand_variant || null,
            form: m.form_normalized || null,
            frequency_per_day: typeof m.frequency_per_day === 'number' ? m.frequency_per_day : null,
            duration_days: typeof m.duration_days === 'number' ? m.duration_days : null,
        });
        console.log(`[Merge] Path B added missed medicine: "${m.brand_name}"`);
    }

    return merged;
}

router.post(['/process-prescription', '/process_prescription'], async (req, res, next) => {
    const startTime = Date.now();
    const sessionId = randomUUID();

    try {
        const { image, raw_text, options = {} } = req.body;

        if (!image && !raw_text) {
            if (res.headersSent) return;
            return res.status(400).json({
                status: 'error',
                code: 'MISSING_INPUT',
                message: 'Either "image" (base64) or "raw_text" must be provided.',
                requestId: req.requestId,
            });
        }

        let ocrResult;
        let extractions = [];
        let medical_condition = null;

        if (raw_text) {
            ocrResult = runRawTextInput(raw_text);
            const nlp = await runNLPExtraction(ocrResult.final_text);
            extractions = nlp.medicines;
            medical_condition = nlp.medical_condition;
        }

        if (image) {
            const useDirectPath = VISION_PROVIDER !== 'ollama';

            if (useDirectPath) {
                console.log('[Route] Starting dual-path extraction (Path A: OCR->NLP, Path B: Direct)');
            } else {
                console.log('[Route] Starting single-path extraction (Ollama: Path A only)');
            }

            const directPromise = useDirectPath
                ? visionDirectExtract(image).catch((err) => {
                    console.warn('[Route] Direct extraction failed (non-fatal):', err.message);
                    return null;
                })
                : Promise.resolve(null);

            ocrResult = await runMultiPassOCR(image, {
                passes: options.ocr_passes || 5,
                minConsensus: options.min_consensus || 2,
                debug: options.debug_passes || false,
            });

            const nlpResult = await runNLPExtraction(ocrResult.final_text);
            const nlpMeds = nlpResult.medicines;
            const nlpCondition = nlpResult.medical_condition;
            if (nlpResult._cleaned_text) console.log('[Route] NLP cleaned_text:', nlpResult._cleaned_text);
            if (nlpResult._expanded_text) console.log('[Route] NLP expanded_text:', nlpResult._expanded_text);

            const directRes = await directPromise;
            const directMeds = directRes?.medicines || [];
            const directCondition = directRes?.medical_condition || null;

            console.log(`[Route] Path A (OCR->NLP): ${nlpMeds.length} medicines`);
            console.log(`[Route] Path B (Direct):  ${directMeds.length} medicines`);

            extractions = mergeMedicines(nlpMeds, directMeds);
            medical_condition = nlpCondition || directCondition;

            console.log(`[Route] Merged total: ${extractions.length} unique medicines`);
        }

        if (extractions.length === 0) {
            const processingTime = Date.now() - startTime;
            logExtraction(sessionId, image ? 'image' : 'text', ocrResult, [], [], processingTime);
            if (res.headersSent) return;
            return res.json({
                status: 'success',
                processing_time_ms: processingTime,
                ocr_result: ocrResult,
                medical_condition,
                extracted_medicines: [],
                requestId: req.requestId,
            });
        }

        const results = await matchMedicines(extractions);
        const processingTime = Date.now() - startTime;
        logExtraction(sessionId, image ? 'image' : 'text', ocrResult, extractions, results, processingTime);

        if (res.headersSent) return;
        return res.json({
            status: 'success',
            processing_time_ms: processingTime,
            ocr_result: ocrResult,
            medical_condition,
            extracted_medicines: results.map((r) => ({
                raw_input: r.raw_input,
                structured_data: r.structured_data,
                matched_medicine: r.matched_medicine,
                fallback_required: r.fallback_required || false,
                ambiguous: r.matched_medicine?.ambiguous || false,
                requires_human_verification: r.matched_medicine?.requires_human_verification || false,
            })),
            requestId: req.requestId,
        });
    } catch (err) {
        err.statusCode = err.statusCode || 500;
        if (res.headersSent) return;
        return next(err);
    }
});

/**
 * Log extraction summary to console for local debugging.
 */
function logExtraction(sessionId, inputType, ocrResult, extractions, matches, processingMs) {
    console.log(
        `[Log] session=${sessionId} type=${inputType} ocr_len=${ocrResult?.final_text?.length ?? 0}` +
        ` medicines=${extractions.length} matches=${matches.length} time=${processingMs}ms`
    );
}

export default router;
