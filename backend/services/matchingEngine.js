/**
 * VAIDYADRISHTI AI — Strict 4-Stage Hybrid Matching Engine
 *
 * STAGE 0: Local Cache (previously AI-discovered medicines — instant lookup)
 * STAGE 1: Exact match (brand_name + form) — requires Supabase
 * STAGE 2: Fuzzy match (trigram similarity) — requires Supabase
 * STAGE 3: Vector similarity (embeddings)  — requires Supabase + OpenAI
 * STAGE 4: AI Knowledge Fallback → auto-saved to local cache for next time
 *
 * STRICT RULES:
 * 1. Confidence: >=90% (High), 70-89% (Medium), <70% (Low).
 * 2. Brand Variant Validation: Numeric suffixes (625, 650) must match DB record or penalize.
 * 3. Combination Integrity: Do not split combinations.
 * 4. Strength: ALWAYS from DB, never inferred from numeric tokens.
 */

import { createClient } from '@supabase/supabase-js';
import { getEmbedding, getZeroVector } from './embeddingService.js';
import { verifyMedicineRealWorld, getMedicineDescription } from './aiVerificationService.js';
import { findInCache, saveToCache } from './localCacheService.js';
import dotenv from 'dotenv';

dotenv.config();

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

// Returns true if Supabase is configured
function hasSupabase() {
    return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

/**
 * Derive confidence level from strict thresholds.
 */
function deriveConfidence(score) {
    if (score >= 90) return 'High';
    if (score >= 70) return 'Medium';
    return 'Low';
}

/**
 * Apply strict validation rules to a matched result.
 */
function applyValidationRules(extraction, dbRecord, rawScore) {
    let finalScore = rawScore;
    const warnings = [];

    // RULE: Brand Variant Specificity (e.g. 625 vs 375)
    if (extraction.brand_variant) {
        const dbBrandLower = dbRecord.brand_name.toLowerCase();
        const variantInDb = dbBrandLower.includes(extraction.brand_variant.toLowerCase());

        if (!variantInDb) {
            warnings.push('VARIANT_MISMATCH');
            // Strict penalty for variant mismatch
            finalScore *= 0.50;
        }
    }

    // RULE: Combination Integrity
    if (dbRecord.is_combination) {
        const hasPlus = dbRecord.generic_name.includes('+') || dbRecord.generic_name.includes('/');
        if (!hasPlus) {
            warnings.push('COMBINATION_INTEGRITY_VIOLATION');
        }
    }

    // RULE: Form Mismatch — add warning only, do NOT penalize score
    // (OCR may read 'Tab' vs DB has 'Tablet' — both are the same medicine)
    if (extraction.form && dbRecord.form) {
        const extForm = extraction.form.toLowerCase().trim();
        const dbForm = dbRecord.form.toLowerCase().trim();
        if (!extForm.includes(dbForm.slice(0, 3)) && !dbForm.includes(extForm.slice(0, 3))) {
            warnings.push('FORM_MISMATCH');
            // No score penalty — form normalization is unreliable
        }
    }

    return {
        finalScore: Math.round(finalScore * 10) / 10,
        warnings
    };
}

async function exactMatch(extraction) {
    if (!hasSupabase()) return null;

    const searchName = extraction.brand_variant
        ? `${extraction.brand_name} ${extraction.brand_variant}`
        : extraction.brand_name;

    let query = supabaseClient()
        .from('medicines')
        .select('*')
        .ilike('brand_name', searchName);

    // NOTE: do NOT filter by form — form strings in DB may differ ('Tablet' vs 'Tab' etc)
    // Just do a loose name match and validate form separately

    const { data, error } = await query.limit(3);
    if (error || !data || data.length === 0) return null;

    // If form given, try to find a matching-form record first; fall back to first
    let chosen = data[0];
    if (extraction.form && data.length > 1) {
        const formMatch = data.find(r => r.form?.toLowerCase().includes(extraction.form.toLowerCase().slice(0, 3)));
        if (formMatch) chosen = formMatch;
    }

    return {
        record: chosen,
        method: 'exact_match',
        rawScore: 100,
    };
}

async function fuzzyMatch(extraction) {
    if (!hasSupabase()) return null;

    const searchText = extraction.brand_variant
        ? `${extraction.brand_name} ${extraction.brand_variant}`
        : extraction.brand_name;

    const { data, error } = await supabaseClient().rpc('hybrid_medicine_search', {
        query_text: searchText,
        query_vector: JSON.stringify(getZeroVector()),
        match_limit: 5,
        trgm_weight: 1.0,
        vector_weight: 0.0,
    });

    if (error || !data || data.length === 0) return null;

    const best = data[0];
    if (best.trgm_score > 0.18) {  // lowered from 0.25 — catch more OCR variations
        return {
            record: best,
            method: 'fuzzy_match',
            rawScore: Math.round(best.trgm_score * 100),
        };
    }
    return null;
}

async function vectorMatch(extraction) {
    if (!hasSupabase()) return null;

    const searchText = [
        extraction.brand_name,
        extraction.brand_variant,
        extraction.form,
    ].filter(Boolean).join(' ');

    let embedding;
    try {
        embedding = await getEmbedding(searchText);
    } catch (err) {
        return null;
    }

    const { data, error } = await supabaseClient().rpc('hybrid_medicine_search', {
        query_text: searchText,
        query_vector: JSON.stringify(embedding),
        match_limit: 5,
        trgm_weight: 0.4,
        vector_weight: 0.6,
    });

    if (error || !data || data.length === 0) return null;

    const best = data[0];
    if (best.combined_score > 0.20) {  // lowered from 0.25 — allow broader AI-assisted matches
        return {
            record: best,
            method: 'vector_similarity',
            rawScore: Math.round(best.combined_score * 100),
        };
    }
    return null;
}

/**
 * Match extractions and identify those requiring fallback.
 */
export async function matchMedicines(extractions) {
    const results = await Promise.all(extractions.map(async (extraction) => {
        let matchResult = null;
        const brandQuery = extraction.brand_name;

        console.log(`[Matching] Processing: "${brandQuery}"...`);

        // STAGE 0 — Local Cache (previously AI-discovered medicines)
        const cached = findInCache(extraction.brand_name, extraction.brand_variant);
        if (cached) {
            console.log(`[LocalCache] ⚡ Cache hit for "${brandQuery}" — skipping AI lookup`);
            matchResult = { record: cached, method: 'CACHE', rawScore: cached.confidence_pct / 100 || 0.95 };
        }

        // STAGE 1 — Exact Match (Fast, requires Supabase)
        if (!matchResult) {
            const exact = await exactMatch(extraction);
            if (exact) {
                matchResult = { record: exact.record, method: 'EXACT', rawScore: exact.rawScore / 100 };
            }
        }

        // STAGE 2 — Trigram Similarity (Fuzzy, requires Supabase)
        if (!matchResult) {
            const fuzzy = await fuzzyMatch(extraction);
            if (fuzzy) {
                matchResult = { record: fuzzy.record, method: 'FUZZY', rawScore: fuzzy.rawScore / 100 };
            }
        }

        // STAGE 3 — Vector Search (Semantic, requires Supabase + OpenAI)
        if (!matchResult) {
            const vector = await vectorMatch(extraction);
            if (vector) {
                matchResult = { record: vector.record, method: 'VECTOR', rawScore: vector.rawScore / 100 };
            }
        }

        let matchedMedicine = null;
        let warnings = [];

        if (matchResult) {
            const { record, method, rawScore } = matchResult;

            // Cache hits don't need validation rules (already validated when first saved)
            if (method === 'CACHE') {
                matchedMedicine = {
                    id:                  record.id || `cache_${Date.now()}`,
                    brand_name:          record.brand_name,
                    generic_name:        record.generic_name,
                    strength:            record.strength,
                    form:                record.form,
                    manufacturer:        record.manufacturer,
                    is_combination:      record.is_combination,
                    similarity_percentage: record.confidence_pct || 95,
                    confidence:          'High',
                    match_method:        'LOCAL_CACHE',
                    verified_by:         `Local Cache (${record.verified_by || 'AI'})`,
                    validation_warnings: []
                };
            } else {
                const validation = applyValidationRules(extraction, record, rawScore * 100);
                matchedMedicine = {
                    id:                  record.id,
                    brand_name:          record.brand_name,
                    generic_name:        record.generic_name,
                    strength:            record.strength,
                    form:                record.form,
                    manufacturer:        record.manufacturer,
                    is_combination:      record.is_combination,
                    similarity_percentage: validation.finalScore,
                    confidence:          deriveConfidence(validation.finalScore),
                    match_method:        method,
                    verified_by:         'INTERNAL_DB',
                    validation_warnings: validation.warnings
                };
                warnings = validation.warnings;
            }
        } else {
            // STAGE 4 — AI Knowledge Fallback
            console.log(`[Matching] No DB hits for "${brandQuery}". Triggering Stage 4 AI...`);
            const aiMatch = await verifyMedicineRealWorld(
                extraction.brand_name,
                extraction.brand_variant,
                extraction.form
            );

            if (aiMatch) {
                matchedMedicine = aiMatch;
                // --- AUTO-LEARNING: Save High-confidence matches to local cache + Supabase ---
                if (matchedMedicine.confidence === 'High') {
                    // Use the clean NLP-extracted name (e.g. "Paracetamol") as the cache lookup key.
                    // The Stage 4 result brand_name may be a long RxNorm string like
                    // "acetaminophen 300 MG Oral Capsule [By Ache]" which won't match future NLP lookups.
                    saveToCache({
                        ...matchedMedicine,
                        brand_name: extraction.brand_name,          // ← lookup key for next scan
                        full_name:  matchedMedicine.brand_name,     // ← keep original for reference
                    });
                    // Also try Supabase if configured
                    await persistExternalMatch(matchedMedicine);
                }
            }
        }

        // --- ENRICHMENT STAGE: OpenAI Description ---
        if (matchedMedicine) {
            const description = await getMedicineDescription(
                matchedMedicine.brand_name,
                matchedMedicine.generic_name
            );
            matchedMedicine.description = description;
        }

        if (matchedMedicine) {
            return {
                raw_input: [extraction.brand_name, extraction.brand_variant, extraction.form].filter(Boolean).join(' '),
                structured_data: extraction,
                matched_medicine: matchedMedicine
            };
        } else {
            return {
                fallback_required: true,
                raw_input: [extraction.brand_name, extraction.brand_variant, extraction.form].filter(Boolean).join(' '),
                structured_data: {
                    brand_name: extraction.brand_name,
                    brand_variant: extraction.brand_variant || "",
                    form: extraction.form || "",
                    frequency_per_day: extraction.frequency_per_day || 0,
                    duration_days: extraction.duration_days || 0
                }
            };
        }
    }));

    return results;
}

/**
 * Persists an external AI match to the local database for future matching.
 * This effectively "trains" the system with new medicines.
 */
async function persistExternalMatch(aiMatch) {
    if (!hasSupabase()) return; // Skip persistence when DB not configured
    try {
        console.log(`[Training] Persisting new medicine: "${aiMatch.brand_name}"...`);

        // 1. Check if it somehow already exists (prevent race conditions)
        const { data: existing } = await supabaseClient()
            .from('medicines')
            .select('id')
            .ilike('brand_name', aiMatch.brand_name)
            .eq('strength', aiMatch.strength || '')
            .eq('form', aiMatch.form || '')
            .limit(1);

        if (existing && existing.length > 0) {
            console.log(`[Training] Medicine already exists in DB. Skipping persistence.`);
            return;
        }

        // 2. Generate embedding for the new record
        const embeddingText = `${aiMatch.brand_name} ${aiMatch.generic_name} ${aiMatch.form}`.trim();
        const embedding = await getEmbedding(embeddingText);

        // 3. Insert into medicines table
        const { error: insertError } = await supabaseClient()
            .from('medicines')
            .insert({
                brand_name: aiMatch.brand_name,
                generic_name: aiMatch.generic_name,
                strength: aiMatch.strength || '',
                form: aiMatch.form || '',
                is_combination: aiMatch.generic_name.includes('+') || aiMatch.generic_name.includes('/'),
                embedding: JSON.stringify(embedding),
                manufacturer: 'Persisted from AI'
            });

        if (insertError) {
            console.error(`[Training] Error persisting ${aiMatch.brand_name}:`, insertError.message);
        } else {
            console.log(`[Training] Successfully saved "${aiMatch.brand_name}" to the database.`);
        }
    } catch (err) {
        console.error(`[Training] Critical error during persistence:`, err.message);
    }
}
