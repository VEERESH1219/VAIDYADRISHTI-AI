import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse';
import dotenv from 'dotenv';
import { Readable } from 'stream';

dotenv.config();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

/**
 * Extract the brand name from a full product name.
 */
function extractBrandName(fullName) {
    const formPatterns = /\b(Tablet|Capsule|Syrup|Injection|Cream|Ointment|Suspension|Drops?|Gel|Spray|Powder|Lotion|Solution|Inhaler|Patch|Suppository)\b/gi;
    return fullName.replace(formPatterns, '').trim();
}

/**
 * Extract form from product name.
 */
function extractForm(name) {
    const combined = name.toLowerCase();
    if (/tablet/i.test(combined)) return 'Tablet';
    if (/capsule/i.test(combined)) return 'Capsule';
    if (/syrup|suspension|liquid|oral solution/i.test(combined)) return 'Syrup';
    if (/injection|vial|ampoule/i.test(combined)) return 'Injection';
    if (/cream|ointment|gel/i.test(combined)) return 'Cream';
    if (/drop/i.test(combined)) return 'Drops';
    if (/inhaler/i.test(combined)) return 'Inhaler';
    if (/spray/i.test(combined)) return 'Spray';
    if (/powder|sachet/i.test(combined)) return 'Powder';
    return 'Tablet';
}

/**
 * Build generic name from composition columns.
 */
function buildGenericName(comp1, comp2) {
    const parts = [comp1, comp2].filter(Boolean).map((c) => c.replace(/\(.*?\)/g, '').trim());
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
    const parts = [comp1, comp2].filter(Boolean).map(extractStrength).filter(Boolean);
    return parts.join(' + ') || 'Standard';
}

async function importFromBucket(bucketName, fileName) {
    console.log(`\n📥 Downloading ${fileName} from ${bucketName}...`);

    const { data, error: downloadError } = await supabase.storage.from(bucketName).download(fileName);

    if (downloadError) {
        throw new Error(`Download failed: ${downloadError.message}`);
    }

    console.log(`✅ Download complete. Parsing CSV...`);

    const records = [];
    const text = await data.text();
    const parser = Readable.from(text).pipe(
        parse({
            columns: true,
            skip_empty_lines: true,
            trim: true,
        })
    );

    for await (const row of parser) {
        if (!row.name) continue;

        const brandName = extractBrandName(row.name);
        const form = extractForm(row.name);
        const genericName = buildGenericName(row.short_composition1, row.short_composition2);
        const strength = buildStrength(row.short_composition1, row.short_composition2);
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

    console.log(`📊 Parsed ${records.length} records. Inserting into database...`);

    const BATCH_SIZE = 500;
    let inserted = 0;

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from('medicines').insert(batch);

        if (error) {
            console.error(`❌ Error inserting batch at row ${i}:`, error.message);
        } else {
            inserted += batch.length;
            process.stdout.write(`\r✅ Inserted ${inserted}/${records.length}`);
        }
    }

    console.log(`\n\n🎉 Import complete! Total inserted: ${inserted}\n`);
}

const BUCKET = process.argv[2] || 'MED_DATA';
const FILE = process.argv[3] || 'FInal medical data.csv';

importFromBucket(BUCKET, FILE).catch(err => {
    console.error('❌ Import failed:', err.message);
    process.exit(1);
});
