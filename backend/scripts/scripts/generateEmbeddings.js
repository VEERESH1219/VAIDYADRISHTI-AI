/**
 * MedMap AI — Optimized Embedding Generator
 * 
 * Populates the `embedding` column for medicines in Supabase using OpenAI.
 * Optimized for large datasets (250k+ records).
 */

import { createClient } from '@supabase/supabase-js';
import { getEmbedding } from '../services/embeddingService.js';
import dotenv from 'dotenv';

dotenv.config();

// ── Environment Sanitization ─────────────────────
// Clean environment variables (removes hidden Unicode/BOM)
Object.keys(process.env).forEach(key => {
    if (typeof process.env[key] === 'string') {
        process.env[key] = process.env[key].replace(/[^\x20-\x7E]/g, '').trim();
    }
});

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

async function processBatch(batch) {
    console.log(`📡 Connecting to: ${process.env.SUPABASE_URL}`);
    return Promise.all(
        batch.map(async (med) => {
            try {
                // Skip if already has embedding (second check)
                if (med.embedding) return;

                const text = `${med.brand_name} ${med.generic_name} ${med.form}`.trim();
                const embedding = await getEmbedding(text);

                const { error: updateError } = await supabase
                    .from('medicines')
                    .update({ embedding: JSON.stringify(embedding) })
                    .eq('id', med.id);

                if (updateError) {
                    console.error(`❌ Failed to update ${med.brand_name}:`, updateError.message);
                } else {
                    return true;
                }
            } catch (err) {
                console.error(`❌ Embedding error for ${med.brand_name}:`, err.message);
            }
            return false;
        })
    );
}

async function main() {
    console.log('\n🔢 Starting optimized embedding generation...\n');

    const TOTAL_LIMIT = 250000; // Hard limit for safety
    const FETCH_CHUNK = 1000;   // Fetch 1000 null records at a time
    const BATCH_SIZE = 20;      // Process 20 parallel requests to OpenAI

    let totalProcessed = 0;

    while (totalProcessed < TOTAL_LIMIT) {
        console.log(`📡 Connecting to Supabase at: ${process.env.SUPABASE_URL}`);
        console.log(`⏳ Fetching next ${FETCH_CHUNK} records without embeddings...`);

        const { data: missing, error } = await supabase
            .from('medicines')
            .select('id, brand_name, generic_name, form, embedding')
            .is('embedding', null)
            .limit(FETCH_CHUNK);

        if (error) {
            console.error('❌ Database fetch error:', error.message);
            break;
        }

        if (!missing || missing.length === 0) {
            console.log('\n✅ All records have embeddings! Done.\n');
            break;
        }

        console.log(`📊 Processing ${missing.length} records in small batches...`);

        for (let i = 0; i < missing.length; i += BATCH_SIZE) {
            const batch = missing.slice(i, i + BATCH_SIZE);
            const results = await processBatch(batch);

            const successCount = results.filter(Boolean).length;
            totalProcessed += successCount;

            process.stdout.write(`\r🔢 Progress: ${totalProcessed} records updated...`);

            // Tiny sleep for rate limiting
            await new Promise(r => setTimeout(r, 200));
        }
    }

    console.log(`\n\n🎉 Finished! Total embeddings generated: ${totalProcessed}\n`);
}

main().catch((err) => {
    console.error('❌ Critical failure:', err);
    process.exit(1);
});
