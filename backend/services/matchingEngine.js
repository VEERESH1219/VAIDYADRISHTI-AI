/**
 * VAIDYADRISHTI AI — 5-Stage Local Matching Engine (v2)
 */

import {
    hasPostgres,
    exactMatch   as pgExact,
    fuzzyMatch   as pgFuzzy,
    genericFuzzyMatch,
    containsMatch,
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

const MIN_FUZZY_ACCEPT = 50;

function deriveConfidence(score) {
    if (score >= 90) return 'High';
    if (score >= 70) return 'Medium';
    return 'Low';
}

function normaliseName(name) {
    return name
        .replace(/\b(tablet|tab|capsule|cap|injection|inj|syrup|syr|ointment|solution|drops|cream|gel|spray|powder)\b/gi, '')
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

async function stageExact(extraction) {
    if (!hasPostgres()) return null;

    const name = buildSearchName(extraction);
    const rows = await pgExact(name);
    if (!rows.length) return null;

    return { record: rows[0], method: 'EXACT', rawScore: 100 };
}

async function stageFuzzy(extraction) {
    if (!hasPostgres()) return null;

    const name = buildSearchName(extraction);
    const rows = await pgFuzzy(name, 0.35, 5, extraction.form || null);
    if (!rows.length) return null;

    const score = parseFloat(rows[0].trgm_score) || 0;
    if (score < MIN_FUZZY_ACCEPT) return null;

    return { record: rows[0], method: 'FUZZY', rawScore: score };
}

async function stageVector(extraction) {
    if (!hasPostgres()) return null;

    try {
        const embedding = await getEmbedding(buildSearchName(extraction));
        const rows = await pgVector(embedding, 5, extraction.form || null);
        if (!rows.length) return null;

        const score = Math.round((parseFloat(rows[0].similarity_score) || 0) * 100);
        if (score < 50) return null;

        return { record: rows[0], method: 'VECTOR', rawScore: score };
    } catch {
        return null;
    }
}

function formatMatch(extraction, record, method, rawScore) {
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

                const cached = findInCache(extraction.brand_name, extraction.brand_variant);
                if (cached) {
                    const description = await llmLimit(() =>
                        getMedicineDescription(cached.brand_name, cached.generic_name)
                    ).catch(() => null);

                    return {
                        raw_input: extraction.brand_name,
                        structured_data: extraction,
                        matched_medicine: { ...cached, description },
                    };
                }

                let match =
                    await stageExact(extraction) ||
                    await stageFuzzy(extraction) ||
                    await stageVector(extraction);

                let matchedMedicine = null;

                if (match) {
                    matchedMedicine = formatMatch(
                        extraction,
                        match.record,
                        match.method,
                        match.rawScore
                    );
                } else {
                    const aiMatch = await llmLimit(() =>
                        verifyMedicineRealWorld(
                            extraction.brand_name,
                            extraction.brand_variant,
                            extraction.form
                        )
                    ).catch(() => null);

                    if (aiMatch) {
                        matchedMedicine = aiMatch;
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

                return {
                    raw_input: extraction.brand_name,
                    structured_data: extraction,
                    matched_medicine: matchedMedicine,
                };
            })
        )
    );

    return results;
}
