/**
 * VAIDYADRISHTI AI — 5-Stage Local Matching Engine (v2)
 *
 * Uses local PostgreSQL 16 with pg_trgm + pgvector — no cloud, no API keys required.
 *
 * STAGE 0 : Local Cache      — instant in-memory lookup (previously AI-found medicines)
 * STAGE 1 : Exact Match      — LOWER(brand_name) = LOWER(normalized_query)
 * STAGE 2 : Fuzzy Match      — pg_trgm similarity (threshold ≥ 50%, query ≥ 0.35)
 * STAGE 3 : Vector Match     — pgvector cosine similarity (requires OPENAI_API_KEY)
 * STAGE 4 : AI Fallback      — Ollama → OpenFDA → RxNorm (all free/local)
 *
 * Ambiguity detection: if top 2 results differ by < 10 points → AMBIGUOUS
 * Self-learning: High-confidence AI matches auto-saved to cache + PostgreSQL.
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
import dotenv from 'dotenv';

dotenv.config();

// ── Confidence thresholds ─────────────────────────────────────────────────────
function deriveConfidence(score) {
    if (score >= 90) return 'High';
    if (score >= 70) return 'Medium';
    return 'Low';
}

// ── Validation rules (brand variant, combination integrity, form) ─────────────
function applyValidationRules(extraction, dbRecord, rawScore) {
    let finalScore = rawScore;
    const warnings = [];

    // Numeric variant must appear in DB brand_name (625 ≠ 375)
    if (extraction.brand_variant) {
        const inDb = dbRecord.brand_name.toLowerCase()
            .includes(extraction.brand_variant.toLowerCase());
        if (!inDb) {
            warnings.push('VARIANT_MISMATCH');
            finalScore *= 0.50;
        }
    }

    // Combination drugs must contain + or / in generic_name
    if (dbRecord.is_combination) {
        const hasPlus = (dbRecord.generic_name || '').includes('+') ||
                        (dbRecord.generic_name || '').includes('/');
        if (!hasPlus) warnings.push('COMBINATION_INTEGRITY_VIOLATION');
    }

    // Form mismatch — warning only, no score penalty
    if (extraction.form && dbRecord.form) {
        const ef = extraction.form.toLowerCase().trim();
        const df = dbRecord.form.toLowerCase().trim();
        if (!ef.includes(df.slice(0, 3)) && !df.includes(ef.slice(0, 3))) {
            warnings.push('FORM_MISMATCH');
        }
    }

    return { finalScore: Math.round(finalScore * 10) / 10, warnings };
}

// ── Name normalisation for better matching ────────────────────────────────────
function normaliseName(name) {
    return name
        .replace(/\b(tablet|tab|capsule|cap|injection|inj|syrup|syr|ointment|solution|drops|cream|gel|spray|powder)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ── Minimum fuzzy score to accept (below this → vector/AI stages) ────────────
const MIN_FUZZY_ACCEPT = 50;

/**
 * Returns true if the value looks like a dosage pattern (e.g. "0+0+1", "1-0-1")
 * rather than a numeric drug strength (e.g. "500", "625").
 */
function isDosagePattern(variant) {
    if (!variant) return false;
    return /[+]/.test(variant) || /^\d+-\d+-\d+$/.test(variant);
}

/**
 * Build the search name for DB queries.
 * Prefers the LLM-generated normalized_query when available.
 * Falls back to brand_name + brand_variant (if numeric, not dosage pattern).
 */
function buildSearchName(extraction) {
    if (extraction.normalized_query) {
        return extraction.normalized_query;
    }
    const useVariant = extraction.brand_variant &&
        !isDosagePattern(extraction.brand_variant) &&
        /^\d+(\.\d+)?$/.test(extraction.brand_variant);
    return useVariant
        ? `${extraction.brand_name} ${extraction.brand_variant}`
        : extraction.brand_name;
}

// ── Ambiguity detection ──────────────────────────────────────────────────────
/**
 * If the top 2 results differ by < 10 percentage points, mark as AMBIGUOUS.
 */
function detectAmbiguity(rows, scoreField = 'trgm_score') {
    if (!rows || rows.length < 2) return { ambiguous: false, topCandidates: [] };
    const score1 = parseFloat(rows[0][scoreField]) || 0;
    const score2 = parseFloat(rows[1][scoreField]) || 0;

    if (Math.abs(score1 - score2) < 10) {
        return {
            ambiguous: true,
            topCandidates: rows.slice(0, 3).map(r => ({
                brand_name: r.brand_name,
                generic_name: r.generic_name,
                strength: r.strength,
                form: r.form,
                score: parseFloat(r[scoreField]) || 0,
            })),
        };
    }
    return { ambiguous: false, topCandidates: [] };
}

// ── Stage 1 — Exact match (always wins — never overridden) ───────────────────
async function stageExact(extraction) {
    if (!hasPostgres()) return null;

    const name = buildSearchName(extraction);
    const nameOnly = extraction.brand_name;

    const rows = await pgExact(name);
    if (!rows.length) {
        const rowsOnly = name !== nameOnly ? await pgExact(nameOnly) : [];
        const norm = await pgExact(normaliseName(nameOnly));
        const firstHit = rowsOnly[0] || norm[0];
        if (!firstHit) return null;
        return { record: firstHit, method: 'EXACT', rawScore: 100, ambiguous: false, topCandidates: [] };
    }

    let chosen = rows[0];
    if (extraction.form && rows.length > 1) {
        const formHit = rows.find(r =>
            (r.form || '').toLowerCase().startsWith(extraction.form.toLowerCase().slice(0, 3))
        );
        if (formHit) chosen = formHit;
    }

    return { record: chosen, method: 'EXACT', rawScore: 100, ambiguous: false, topCandidates: [] };
}

// ── Stage 2 — Fuzzy match (trigram similarity, threshold 0.35, accept ≥ 50) ─
async function stageFuzzy(extraction) {
    if (!hasPostgres()) return null;

    const name = buildSearchName(extraction);
    const nameOnly = extraction.brand_name;
    const form = extraction.form || null;

    // 2a — Trigram on search name, then on brand_name alone
    for (const q of [...new Set([name, nameOnly])]) {
        const rows = await pgFuzzy(q, 0.35, 5, form);
        if (rows.length) {
            const best = rows[0];
            const score = parseFloat(best.trgm_score) || 0;
            if (score < MIN_FUZZY_ACCEPT) break;
            const { ambiguous, topCandidates } = detectAmbiguity(rows);
            return { record: best, method: 'FUZZY', rawScore: score, ambiguous, topCandidates };
        }
    }

    // 2b — Trigram on normalised name (without "Tablet" etc.)
    const norm = normaliseName(nameOnly);
    if (norm !== nameOnly) {
        const rows = await pgFuzzy(norm, 0.35, 5, form);
        if (rows.length) {
            const score = parseFloat(rows[0].trgm_score) || 0;
            if (score >= MIN_FUZZY_ACCEPT) {
                const { ambiguous, topCandidates } = detectAmbiguity(rows);
                return { record: rows[0], method: 'FUZZY', rawScore: score, ambiguous, topCandidates };
            }
        }
    }

    // 2c — Trigram on generic_name
    const rows2c = await genericFuzzyMatch(nameOnly, 0.30);
    if (rows2c.length) {
        const { ambiguous, topCandidates } = detectAmbiguity(rows2c);
        return { record: rows2c[0], method: 'FUZZY_GENERIC', rawScore: 70, ambiguous, topCandidates };
    }

    // 2d — ILIKE contains (last DB resort before vector/AI)
    const rows2d = await containsMatch(nameOnly, extraction.form || null);
    if (rows2d.length) {
        return { record: rows2d[0], method: 'CONTAINS', rawScore: 60, ambiguous: false, topCandidates: [] };
    }

    return null;
}

// ── Stage 3 — Vector match (pgvector cosine similarity) ──────────────────────
async function stageVector(extraction) {
    if (!hasPostgres()) return null;

    const searchName = buildSearchName(extraction);
    let embedding;
    try {
        embedding = await getEmbedding(searchName);
    } catch (err) {
        console.log('[Stage 3] Vector search unavailable:', err.message);
        return null;
    }

    const form = extraction.form || null;
    const rows = await pgVector(embedding, 5, form);
    if (!rows.length) return null;

    const best = rows[0];
    const cosine = parseFloat(best.similarity_score) || 0;
    const pctScore = Math.round(cosine * 100);

    if (pctScore < 50) return null;

    let ambiguous = false;
    let topCandidates = [];
    if (rows.length >= 2) {
        const s1 = parseFloat(rows[0].similarity_score) || 0;
        const s2 = parseFloat(rows[1].similarity_score) || 0;
        if (Math.abs(s1 - s2) < 0.1) {
            ambiguous = true;
            topCandidates = rows.slice(0, 3).map(r => ({
                brand_name: r.brand_name,
                generic_name: r.generic_name,
                strength: r.strength,
                form: r.form,
                score: Math.round((parseFloat(r.similarity_score) || 0) * 100),
            }));
        }
    }

    return { record: best, method: 'VECTOR', rawScore: pctScore, ambiguous, topCandidates };
}

// ── Format a DB record into the standard matched_medicine shape ───────────────
function formatMatch(extraction, record, method, rawScore, ambiguous = false, topCandidates = []) {
    const validation = applyValidationRules(extraction, record, rawScore);
    return {
        id:                    record.id,
        brand_name:            record.brand_name,
        generic_name:          record.generic_name,
        strength:              record.strength,
        form:                  record.form,
        manufacturer:          record.manufacturer,
        is_combination:        record.is_combination,
        similarity_percentage: validation.finalScore,
        confidence:            deriveConfidence(validation.finalScore),
        match_method:          method,
        verified_by:           'LOCAL_POSTGRES',
        validation_warnings:   validation.warnings,
        ambiguous,
        requires_human_verification: ambiguous,
        top_candidates:        ambiguous ? topCandidates : undefined,
    };
}

// ── Persist AI-discovered medicine to local cache + PostgreSQL ────────────────
async function persistAiMatch(extraction, aiMatch) {
    saveToCache({
        ...aiMatch,
        brand_name: extraction.brand_name,
        full_name:  aiMatch.brand_name,
    });

    if (hasPostgres()) {
        const saved = await insertMedicine({
            brand_name:   extraction.brand_name,
            generic_name: aiMatch.generic_name,
            strength:     aiMatch.strength,
            form:         aiMatch.form,
            manufacturer: 'AI Discovered',
        });
        if (saved) {
            console.log(`[Self-Learning] ✅ Saved "${extraction.brand_name}" to local DB`);
        }
    }
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function matchMedicines(extractions) {
    const dbReady = hasPostgres();
    if (dbReady) {
        const count = await getMedicineCount().catch(() => 0);
        if (count > 0) {
            console.log(`[Matching] Local PostgreSQL ready — ${count.toLocaleString()} medicines`);
        } else {
            console.warn('[Matching] ⚠️  PostgreSQL connected but medicines table is empty.');
        }
    } else {
        console.warn('[Matching] ⚠️  PostgreSQL not configured — only AI fallback available.');
    }

    const results = await Promise.all(extractions.map(async (extraction) => {
        const query = buildSearchName(extraction);
        console.log(`\n[Matching] ▶ "${query}" (confidence: ${extraction.confidence_score ?? 'N/A'})`);

        let matchResult = null;

        // ── STAGE 0: Local Cache ────────────────────────────────────────────
        const cached = findInCache(extraction.brand_name, extraction.brand_variant);
        if (cached) {
            console.log(`[Stage 0] ⚡ Cache hit — "${query}"`);
            const matchedMedicine = {
                id:                    cached.id || `cache_${Date.now()}`,
                brand_name:            cached.brand_name,
                generic_name:          cached.generic_name,
                strength:              cached.strength,
                form:                  cached.form,
                manufacturer:          cached.manufacturer,
                is_combination:        cached.is_combination,
                similarity_percentage: cached.confidence_pct || 95,
                confidence:            'High',
                match_method:          'LOCAL_CACHE',
                verified_by:           `Cache (${cached.verified_by || 'AI'})`,
                validation_warnings:   [],
                ambiguous:             false,
                requires_human_verification: false,
            };
            const description = await getMedicineDescription(
                matchedMedicine.brand_name, matchedMedicine.generic_name
            ).catch(() => null);
            matchedMedicine.description = description;
            return buildResult(extraction, matchedMedicine);
        }

        // ── STAGE 1: Exact Match (always wins — never overridden) ───────────
        if (!matchResult) {
            const exact = await stageExact(extraction).catch(err => {
                console.error('[Stage 1] Error:', err.message);
                return null;
            });
            if (exact) {
                console.log(`[Stage 1] ✅ Exact match — "${exact.record.brand_name}"`);
                matchResult = exact;
            }
        }

        // ── STAGE 2: Fuzzy Match (≥ 50% trigram score) ──────────────────────
        if (!matchResult) {
            const fuzzy = await stageFuzzy(extraction).catch(err => {
                console.error('[Stage 2] Error:', err.message);
                return null;
            });
            if (fuzzy) {
                console.log(`[Stage 2] ✅ Fuzzy match (${fuzzy.method}) — "${fuzzy.record.brand_name}" (${fuzzy.rawScore}%)${fuzzy.ambiguous ? ' ⚠️ AMBIGUOUS' : ''}`);
                matchResult = fuzzy;
            }
        }

        // ── STAGE 3: Vector Match (pgvector, ≥ 50%) ────────────────────────
        if (!matchResult) {
            const vector = await stageVector(extraction).catch(err => {
                console.error('[Stage 3] Error:', err.message);
                return null;
            });
            if (vector) {
                console.log(`[Stage 3] ✅ Vector match — "${vector.record.brand_name}" (${vector.rawScore}%)${vector.ambiguous ? ' ⚠️ AMBIGUOUS' : ''}`);
                matchResult = vector;
            }
        }

        // ── STAGE 4: AI Fallback ────────────────────────────────────────────
        let matchedMedicine = null;

        if (matchResult) {
            matchedMedicine = formatMatch(
                extraction, matchResult.record, matchResult.method, matchResult.rawScore,
                matchResult.ambiguous, matchResult.topCandidates
            );
        } else {
            console.log(`[Stage 4] 🤖 No DB/vector hit for "${query}" — calling AI...`);
            const aiMatch = await verifyMedicineRealWorld(
                extraction.brand_name,
                extraction.brand_variant,
                extraction.form
            ).catch(() => null);

            if (aiMatch) {
                console.log(`[Stage 4] ✅ AI found: "${aiMatch.brand_name}"`);
                matchedMedicine = aiMatch;
                matchedMedicine.ambiguous = false;
                matchedMedicine.requires_human_verification = false;

                if (aiMatch.confidence === 'High') {
                    await persistAiMatch(extraction, aiMatch).catch(() => {});
                }
            }
        }

        // ── Description enrichment ──────────────────────────────────────────
        if (matchedMedicine) {
            const description = await getMedicineDescription(
                matchedMedicine.brand_name,
                matchedMedicine.generic_name
            ).catch(() => null);
            matchedMedicine.description = description;
        }

        return buildResult(extraction, matchedMedicine);
    }));

    return results;
}

function buildResult(extraction, matchedMedicine) {
    if (matchedMedicine) {
        return {
            raw_input:      [extraction.brand_name, extraction.brand_variant, extraction.form].filter(Boolean).join(' '),
            structured_data: extraction,
            matched_medicine: matchedMedicine,
        };
    }
    return {
        fallback_required: true,
        raw_input: [extraction.brand_name, extraction.brand_variant, extraction.form].filter(Boolean).join(' '),
        structured_data: {
            brand_name:        extraction.brand_name,
            brand_variant:     extraction.brand_variant    || '',
            form:              extraction.form             || '',
            frequency_per_day: extraction.frequency_per_day || 0,
            duration_days:     extraction.duration_days    || 0,
        },
    };
}
