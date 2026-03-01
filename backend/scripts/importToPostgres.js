/**
 * VAIDYADRISHTI AI — PostgreSQL Medicine Importer
 *
 * Imports the cleaned medicines CSV into local PostgreSQL.
 * Supports both CSV formats:
 *   • Clean format:  id, brand_name, generic_name, strength, form
 *   • Legacy format: name, short_composition1, short_composition2, manufacturer_name
 *
 * Usage:
 *   node scripts/importToPostgres.js <path-to-csv>
 *   npm run db:import "C:/Users/VAMSI/OneDrive/Desktop/FINAL_MEDMAP_CLEANED.csv"
 *
 * Inserts in batches of 1000 rows — ~253k records takes about 30-60 seconds.
 */

import pg     from 'pg';
import { createReadStream } from 'fs';
import { parse }            from 'csv-parse';
import { existsSync }       from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const BATCH_SIZE = 1000;

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

async function flushBatch(client, records) {
    if (records.length === 0) return;

    // Build parameterised multi-row INSERT
    const values  = [];
    const rows    = records.map((r, i) => {
        const b = i * 6;
        values.push(r.brand_name, r.generic_name, r.strength, r.form, r.is_combination, r.manufacturer);
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`;
    });

    await client.query(
        `INSERT INTO medicines (brand_name, generic_name, strength, form, is_combination, manufacturer)
         VALUES ${rows.join(',')}
         ON CONFLICT DO NOTHING`,
        values
    );
}

async function main() {
    const csvPath = process.argv[2];

    if (!csvPath) {
        console.error('\n❌  Usage: node scripts/importToPostgres.js <path-to-csv>\n');
        process.exit(1);
    }

    // Normalise Windows backslashes
    const resolvedPath = csvPath.replace(/\\/g, '/');

    if (!existsSync(resolvedPath)) {
        console.error(`\n❌  File not found: ${resolvedPath}\n`);
        process.exit(1);
    }

    const pool   = new Pool({ connectionString: connectionString() });
    const client = await pool.connect();

    try {
        console.log(`\n📁  Source : ${resolvedPath}`);
        console.log(`🐘  Target : ${connectionString().replace(/:([^:@]+)@/, ':***@')}\n`);

        // Warn if table is non-empty
        const { rows: [{ cnt }] } = await client.query('SELECT COUNT(*) AS cnt FROM medicines');
        if (parseInt(cnt) > 0) {
            console.log(`⚠️   Truncating ${Number(cnt).toLocaleString()} existing records...`);
            await client.query('TRUNCATE medicines RESTART IDENTITY');
        }

        let batch   = [];
        let total   = 0;
        let skipped = 0;

        const parser = createReadStream(resolvedPath).pipe(
            parse({ columns: true, skip_empty_lines: true, trim: true })
        );

        for await (const row of parser) {
            // ── Support both CSV formats ─────────────────────────────────────
            const brandName = (row.brand_name || row.name || '').trim();
            if (!brandName) { skipped++; continue; }

            // Clean format columns
            let genericName  = (row.generic_name || '').trim();
            let strength     = (row.strength     || '').trim();
            let form         = (row.form         || '').trim();
            let manufacturer = (row.manufacturer || row.manufacturer_name || '').trim();

            // Legacy format: extract from composition columns
            if (!genericName && row.short_composition1) {
                const c1 = (row.short_composition1 || '').replace(/\(.*?\)/g, '').trim();
                const c2 = (row.short_composition2 || '').replace(/\(.*?\)/g, '').trim();
                genericName = [c1, c2].filter(Boolean).join(' + ');
            }

            batch.push({
                brand_name:     brandName,
                generic_name:   genericName,
                strength:       strength,
                form:           form || 'Tablet',
                is_combination: genericName.includes('+'),
                manufacturer:   manufacturer,
            });

            if (batch.length >= BATCH_SIZE) {
                await flushBatch(client, batch);
                total += batch.length;
                batch  = [];
                process.stdout.write(`\r✅  Imported: ${total.toLocaleString()} medicines...`);
            }
        }

        // Final batch
        if (batch.length > 0) {
            await flushBatch(client, batch);
            total += batch.length;
        }

        console.log(`\r✅  Imported: ${total.toLocaleString()} medicines        `);

        // Rebuild trigram index statistics for optimal query planning
        console.log('🔧  Analysing indexes...');
        await client.query('ANALYZE medicines');

        const { rows: [{ final_cnt }] } = await client.query(
            'SELECT COUNT(*) AS final_cnt FROM medicines'
        );

        console.log(`\n🎉  Import complete!`);
        console.log(`    ✅  Total in DB : ${Number(final_cnt).toLocaleString()} medicines`);
        if (skipped > 0) console.log(`    ⚠️   Skipped     : ${skipped} empty rows`);
        console.log('\n    You can now start the backend: npm start\n');

    } catch (err) {
        console.error('\n❌  Import failed:', err.message);
        if (err.message.includes('medicines') && err.message.includes('exist')) {
            console.error('    → Run setup first: npm run db:setup');
        }
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

main();
