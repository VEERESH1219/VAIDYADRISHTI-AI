/**
 * VAIDYADRISHTI AI — 5-Stage Local Matching Engine (v2)
 */

import {
    hasPostgres,
    exactMatch   as pgExact,
    fuzzyMatch   as pgFuzzy,
    genericFuzzyMatch,
    vectorMatch  as pgVector,
    insertMedicine,
    getMedicineCount,
} from './pgService.js';

import { getEmbedding } from './embeddingService.js';
import { verifyMedicineRealWorld, getMedicineDescription } from './aiVerificationService.js';
import { findInCache, saveToCache } from './localCacheService.js';
import { llmLimit } from '../utils/limiter.js';

import pLimit from 'p-limit';
import dotenv from 'dotenv';

dotenv.config();

const medLimit = pLimit(2); // max 2 medicines per request

const MIN_FUZZY_ACCEPT = 65;

function deriveConfidence(score) {
    if (score >= 90) return 'High';
    if (score >= 70) return 'Medium';
    return 'Low';
}

function normalizeMedicineName(input) {
    if (!input) return '';

    return String(input)
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\b\d+(\.\d+)?\s*(mg|ml|mcg|g|iu)\b/gi, ' ')
        .replace(/\b(mg|ml|mcg|g|iu)\b/gi, ' ')
        .replace(/\b(tablet|tab|tabs|capsule|cap|caps|injection|inj|syrup|syr|ointment|solution|drops|drop|cream|gel|spray|powder)\b/gi, ' ')
        .replace(/\b\d+(\.\d+)?\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isDosagePattern(variant) {
    if (!variant) return false;
    return /[+]/.test(variant) || /^\d+-\d+-\d+$/.test(variant);
}

function buildSearchName(extraction) {
    if (extraction.normalized_query) return extraction.normalized_query;

    const useVariant =
        extraction.brand_variant &&
        !isDosagePattern(extraction.brand_variant) &&
        /^\d+(\.\d+)?$/.test(extraction.brand_variant);

    return useVariant
        ? `${extraction.brand_name} ${extraction.brand_variant}`
        : extraction.brand_name;
}

function buildSearchCandidates(extraction) {
    const candidates = [
        buildSearchName(extraction),
        extraction.brand_name,
        normalizeMedicineName(buildSearchName(extraction)),
        normalizeMedicineName(extraction.brand_name),
    ].filter(Boolean);

    return [...new Set(candidates)];
}

async function stageExact(extraction) {
    if (!hasPostgres()) return null;

    const candidates = buildSearchCandidates(extraction);
    for (const name of candidates) {
        const rows = await pgExact(name);
        if (rows.length) {
            return {
                record: rows[0],
                method: 'EXACT',
                rawScore: 100,
                ambiguous: false,
                requires_human_verification: false,
            };
        }
    }

    return null;
}

async function stageFuzzy(extraction) {
    if (!hasPostgres()) return null;

    const name = normalizeMedicineName(buildSearchName(extraction));
    if (!name) return null;

    const rows = await pgFuzzy(name, 0.65, 5, extraction.form || null);
    if (!rows.length) return null;

    const safeRows = rows.filter((row) => (parseFloat(row.trgm_score) || 0) >= MIN_FUZZY_ACCEPT);
    if (!safeRows.length) return null;

    const score = parseFloat(safeRows[0].trgm_score) || 0;
    const ambiguous = safeRows.length > 1;

    return {
        record: safeRows[0],
        method: 'FUZZY',
        rawScore: score,
        ambiguous,
        requires_human_verification: ambiguous,
    };
}

async function stageGeneric(extraction) {
    if (!hasPostgres()) return null;

    const name = normalizeMedicineName(buildSearchName(extraction));
    if (!name) return null;

    const rows = await genericFuzzyMatch(name, 0.65, 5);
    if (!rows.length) return null;

    const safeRows = rows.filter((row) => (parseFloat(row.trgm_score) || 0) >= MIN_FUZZY_ACCEPT);
    if (!safeRows.length) return null;

    const score = parseFloat(safeRows[0].trgm_score) || 0;
    const ambiguous = safeRows.length > 1;

    return {
        record: safeRows[0],
        method: 'GENERIC_FUZZY',
        rawScore: score,
        ambiguous,
        requires_human_verification: ambiguous,
    };
}

async function stageVector(extraction) {
    if (!hasPostgres()) return null;

    try {
        const searchName = normalizeMedicineName(buildSearchName(extraction));
        if (!searchName) return null;

        const embedding = await getEmbedding(searchName);
        const rows = await pgVector(embedding, 5, extraction.form || null);
        if (!rows.length) return null;

        const score = Math.round((parseFloat(rows[0].similarity_score) || 0) * 100);
        if (score < 50) return null;

        return {
            record: rows[0],
            method: 'VECTOR',
            rawScore: score,
            ambiguous: false,
            requires_human_verification: false,
        };
    } catch {
        return null;
    }
}

function formatMatch(extraction, record, method, rawScore, ambiguous = false, requiresHumanVerification = false) {
    return {
        id: record.id,
        brand_name: record.brand_name,
        generic_name: record.generic_name,
        strength: record.strength,
        form: record.form,
        manufacturer: record.manufacturer,
        similarity_percentage: rawScore,
        confidence: deriveConfidence(rawScore),
        match_method: method,
        verified_by: 'LOCAL_POSTGRES',
        ambiguous,
        requires_human_verification: requiresHumanVerification,
    };
}

async function persistAiMatch(extraction, aiMatch) {
    saveToCache({
        ...aiMatch,
        brand_name: extraction.brand_name,
    });

    if (hasPostgres()) {
        await insertMedicine({
            brand_name: extraction.brand_name,
            generic_name: aiMatch.generic_name,
            strength: aiMatch.strength,
            form: aiMatch.form,
            manufacturer: 'AI Discovered',
        });
    }
}

export async function matchMedicines(extractions) {
    if (hasPostgres()) {
        const count = await getMedicineCount().catch(() => 0);
        console.log(`[Matching] DB Ready (${count} medicines)`);
    }

    const results = await Promise.all(
        extractions.map(extraction =>
            medLimit(async () => {
                try {
                    const normalizedInput = normalizeMedicineName(buildSearchName(extraction));

                    const cached =
                        findInCache(extraction.brand_name, extraction.brand_variant) ||
                        findInCache(normalizedInput, extraction.brand_variant);

                    if (cached) {
                        const description = await llmLimit(() =>
                            getMedicineDescription(cached.brand_name, cached.generic_name)
                        ).catch(() => null);

                        const matchedMedicine = {
                            ...cached,
                            description,
                            ambiguous: false,
                            requires_human_verification: false,
                        };

                        return {
                            raw_input: extraction.brand_name,
                            structured_data: extraction,
                            matched_medicine: matchedMedicine,
                            fallback_required: false,
                            ambiguous: false,
                            requires_human_verification: false,
                        };
                    }

                    let match =
                        await stageExact(extraction) ||
                        await stageFuzzy(extraction) ||
                        await stageGeneric(extraction) ||
                        await stageVector(extraction);

                    let matchedMedicine = null;
                    let fallbackRequired = false;

                    if (match) {
                        matchedMedicine = formatMatch(
                            extraction,
                            match.record,
                            match.method,
                            match.rawScore,
                            !!match.ambiguous,
                            !!match.requires_human_verification
                        );
                    } else {
                        fallbackRequired = true;
                        const aiMatch = await llmLimit(() =>
                            verifyMedicineRealWorld(
                                extraction.brand_name,
                                extraction.brand_variant,
                                extraction.form
                            )
                        ).catch(() => null);

                        if (aiMatch) {
                            matchedMedicine = {
                                ...aiMatch,
                                ambiguous: false,
                                requires_human_verification: false,
                            };
                            if (aiMatch.confidence === 'High') {
                                await persistAiMatch(extraction, aiMatch);
                            }
                        }
                    }

                    if (matchedMedicine) {
                        const description = await llmLimit(() =>
                            getMedicineDescription(
                                matchedMedicine.brand_name,
                                matchedMedicine.generic_name
                            )
                        ).catch(() => null);

                        matchedMedicine.description = description;
                    }

                    const ambiguous = !!matchedMedicine?.ambiguous;
                    const requiresHumanVerification = !!matchedMedicine?.requires_human_verification;

                    return {
                        raw_input: extraction.brand_name,
                        structured_data: extraction,
                        matched_medicine: matchedMedicine,
                        fallback_required: fallbackRequired,
                        ambiguous,
                        requires_human_verification: requiresHumanVerification,
                    };
                } catch {
                    return {
                        raw_input: extraction.brand_name,
                        structured_data: extraction,
                        matched_medicine: null,
                        fallback_required: true,
                        ambiguous: false,
                        requires_human_verification: false,
                    };
                }
            })
        )
    );

    return results;
}
