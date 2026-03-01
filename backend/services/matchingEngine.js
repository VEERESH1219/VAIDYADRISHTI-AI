/**
 * VAIDYADRISHTI AI — 4-Stage Local Matching Engine
 *
 * Uses local PostgreSQL 16 with pg_trgm — no Supabase, no cloud, no API keys.
 *
 * STAGE 0 : Local Cache      — instant in-memory lookup (previously AI-found medicines)
 * STAGE 1 : Exact Match      — LOWER(brand_name) = LOWER(query)
 * STAGE 2 : Fuzzy Match      — pg_trgm similarity on brand_name + generic_name + ILIKE
 * STAGE 3 : AI Fallback      — Ollama → OpenFDA → RxNorm (all free/local)
 *
 * Self-learning: High-confidence AI matches are auto-saved to local cache AND
 * inserted into PostgreSQL so they improve future scans permanently.
 */

import {
    hasPostgres,
    exactMatch   as pgExact,
    fuzzyMatch   as pgFuzzy,
    genericFuzzyMatch,
    containsMatch,
    insertMedicine,
    getMedicineCount,
} from './pgService.js';
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

    // Form mismatch — warning only, no score penalty (OCR "Tab" ≠ DB "Tablet")
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

// ── Minimum fuzzy score to accept a match (below this → Stage 3 AI) ──────────
const MIN_FUZZY_ACCEPT = 30;   // trgm_score % — anything lower is likely wrong

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
 * Only appends brand_variant if it is a real numeric strength (not a dosage pattern).
 */
function buildSearchName(extraction) {
    const useVariant = extraction.brand_variant &&
        !isDosagePattern(extraction.brand_variant) &&
        /^\d+(\.\d+)?$/.test(extraction.brand_variant);  // purely numeric
    return useVariant
        ? `${extraction.brand_name} ${extraction.brand_variant}`
        : extraction.brand_name;
}

// ── Stage 1 — Exact match ─────────────────────────────────────────────────────
async function stageExact(extraction) {
    if (!hasPostgres()) return null;

    const name = buildSearchName(extraction);
    const nameOnly = extraction.brand_name;

    const rows = await pgExact(name);
    if (!rows.length) {
        // Try brand name only (in case variant was a dosage pattern)
        const rowsOnly = name !== nameOnly ? await pgExact(nameOnly) : [];
        // Try normalised name (strips "Tablet", "Cap", etc.)
        const norm = await pgExact(normaliseName(nameOnly));
        const firstHit = rowsOnly[0] || norm[0];
        if (!firstHit) return null;
        return { record: firstHit, method: 'EXACT', rawScore: 100 };
    }

    // Prefer form-matching record when multiple hits
    let chosen = rows[0];
    if (extraction.form && rows.length > 1) {
        const formHit = rows.find(r =>
            (r.form || '').toLowerCase().startsWith(extraction.form.toLowerCase().slice(0, 3))
        );
        if (formHit) chosen = formHit;
    }

    return { record: chosen, method: 'EXACT', rawScore: 100 };
}

// ── Stage 2 — Fuzzy match (trigram similarity + ILIKE) ───────────────────────
async function stageFuzzy(extraction) {
    if (!hasPostgres()) return null;

    // Use brand_name only if brand_variant looks like a dosage pattern (not a strength)
    const name = buildSearchName(extraction);
    // Also always try brand_name alone as a fallback key
    const nameOnly = extraction.brand_name;

    const form = extraction.form || null;

    // 2a — Trigram on search name, then on brand_name alone
    // Pass form so Tablet results rank above Gel/Cream for the same trigram score
    for (const q of [...new Set([name, nameOnly])]) {
        const rows = await pgFuzzy(q, 0.18, 5, form);
        if (rows.length) {
            const best = rows[0];
            const score = parseFloat(best.trgm_score) || 0;
            if (score < MIN_FUZZY_ACCEPT) break;  // score too low — let AI handle it
            return { record: best, method: 'FUZZY', rawScore: score };
        }
    }

    // 2b — Trigram on normalised name (without "Tablet" etc.)
    const norm = normaliseName(nameOnly);
    if (norm !== nameOnly) {
        const rows = await pgFuzzy(norm, 0.20, 5, form);
        if (rows.length) {
            const score = parseFloat(rows[0].trgm_score) || 0;
            if (score >= MIN_FUZZY_ACCEPT) {
                return { record: rows[0], method: 'FUZZY', rawScore: score };
            }
        }
    }

    // 2c — Trigram on generic_name (OCR may have read the ingredient instead of brand)
    const rows2c = await genericFuzzyMatch(nameOnly, 0.30);
    if (rows2c.length) {
        return { record: rows2c[0], method: 'FUZZY_GENERIC', rawScore: 70 };
    }

    // 2d — ILIKE contains (only as last DB resort before AI)
    // Pass extraction.form so Tablet results rank above Gel/Cream results
    const rows2d = await containsMatch(nameOnly, extraction.form || null);
    if (rows2d.length) {
        return { record: rows2d[0], method: 'CONTAINS', rawScore: 60 };
    }

    return null;
}

// ── Format a DB record into the standard matched_medicine shape ───────────────
function formatMatch(extraction, record, method, rawScore) {
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
    };
}

// ── Persist AI-discovered medicine to local cache + PostgreSQL ────────────────
async function persistAiMatch(extraction, aiMatch) {
    // Always save to fast in-memory cache for this session
    saveToCache({
        ...aiMatch,
        brand_name: extraction.brand_name,   // use NLP name as lookup key
        full_name:  aiMatch.brand_name,
    });

    // Also insert into PostgreSQL so future scans find it without AI
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
    // Log DB status once
    const dbReady = hasPostgres();
    if (dbReady) {
        const count = await getMedicineCount().catch(() => 0);
        if (count > 0) {
            console.log(`[Matching] Local PostgreSQL ready — ${count.toLocaleString()} medicines`);
        } else {
            console.warn('[Matching] ⚠️  PostgreSQL connected but medicines table is empty.');
            console.warn('[Matching]    Run: npm run db:setup && npm run db:import <csv-path>');
        }
    } else {
        console.warn('[Matching] ⚠️  PostgreSQL not configured — only AI fallback available.');
        console.warn('[Matching]    Add POSTGRES_PASSWORD to backend/.env');
    }

    const results = await Promise.all(extractions.map(async (extraction) => {
        const query = extraction.brand_name;
        console.log(`\n[Matching] ▶ "${query}"`);

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
            };
            const description = await getMedicineDescription(
                matchedMedicine.brand_name, matchedMedicine.generic_name
            ).catch(() => null);
            matchedMedicine.description = description;
            return buildResult(extraction, matchedMedicine);
        }

        // ── STAGE 1: Exact Match ────────────────────────────────────────────
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

        // ── STAGE 2: Fuzzy Match ────────────────────────────────────────────
        if (!matchResult) {
            const fuzzy = await stageFuzzy(extraction).catch(err => {
                console.error('[Stage 2] Error:', err.message);
                return null;
            });
            if (fuzzy) {
                console.log(`[Stage 2] ✅ Fuzzy match (${fuzzy.method}) — "${fuzzy.record.brand_name}" (${fuzzy.rawScore}%)`);
                matchResult = fuzzy;
            }
        }

        // ── STAGE 3: AI Fallback ────────────────────────────────────────────
        let matchedMedicine = null;

        if (matchResult) {
            matchedMedicine = formatMatch(extraction, matchResult.record, matchResult.method, matchResult.rawScore);
        } else {
            console.log(`[Stage 3] 🤖 No DB hit for "${query}" — calling AI...`);
            const aiMatch = await verifyMedicineRealWorld(
                extraction.brand_name,
                extraction.brand_variant,
                extraction.form
            ).catch(() => null);

            if (aiMatch) {
                console.log(`[Stage 3] ✅ AI found: "${aiMatch.brand_name}"`);
                matchedMedicine = aiMatch;

                // Self-learning — only persist high-confidence AI hits
                if (aiMatch.confidence === 'High') {
                    await persistAiMatch(extraction, aiMatch).catch(() => {});
                }
            }
        }

        // ── Description enrichment (uses Ollama — local, free) ──────────────
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
