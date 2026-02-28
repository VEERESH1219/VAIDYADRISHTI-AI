/**
 * VAIDYADRISHTI AI — Prescription Processing Route
 *
 * POST /api/process-prescription
 *
 * Dual-path parallel extraction for maximum accuracy:
 *
 *   Path A — OCR → NLP (current pipeline, robust for typed/clear handwriting)
 *     Image → Vision OCR (transcribe text) → NLP (extract medicines from text)
 *
 *   Path B — Direct extraction (one shot, bypasses OCR errors)
 *     Image → Vision LLM (output medicine JSON directly from image)
 *
 * Both paths run simultaneously. Results are MERGED: if Path B detects a
 * medicine that Path A missed (OCR garbled it), it is added to the final list.
 * This gives the highest possible medicine recall with zero extra latency.
 */

import { Router } from 'express';
import { runMultiPassOCR, runRawTextInput } from '../services/ocrService.js';
import { runNLPExtraction } from '../services/nlpService.js';
import { matchMedicines } from '../services/matchingEngine.js';
import { visionDirectExtract } from '../services/llmService.js';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const router = Router();

// Lazy Supabase client — avoids crash at startup when env vars are not set
let _supabase;
function supabaseClient() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        throw new Error('SUPABASE_NOT_CONFIGURED');
    }
    if (!_supabase) _supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );
    return _supabase;
}

/**
 * Merge medicines from two extraction paths.
 * Path A (OCR→NLP) is the primary. Medicines found in Path B that are NOT
 * already in Path A are appended. Deduplication is by brand_name (case-insensitive).
 *
 * @param {Array} pathA — medicines from OCR→NLP pipeline
 * @param {Array} pathB — medicines from direct vision extraction
 * @returns {Array} merged, deduplicated list
 */
function mergeMedicines(pathA, pathB) {
    if (!pathB || pathB.length === 0) return pathA;
    if (!pathA || pathA.length === 0) {
        // Path A is empty — use Path B results shaped as NLP output format
        return pathB.map((m, idx) => ({
            id:                `ext_${String(idx + 1).padStart(3, '0')}`,
            brand_name:        m.brand_name    || '',
            brand_variant:     m.brand_variant || null,
            form:              m.form_normalized || null,
            frequency_per_day: typeof m.frequency_per_day === 'number' ? m.frequency_per_day : null,
            duration_days:     typeof m.duration_days === 'number'     ? m.duration_days     : null,
        }));
    }

    const seen = new Set(pathA.map(m => m.brand_name?.toLowerCase().trim()));
    const merged = [...pathA];
    let idx = pathA.length;

    for (const m of pathB) {
        const key = m.brand_name?.toLowerCase().trim();
        if (!key || seen.has(key)) continue; // Already found by Path A
        seen.add(key);
        merged.push({
            id:                `ext_${String(++idx).padStart(3, '0')}`,
            brand_name:        m.brand_name    || '',
            brand_variant:     m.brand_variant || null,
            form:              m.form_normalized || null,
            frequency_per_day: typeof m.frequency_per_day === 'number' ? m.frequency_per_day : null,
            duration_days:     typeof m.duration_days === 'number'     ? m.duration_days     : null,
        });
        console.log(`[Merge] Path B added missed medicine: "${m.brand_name}"`);
    }

    return merged;
}

router.post(['/process-prescription', '/process_prescription'], async (req, res) => {
    const startTime = Date.now();
    const sessionId = randomUUID();

    try {
        const { image, raw_text, options = {} } = req.body;

        if (!image && !raw_text) {
            return res.status(400).json({
                status:  'error',
                code:    'MISSING_INPUT',
                message: 'Either "image" (base64) or "raw_text" must be provided.',
            });
        }

        let ocrResult;
        let extractions = [];
        let medical_condition = null;

        // ── TEXT INPUT — single path (no image to process) ───────────────────
        if (raw_text) {
            ocrResult = runRawTextInput(raw_text);
            const nlp = await runNLPExtraction(ocrResult.final_text);
            extractions     = nlp.medicines;
            medical_condition = nlp.medical_condition;
        }

        // ── IMAGE INPUT — dual-path parallel extraction ───────────────────────
        if (image) {
            console.log('[Route] Starting dual-path extraction (Path A: OCR→NLP, Path B: Direct)');

            // Both paths run simultaneously — zero extra latency
            const [
                ocrRes,
                directRes,
            ] = await Promise.all([
                // Path A: Vision OCR → transcribed text
                runMultiPassOCR(image, {
                    passes:      options.ocr_passes  || 5,
                    minConsensus: options.min_consensus || 2,
                    debug:       options.debug_passes || false,
                }),
                // Path B: Vision LLM → medicine JSON directly from image
                visionDirectExtract(image).catch(err => {
                    console.warn('[Route] Direct extraction failed (non-fatal):', err.message);
                    return null;
                }),
            ]);

            ocrResult = ocrRes;

            // Path A: run NLP on OCR text
            const { medicines: nlpMeds, medical_condition: nlpCondition } =
                await runNLPExtraction(ocrResult.final_text);

            // Path B results
            const directMeds      = directRes?.medicines      || [];
            const directCondition = directRes?.medical_condition || null;

            console.log(`[Route] Path A (OCR→NLP): ${nlpMeds.length} medicines`);
            console.log(`[Route] Path B (Direct):  ${directMeds.length} medicines`);

            // Merge: union of both paths
            extractions       = mergeMedicines(nlpMeds, directMeds);
            medical_condition = nlpCondition || directCondition;

            console.log(`[Route] Merged total: ${extractions.length} unique medicines`);
        }

        // ── Matching — same for both input types ──────────────────────────────
        if (extractions.length === 0) {
            const processingTime = Date.now() - startTime;
            await logExtraction(sessionId, image ? 'image' : 'text', ocrResult, [], [], processingTime);
            return res.json({
                status:              'success',
                processing_time_ms:  processingTime,
                ocr_result:          ocrResult,
                medical_condition,
                extracted_medicines: [],
            });
        }

        const results = await matchMedicines(extractions);
        const processingTime = Date.now() - startTime;
        await logExtraction(sessionId, image ? 'image' : 'text', ocrResult, extractions, results, processingTime);

        return res.json({
            status:              'success',
            processing_time_ms:  processingTime,
            ocr_result:          ocrResult,
            medical_condition,
            extracted_medicines: results.map(r => ({
                raw_input:        r.raw_input,
                structured_data:  r.structured_data,
                matched_medicine: r.matched_medicine,
                fallback_required: r.fallback_required || false,
            })),
        });

    } catch (err) {
        console.error('[Process Prescription] Error:', err);
        return res.status(500).json({
            status:  'error',
            message: err.message || 'An unexpected error occurred.',
        });
    }
});

/**
 * Log extraction to Supabase audit table.
 * Silently skipped when Supabase is not configured.
 */
async function logExtraction(sessionId, inputType, ocrResult, extractions, matches, processingMs) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return;
    try {
        await supabaseClient().from('extraction_logs').insert({
            session_id:     sessionId,
            input_type:     inputType,
            raw_ocr_text:   ocrResult?.final_text,
            consensus_score: ocrResult?.consensus_score,
            structured_json: extractions,
            matches_json:   matches,
            processing_ms:  processingMs,
        });
    } catch (err) {
        console.error('[Audit Log] Error:', err.message);
    }
}

export default router;
