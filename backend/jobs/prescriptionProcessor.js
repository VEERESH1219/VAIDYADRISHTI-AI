import { runMultiPassOCR, runRawTextInput } from '../services/ocrService.js';
import { runNLPExtraction } from '../services/nlpService.js';
import { matchMedicines } from '../services/matchingEngine.js';
import { visionDirectExtract, VISION_PROVIDER } from '../services/llmService.js';

function buildRawTextFallbackExtraction(rawText) {
    return [{
        id: 'ext_001',
        brand_name: String(rawText || '').trim(),
        brand_variant: null,
        form: null,
        frequency_per_day: null,
        duration_days: null,
    }];
}

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
    }

    return merged;
}

export async function processPrescriptionPayload(payload) {
    const startTime = Date.now();
    const { image, raw_text, options = {} } = payload;

    if (!image && !raw_text) {
        const err = new Error('Either "image" (base64) or "raw_text" must be provided.');
        err.statusCode = 400;
        throw err;
    }

    let ocrResult;
    let extractions = [];
    let medical_condition = null;

    if (raw_text) {
        ocrResult = runRawTextInput(raw_text);
        const nlp = await runNLPExtraction(ocrResult.final_text);
        extractions = nlp.medicines;

        if (!extractions.length) {
            extractions = buildRawTextFallbackExtraction(raw_text);
        }

        medical_condition = nlp.medical_condition;
    }

    if (image) {
        const directPromise =
            VISION_PROVIDER !== 'ollama'
                ? visionDirectExtract(image).catch(() => null)
                : Promise.resolve(null);

        ocrResult = await runMultiPassOCR(image, {
            passes: options.ocr_passes || 5,
            minConsensus: options.min_consensus || 2,
            debug: options.debug_passes || false,
        });

        const nlpResult = await runNLPExtraction(ocrResult.final_text);
        const directRes = await directPromise;

        extractions = mergeMedicines(
            nlpResult.medicines,
            directRes?.medicines || []
        );

        medical_condition =
            nlpResult.medical_condition || directRes?.medical_condition || null;
    }

    if (extractions.length === 0) {
        return {
            status: 'success',
            processing_time_ms: Date.now() - startTime,
            ocr_result: ocrResult,
            medical_condition,
            extracted_medicines: [],
            extracted_count: 0,
        };
    }

    const results = await matchMedicines(extractions);

    return {
        status: 'success',
        processing_time_ms: Date.now() - startTime,
        ocr_result: ocrResult,
        medical_condition,
        extracted_medicines: results.map((r) => ({
            raw_input: r.raw_input,
            structured_data: r.structured_data,
            matched_medicine: r.matched_medicine,
            fallback_required: r.fallback_required || false,
            ambiguous: r.matched_medicine?.ambiguous || false,
            requires_human_verification:
                r.matched_medicine?.requires_human_verification || false,
        })),
        extracted_count: results.length,
    };
}
