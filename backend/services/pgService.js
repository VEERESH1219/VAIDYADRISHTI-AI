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
import { loadEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { recordDbQuery } from '../observability/metrics.js';

loadEnv();

const { Pool } = pg;

// ── Connection pool (lazy) ────────────────────────────────────────────────────
let _pool = null;
const SLOW_QUERY_THRESHOLD_MS = Number(process.env.DB_SLOW_QUERY_MS || 500);
const DB_POOL_MAX = Number(process.env.DB_POOL_MAX || 10);
const DB_POOL_IDLE_TIMEOUT_MS = Number(process.env.DB_POOL_IDLE_TIMEOUT_MS || 30_000);
const DB_POOL_CONN_TIMEOUT_MS = Number(process.env.DB_POOL_CONN_TIMEOUT_MS || 5_000);

function inferQueryOperation(queryText) {
    if (typeof queryText !== 'string') return 'unknown';
    const firstToken = queryText.trim().split(/\s+/)[0]?.toUpperCase();
    return firstToken || 'unknown';
}

function wrapPoolQuery(pool) {
    if (pool.__metricsWrapped) return;

    const baseQuery = pool.query.bind(pool);
    pool.query = async (...args) => {
        const queryText = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        const operation = inferQueryOperation(queryText);
        const startedAt = process.hrtime.bigint();
        let success = false;

        try {
            const result = await baseQuery(...args);
            success = true;
            return result;
        } finally {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            const isSlow = durationMs >= SLOW_QUERY_THRESHOLD_MS;

            recordDbQuery({
                operation,
                durationMs,
                success,
                isSlow,
            });

            if (isSlow) {
                logger.warn({
                    operation,
                    durationMs: Number(durationMs.toFixed(2)),
                    thresholdMs: SLOW_QUERY_THRESHOLD_MS,
                }, 'db_slow_query_detected');
            }
        }
    };

    pool.__metricsWrapped = true;
}

function connectionString() {
    return (
        process.env.DATABASE_URL ||
        `postgresql://${process.env.POSTGRES_USER}` +
        `:${process.env.POSTGRES_PASSWORD}` +
        `@${process.env.POSTGRES_HOST}` +
        `:${process.env.POSTGRES_PORT}` +
        `/${process.env.POSTGRES_DB}`
    );
}

export function getPool() {
    if (!_pool) {
        _pool = new Pool({
            connectionString: connectionString(),
            max: DB_POOL_MAX,
            idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT_MS,
            connectionTimeoutMillis: DB_POOL_CONN_TIMEOUT_MS,
        });
        wrapPoolQuery(_pool);
        _pool.on('error', (err) => {
            logger.error({ err: err.message }, '[PostgreSQL] Pool error');
        });
    }
    return _pool;
}

/** Returns true if PostgreSQL credentials are set in .env */
export function hasPostgres() {
    return !!(
        process.env.DATABASE_URL ||
        (
            process.env.POSTGRES_HOST &&
            process.env.POSTGRES_PORT &&
            process.env.POSTGRES_DB &&
            process.env.POSTGRES_USER &&
            process.env.POSTGRES_PASSWORD
        )
    );
}

/** Quick connectivity check — returns true if DB is reachable */
export async function pingDb() {
    const details = await pingDbDetailed();
    return details.ok;
}

export async function pingDbDetailed() {
    const startedAt = process.hrtime.bigint();
    try {
        const client = await getPool().connect();
        await client.query('SELECT 1');
        client.release();
        const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        return { ok: true, latencyMs };
    } catch (err) {
        const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        return { ok: false, latencyMs, error: err?.message };
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
            logger.warn({ err: err.message }, '[PostgreSQL] Vector search unavailable');
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
        logger.error({ err: err.message }, '[PostgreSQL] Insert error');
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

export async function getTenantDailyLimit(tenantId) {
    if (!tenantId || !hasPostgres()) return 500;

    try {
        const { rows } = await getPool().query(
            `
            SELECT daily_limit
            FROM tenants
            WHERE id = $1
            LIMIT 1
            `,
            [tenantId]
        );

        const value = Number(rows[0]?.daily_limit);
        return Number.isFinite(value) ? value : 500;
    } catch (err) {
        logger.warn({ err: err.message }, '[PostgreSQL] tenants daily_limit fallback');
        return 500;
    }
}

export async function getTenantTodayUsage(tenantId) {
    if (!tenantId || !hasPostgres()) {
        return {
            total_requests: 0,
            total_extractions: 0
        };
    }

    try {
        const { rows } = await getPool().query(
            `
            SELECT
                COUNT(*)::int AS total_requests,
                COALESCE(SUM(extracted_count), 0)::int AS total_extractions
            FROM prescription_logs
            WHERE tenant_id = $1
              AND created_at >= CURRENT_DATE
              AND created_at < CURRENT_DATE + INTERVAL '1 day'
            `,
            [tenantId]
        );

        return {
            total_requests: rows[0]?.total_requests || 0,
            total_extractions: rows[0]?.total_extractions || 0
        };
    } catch (err) {
        logger.warn({ err: err.message }, '[PostgreSQL] tenant usage fallback');
        return {
            total_requests: 0,
            total_extractions: 0
        };
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

    try {
        await getPool().query(query, [
            tenantId,
            userId,
            rawInput,
            extractedCount
        ]);
    } catch (err) {
        logger.warn({ err: err.message }, '[PostgreSQL] prescription_logs insert skipped');
    }
}

export async function createProcessingJob({
    jobId,
    tenantId,
    userId,
    status = 'queued',
    inputPayload,
}) {
    const query = `
        INSERT INTO processing_jobs (id, tenant_id, user_id, status, input_payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (id) DO NOTHING
    `;

    await getPool().query(query, [
        jobId,
        tenantId,
        userId,
        status,
        JSON.stringify(inputPayload || {}),
    ]);
}

export async function markProcessingJobInProgress(jobId) {
    await getPool().query(
        `
        UPDATE processing_jobs
        SET status = 'processing',
            started_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND status = 'queued'
        `,
        [jobId]
    );
}

export async function markProcessingJobCompleted(jobId, outputPayload) {
    await getPool().query(
        `
        UPDATE processing_jobs
        SET status = 'completed',
            output_payload = $2::jsonb,
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND status IN ('queued', 'processing')
        `,
        [jobId, JSON.stringify(outputPayload || {})]
    );
}

export async function markProcessingJobFailed(jobId, errorMessage) {
    await getPool().query(
        `
        UPDATE processing_jobs
        SET status = 'failed',
            error_message = LEFT($2, 1000),
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND status <> 'completed'
        `,
        [jobId, String(errorMessage || 'Job failed')]
    );
}

export async function getProcessingJob(jobId, tenantId) {
    const { rows } = await getPool().query(
        `
        SELECT id, tenant_id, user_id, status, input_payload, output_payload, error_message, created_at, started_at, completed_at
        FROM processing_jobs
        WHERE id = $1
          AND tenant_id = $2
        LIMIT 1
        `,
        [jobId, tenantId]
    );

    return rows[0] || null;
}

export async function closePool() {
    if (!_pool) return;
    await _pool.end();
    _pool = null;
}
