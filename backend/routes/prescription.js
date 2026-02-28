/**
 * MedMap AI — Prescription Processing Route
 *
 * POST /api/process-prescription
 * Orchestrates: Input → OCR → NLP → Matching → Log → Response
 */

import { Router } from 'express';
import { runMultiPassOCR, runRawTextInput } from '../services/ocrService.js';
import { runNLPExtraction } from '../services/nlpService.js';
import { matchMedicines } from '../services/matchingEngine.js';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const router = Router();

// Lazy Supabase client — avoids crash at startup when env vars are not yet set
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

router.post(['/process-prescription', '/process_prescription'], async (req, res) => {
    const startTime = Date.now();
    const sessionId = randomUUID();

    try {
        const { image, raw_text, options = {} } = req.body;

        if (!image && !raw_text) {
            return res.status(400).json({
                status: 'error',
                code: 'MISSING_INPUT',
                message: 'Either "image" (base64) or "raw_text" must be provided.',
            });
        }

        // ── Step 1: OCR
        let ocrResult;
        if (image) {
            ocrResult = await runMultiPassOCR(image, {
                passes: options.ocr_passes || 5,
                minConsensus: options.min_consensus || 3,
                debug: options.debug_passes || false,
            });
        } else {
            ocrResult = runRawTextInput(raw_text);
        }

        // ── Step 2: NLP Extraction
        const { medicines: extractions, medical_condition } = await runNLPExtraction(ocrResult.final_text);

        if (extractions.length === 0) {
            const processingTime = Date.now() - startTime;
            await logExtraction(sessionId, image ? 'image' : 'text', ocrResult, [], [], processingTime);

            return res.json({
                status: 'success',
                processing_time_ms: processingTime,
                ocr_result: ocrResult,
                medical_condition: medical_condition,
                extracted_medicines: []
            });
        }

        const results = await matchMedicines(extractions);

        const processingTime = Date.now() - startTime;
        await logExtraction(sessionId, image ? 'image' : 'text', ocrResult, extractions, results, processingTime);

        // Always return the full set of results. 
        // Individual results will carry the fallback_required flag if needed.
        return res.json({
            status: 'success',
            processing_time_ms: processingTime,
            ocr_result: ocrResult,
            medical_condition: medical_condition,
            extracted_medicines: results.map(r => ({
                raw_input: r.raw_input,
                structured_data: r.structured_data,
                matched_medicine: r.matched_medicine,
                fallback_required: r.fallback_required || false
            }))
        });

    } catch (err) {
        console.error('[Process Prescription] Error:', err);
        return res.status(500).json({
            status: 'error',
            message: err.message || 'An unexpected error occurred.'
        });
    }
});

/**
 * Log extraction to Supabase audit table.
 * Silently skipped when Supabase is not configured.
 */
async function logExtraction(sessionId, inputType, ocrResult, extractions, matches, processingMs) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return; // No DB configured
    try {
        await supabaseClient().from('extraction_logs').insert({
            session_id: sessionId,
            input_type: inputType,
            raw_ocr_text: ocrResult.final_text,
            consensus_score: ocrResult.consensus_score,
            structured_json: extractions,
            matches_json: matches,
            processing_ms: processingMs,
        });
    } catch (err) {
        console.error('[Audit Log] Error:', err.message);
    }
}

export default router;
