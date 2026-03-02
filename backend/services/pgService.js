/**
 * VAIDYADRISHTI AI — Local PostgreSQL Service
 *
 * Replaces Supabase with a local PostgreSQL 16 database.
 * Uses pg_trgm for trigram fuzzy matching — same quality as Supabase,
 * 100% local, no cloud, no API keys.
 *
 * Connection config (backend/.env):
 *   DATABASE_URL=postgresql://postgres:<password>@localhost:5432/vaidyadrishti
 *   OR individual vars: POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB
 */

import pg     from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// ── Connection pool (lazy) ────────────────────────────────────────────────────
let _pool = null;

function connectionString() {
    return (
        process.env.DATABASE_URL ||
        `postgresql://${process.env.POSTGRES_USER     || 'postgres'}` +
        `:${process.env.POSTGRES_PASSWORD || 'postgres'}` +
        `@${process.env.POSTGRES_HOST     || 'localhost'}` +
        `:${process.env.POSTGRES_PORT     || 5432}` +
        `/${process.env.POSTGRES_DB       || 'vaidyadrishti'}`
    );
}

export function getPool() {
    if (!_pool) {
        _pool = new Pool({
            connectionString: connectionString(),
            max: 10,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 5_000,
        });
        _pool.on('error', (err) => {
            console.error('[PostgreSQL] Pool error:', err.message);
        });
    }
    return _pool;
}

/** Returns true if PostgreSQL credentials are set in .env */
export function hasPostgres() {
    return !!(
        process.env.DATABASE_URL ||
        process.env.POSTGRES_PASSWORD ||
        process.env.POSTGRES_HOST
    );
}

/** Quick connectivity check — returns true if DB is reachable */
export async function pingDb() {
    try {
        const client = await getPool().connect();
        await client.query('SELECT 1');
        client.release();
        return true;
    } catch {
        return false;
    }
}

// ── Search functions ──────────────────────────────────────────────────────────

/**
 * Stage 1 — Exact match (case-insensitive)
 * e.g. "Augmentin 625" → exact brand_name hit
 */
export async function exactMatch(brandName, limit = 3) {
    const { rows } = await getPool().query(
        `SELECT * FROM medicines
         WHERE LOWER(brand_name) = LOWER($1)
         LIMIT $2`,
        [brandName, limit]
    );
    return rows;
}

/**
 * Stage 2a — Trigram similarity fuzzy match (requires pg_trgm)
 * Catches OCR variations: "Augmentin" → "Augrnentin", "Amoxyclav" → "Amoxiclav"
 * When preferredForm is given (e.g. "Tablet"), form-matching records rank first
 * among equally-scored trigram hits — prevents a Gel match beating a Tablet match.
 */
export async function fuzzyMatch(searchText, threshold = 0.18, limit = 5, preferredForm = null) {
    const { rows } = await getPool().query(
        `SELECT *, ROUND((similarity(brand_name, $1) * 100)::numeric, 1) AS trgm_score
         FROM medicines
         WHERE similarity(brand_name, $1) > $2
         ORDER BY
           CASE WHEN $4::text IS NOT NULL AND LOWER(form) = LOWER($4) THEN 0 ELSE 1 END,
           similarity(brand_name, $1) DESC
         LIMIT $3`,
        [searchText, threshold, limit, preferredForm]
    );
    return rows;
}

/**
 * Stage 2b — Generic name fuzzy match
 * Catches when OCR reads the generic name instead of brand name
 */
export async function genericFuzzyMatch(searchText, threshold = 0.20, limit = 5) {
    const { rows } = await getPool().query(
        `SELECT *, ROUND((similarity(generic_name, $1) * 100)::numeric, 1) AS trgm_score
         FROM medicines
         WHERE similarity(generic_name, $1) > $2
         ORDER BY similarity(generic_name, $1) DESC
         LIMIT $3`,
        [searchText, threshold, limit]
    );
    return rows;
}

/**
 * Stage 2c — ILIKE contains match (broad fallback)
 * Catches partial names: "Amox" → "Amoxycillin 500mg Tablet"
 * When preferredForm is given (e.g. "Tablet"), form-matching records rank first.
 */
export async function containsMatch(brandName, preferredForm = null, limit = 5) {
    const core = brandName.split(/\s+/)[0]; // first word only
    const { rows } = await getPool().query(
        `SELECT * FROM medicines
         WHERE brand_name ILIKE $1
         ORDER BY
           CASE WHEN $2::text IS NOT NULL AND LOWER(form) = LOWER($2) THEN 0 ELSE 1 END,
           CASE WHEN brand_name ILIKE $3 THEN 0 ELSE 1 END,
           LENGTH(brand_name) ASC
         LIMIT $4`,
        [`%${core}%`, preferredForm, `${core}%`, limit]
    );
    return rows;
}

/**
 * Stage 3 — Vector similarity match (requires pgvector extension + populated embeddings)
 * Uses cosine distance on the embedding column.
 * When preferredForm is given, form-matching records rank first among equally-scored hits.
 * Gracefully returns empty array if embedding column or pgvector is not available.
 */
export async function vectorMatch(queryEmbedding, limit = 5, preferredForm = null) {
    try {
        const { rows } = await getPool().query(
            `SELECT *,
                    1 - (embedding <=> $1::vector) AS similarity_score
             FROM medicines
             WHERE embedding IS NOT NULL
             ORDER BY
               CASE WHEN $3::text IS NOT NULL AND LOWER(form) = LOWER($3) THEN 0 ELSE 1 END,
               embedding <=> $1::vector ASC
             LIMIT $2`,
            [JSON.stringify(queryEmbedding), limit, preferredForm]
        );
        return rows;
    } catch (err) {
        // pgvector not installed or embedding column missing — graceful fallback
        if (err.message.includes('vector') || err.message.includes('embedding') || err.message.includes('type')) {
            console.warn('[PostgreSQL] Vector search unavailable:', err.message);
            return [];
        }
        throw err;
    }
}

/**
 * Insert a newly AI-discovered medicine into local DB (self-learning).
 */
export async function insertMedicine(med) {
    try {
        const { rowCount } = await getPool().query(
            `INSERT INTO medicines (brand_name, generic_name, strength, form, is_combination, manufacturer)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT DO NOTHING`,
            [
                med.brand_name,
                med.generic_name  || '',
                med.strength      || '',
                med.form          || '',
                (med.generic_name || '').includes('+'),
                med.manufacturer  || 'AI Discovered',
            ]
        );
        return rowCount > 0;
    } catch (err) {
        console.error('[PostgreSQL] Insert error:', err.message);
        return false;
    }
}

/** Total medicine count (for health endpoint) */
export async function getMedicineCount() {
    try {
        const { rows } = await getPool().query('SELECT COUNT(*) AS cnt FROM medicines');
        return parseInt(rows[0].cnt, 10);
    } catch {
        return 0;
    }
}

export async function insertPrescriptionLog({
    tenantId,
    userId,
    rawInput,
    extractedCount
}) {
    if (!hasPostgres()) return;

    const query = `
        INSERT INTO prescription_logs (tenant_id, user_id, raw_input, extracted_count)
        VALUES ($1, $2, $3, $4)
    `;

    await pool.query(query, [
        tenantId,
        userId,
        rawInput,
        extractedCount
    ]);
}
