/**
 * MedMap AI — CSV Medicine Importer
 *
 * Reads indian_medicines.csv from project root and batch-inserts
 * into the Supabase medicines table.
 *
 * Usage: node scripts/importMedicines.js [path-to-csv]
 *
 * CSV expected columns: name, type, Is_discontinued, short_composition1,
 *   short_composition2, pack_size_label, manufacturer_name
 */

import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse';
import { createReadStream } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

/**
 * Extract the brand name from a full product name.
 * e.g. "Augmentin 625 DUO Tablet" → "Augmentin 625 DUO"
 */
function extractBrandName(fullName) {
    const formPatterns = /\b(Tablet|Capsule|Syrup|Injection|Cream|Ointment|Suspension|Drops?|Gel|Spray|Powder|Lotion|Solution|Inhaler|Patch|Suppository)\b/gi;
    return fullName.replace(formPatterns, '').trim();
}

/**
 * Extract form from product name or pack size.
 */
function extractForm(name, packSize = '') {
    const combined = `${name} ${packSize}`.toLowerCase();
    if (/tablet/i.test(combined)) return 'Tablet';
    if (/capsule/i.test(combined)) return 'Capsule';
    if (/syrup|suspension|liquid|oral solution/i.test(combined)) return 'Syrup';
    if (/injection|vial|ampoule/i.test(combined)) return 'Injection';
    if (/cream|ointment|gel/i.test(combined)) return 'Cream';
    if (/drop/i.test(combined)) return 'Drops';
    if (/inhaler/i.test(combined)) return 'Inhaler';
    if (/spray/i.test(combined)) return 'Spray';
    if (/powder|sachet/i.test(combined)) return 'Powder';
    return 'Tablet'; // default fallback
}

/**
 * Build generic name from composition columns.
 */
function buildGenericName(comp1, comp2) {
    const parts = [comp1, comp2].filter(Boolean).map((c) => {
        // Extract just the drug name (remove strength in parentheses)
        return c.replace(/\(.*?\)/g, '').trim();
    });
    return parts.join(' + ') || 'Unknown';
}

/**
 * Build strength string from composition columns.
 */
function buildStrength(comp1, comp2) {
    const extractStrength = (comp) => {
        const match = comp.match(/\(([^)]+)\)/);
        return match ? match[1] : '';
    };

    const parts = [comp1, comp2]
        .filter(Boolean)
        .map(extractStrength)
        .filter(Boolean);

    return parts.join(' + ') || 'Standard';
}

async function main() {
    const csvPath = process.argv[2] || resolve(process.cwd(), '..', 'FInal medical data (1).csv');

    console.log(`\n📁 Reading CSV from: ${csvPath}\n`);

    const records = [];

    const parser = createReadStream(csvPath).pipe(
        parse({
            columns: true,
            skip_empty_lines: true,
            trim: true,
        })
    );

    for await (const row of parser) {
        // Skip records without a name
        if (!row.name) continue;

        const brandName = extractBrandName(row.name || '');
        const form = extractForm(row.name || '', ''); // Form is now just in the name
        const genericName = buildGenericName(
            row.short_composition1 || '',
            row.short_composition2 || ''
        );
        const strength = buildStrength(
            row.short_composition1 || '',
            row.short_composition2 || ''
        );
        const isCombination = !!(row.short_composition2 && row.short_composition2.trim());

        records.push({
            brand_name: brandName,
            generic_name: genericName,
            strength,
            form,
            category: null,
            is_combination: isCombination,
            manufacturer: row.manufacturer_name || null,
        });
    }

    console.log(`📊 Parsed ${records.length} valid records.\n`);

    // Batch insert (500 rows at a time)
    const BATCH_SIZE = 500;
    let inserted = 0;

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from('medicines').insert(batch);

        if (error) {
            console.error(`❌ Error inserting batch at row ${i}:`, error.message);
        } else {
            inserted += batch.length;
            console.log(`✅ Inserted ${inserted}/${records.length}`);
        }
    }

    console.log(`\n🎉 Import complete! Total inserted: ${inserted}\n`);
}

main().catch((err) => {
    console.error('❌ Import failed:', err);
    process.exit(1);
});
