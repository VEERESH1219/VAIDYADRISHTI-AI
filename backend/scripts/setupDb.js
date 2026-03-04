/**
 * VAIDYADRISHTI AI — Local PostgreSQL Schema Setup
 *
 * Run once before importing medicines:
 *   node scripts/setupDb.js
 *   (or: npm run db:setup)
 *
 * Creates:
 *   - pg_trgm extension (trigram fuzzy search)
 *   - medicines table
 *   - tenants table
 *   - prescription_logs table
 *   - processing_jobs table
 *   - GIN trigram indexes on brand_name + generic_name (fast fuzzy queries)
 *   - B-tree index on LOWER(brand_name) (fast exact match)
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Client } = pg;

function connectionString() {
    return (
        process.env.DATABASE_URL ||
        `postgresql://${process.env.POSTGRES_USER || 'postgres'}` +
        `:${process.env.POSTGRES_PASSWORD || 'postgres'}` +
        `@${process.env.POSTGRES_HOST || 'localhost'}` +
        `:${process.env.POSTGRES_PORT || 5432}` +
        `/${process.env.POSTGRES_DB || 'vaidyadrishti'}`
    );
}

async function main() {
    console.log('\n🔧  VAIDYADRISHTI AI — PostgreSQL Setup\n');

    const client = new Client({ connectionString: connectionString() });

    try {
        await client.connect();
        console.log('✅  Connected to PostgreSQL');

        // 1a. pg_trgm extension — enables similarity() and GIN trgm indexes
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        console.log('✅  pg_trgm extension enabled');

        // 1b. pgvector extension — enables vector similarity search (optional)
        try {
            await client.query('CREATE EXTENSION IF NOT EXISTS vector');
            console.log('✅  pgvector extension enabled');
        } catch (err) {
            console.warn('⚠️   pgvector not available (vector search Stage 3 will be skipped):', err.message);
        }

        // 2a. medicines table
        await client.query(`
            CREATE TABLE IF NOT EXISTS medicines (
                id            BIGSERIAL PRIMARY KEY,
                brand_name    TEXT NOT NULL,
                generic_name  TEXT    DEFAULT '',
                strength      TEXT    DEFAULT '',
                form          TEXT    DEFAULT '',
                is_combination BOOLEAN DEFAULT FALSE,
                manufacturer  TEXT    DEFAULT '',
                created_at    TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('✅  medicines table ready');

        // 2b. tenants table (matches existing schema: id, plan, daily_limit, monthly_limit)
        await client.query(`
            CREATE TABLE IF NOT EXISTS tenants (
                id            TEXT PRIMARY KEY,
                plan          TEXT NOT NULL DEFAULT 'free',
                daily_limit   INT NOT NULL DEFAULT 500,
                monthly_limit INT NOT NULL DEFAULT 10000,
                created_at    TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        // Insert a default dev tenant if not exists
        await client.query(`
            INSERT INTO tenants (id, plan, daily_limit, monthly_limit)
            VALUES ('dev', 'free', 500, 10000)
            ON CONFLICT (id) DO NOTHING
        `);
        console.log('✅  tenants table ready (dev tenant ensured)');

        // 2c. prescription_logs table (matches existing schema: UUID id)
        await client.query(`
            CREATE TABLE IF NOT EXISTS prescription_logs (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id       TEXT NOT NULL,
                user_id         TEXT,
                raw_input       TEXT DEFAULT '',
                extracted_count INT DEFAULT 0,
                created_at      TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_prescription_logs_tenant_created
            ON prescription_logs (tenant_id, created_at DESC)
        `);
        console.log('✅  prescription_logs table ready');

        // 2d. processing_jobs table for async OCR/NLP pipelines
        await client.query(`
            CREATE TABLE IF NOT EXISTS processing_jobs (
                id            UUID PRIMARY KEY,
                tenant_id     TEXT NOT NULL,
                user_id       TEXT NOT NULL,
                status        TEXT NOT NULL DEFAULT 'queued',
                input_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                output_payload JSONB,
                error_message TEXT,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                started_at    TIMESTAMPTZ,
                completed_at  TIMESTAMPTZ,
                updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_processing_jobs_tenant_created
            ON processing_jobs (tenant_id, created_at DESC)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_processing_jobs_status
            ON processing_jobs (status)
        `);
        console.log('✅  processing_jobs table ready');

        // 2e. Add embedding column for vector search (pgvector, optional)
        try {
            await client.query(`
                ALTER TABLE medicines
                ADD COLUMN IF NOT EXISTS embedding vector(1536)
            `);
            console.log('✅  embedding column ready');
        } catch (err) {
            console.warn('⚠️   Could not add embedding column (pgvector may not be installed):', err.message);
        }

        // 3. Exact-match index (B-tree on lower-cased brand_name)
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_med_brand_lower
            ON medicines (LOWER(brand_name))
        `);

        // 4. Trigram GIN index on brand_name — powers similarity() fast lookup
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_med_brand_trgm
            ON medicines USING GIN (brand_name gin_trgm_ops)
        `);

        // 5. Trigram GIN index on generic_name — catches generic-name OCR reads
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_med_generic_trgm
            ON medicines USING GIN (generic_name gin_trgm_ops)
        `);

        console.log('✅  All indexes created (exact + trigram fuzzy)');

        const { rows: [{ cnt }] } = await client.query(
            'SELECT COUNT(*) AS cnt FROM medicines'
        );
        console.log(`\n📊  Current medicine count: ${Number(cnt).toLocaleString()}`);
        console.log('\n🎉  Setup complete!');
        console.log('    Next step: npm run db:import "C:/path/to/your/medicines.csv"\n');

    } catch (err) {
        console.error('\n❌  Setup failed:', err.message);
        if (err.message.includes('password')) {
            console.error('    → Check POSTGRES_PASSWORD in backend/.env');
        }
        if (err.message.includes('database') && err.message.includes('does not exist')) {
            console.error('    → Create the database first:');
            console.error('      psql -U postgres -c "CREATE DATABASE vaidyadrishti;"');
        }
        process.exit(1);
    } finally {
        await client.end();
    }
}

main();
