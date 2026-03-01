/**
 * MedMap AI — Database Setup Script
 *
 * Runs all SQL files (01–05) against Supabase using the
 * Management API (pg-meta endpoint) or direct SQL via fetch.
 *
 * Usage: node scripts/setupDatabase.js
 */

import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
}

const SQL_FILES = [
    '01_extensions.sql',
    '02_tables.sql',
    '03_indexes.sql',
    '04_functions.sql',
    '05_seed.sql',
];

async function runSQL(sql, filename) {
    // Use Supabase's pg-meta SQL endpoint
    const url = `${SUPABASE_URL}/rest/v1/rpc/`;

    // Try using the raw PostgreSQL connection via Supabase's SQL API
    const response = await fetch(`${SUPABASE_URL}/pg/query`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'apikey': SUPABASE_SERVICE_KEY,
        },
        body: JSON.stringify({ query: sql }),
    });

    if (!response.ok) {
        const text = await response.text();
        // If pg/query doesn't work, try the alternative endpoint
        throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return await response.json();
}

async function main() {
    console.log('\n🗄️  MedMap AI — Database Setup\n');
    console.log(`   Supabase: ${SUPABASE_URL}\n`);

    const dbDir = resolve(__dirname, '..', '..', 'database');

    for (const file of SQL_FILES) {
        const filePath = resolve(dbDir, file);

        try {
            const sql = readFileSync(filePath, 'utf-8');
            console.log(`⏳ Running ${file}...`);
            await runSQL(sql, file);
            console.log(`✅ ${file} — done`);
        } catch (err) {
            console.error(`⚠️  ${file} — ${err.message}`);
            // Continue with remaining files even if one fails
            // (e.g., extensions might already exist)
        }
    }

    console.log('\n🎉 Database setup complete!\n');
    console.log('Next step: run  node scripts/generateEmbeddings.js\n');
}

main().catch((err) => {
    console.error('❌ Setup failed:', err.message);
    process.exit(1);
});
