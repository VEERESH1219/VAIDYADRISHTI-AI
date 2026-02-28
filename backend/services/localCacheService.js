/**
 * VAIDYADRISHTI AI — Local Medicine Cache Service
 *
 * A self-learning local database that grows as new medicines are discovered
 * via Stage 4 AI verification. Stored as JSON in backend/data/medicines_cache.json.
 *
 * - Loaded into memory on startup for fast O(1) lookups
 * - Auto-saves whenever a new medicine is discovered
 * - Works 100% offline — no Supabase required
 * - Acts as Stage 0 in the matching pipeline (checked before Supabase)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR  = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'medicines_cache.json');

// ── In-memory store ─────────────────────────────────────────────────────────
let cache    = [];               // full array
let cacheMap = new Map();        // brand_name.toLowerCase() → [records]

// ── Helpers ──────────────────────────────────────────────────────────────────
function rebuildMap() {
    cacheMap.clear();
    for (const med of cache) {
        const key = (med.brand_name || '').toLowerCase().trim();
        if (!cacheMap.has(key)) cacheMap.set(key, []);
        cacheMap.get(key).push(med);
    }
}

function persistToDisk() {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
    } catch (err) {
        console.error('[LocalCache] ❌ Failed to save cache to disk:', err.message);
    }
}

// ── Initialise on module load ─────────────────────────────────────────────────
function init() {
    try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

        if (!fs.existsSync(CACHE_FILE)) {
            fs.writeFileSync(CACHE_FILE, '[]', 'utf8');
            console.log('[LocalCache] 📁 New cache file created at backend/data/medicines_cache.json');
            return;
        }

        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        cache = JSON.parse(raw);
        rebuildMap();
        console.log(`[LocalCache] 📦 Loaded ${cache.length} medicine(s) from local cache.`);
    } catch (err) {
        console.error('[LocalCache] ❌ Failed to load cache:', err.message);
        cache = [];
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up a medicine by brand name (and optionally variant/strength).
 * Returns a DB-compatible record or null.
 */
export function findInCache(brandName, variant) {
    if (!brandName) return null;
    const key     = brandName.toLowerCase().trim();
    const matches = cacheMap.get(key) || [];
    if (matches.length === 0) return null;

    // If a numeric variant is given, prefer the record that mentions it in strength
    if (variant) {
        const variantHit = matches.find(m =>
            (m.strength  || '').includes(variant) ||
            (m.brand_name|| '').toLowerCase().includes(variant.toLowerCase())
        );
        if (variantHit) return variantHit;
    }

    return matches[0]; // best (first-inserted) record
}

/**
 * Save a newly discovered medicine to the local cache.
 * Skips duplicates (same brand_name already cached).
 * Returns true if saved, false if already existed.
 */
export function saveToCache(medicine) {
    if (!medicine?.brand_name) return false;

    const key = medicine.brand_name.toLowerCase().trim();

    // Skip if already cached
    if (cacheMap.has(key)) {
        console.log(`[LocalCache] ℹ️  "${medicine.brand_name}" already in cache — skipping.`);
        return false;
    }

    const entry = {
        // Core fields
        brand_name:    medicine.brand_name,
        generic_name:  medicine.generic_name  || '',
        strength:      medicine.strength       || '',
        form:          medicine.form           || '',
        manufacturer:  medicine.manufacturer   || 'AI Discovered',
        is_combination: !!(medicine.generic_name || '').includes('+'),
        // Meta
        verified_by:   medicine.verified_by    || 'AI Knowledge',
        confidence_pct: medicine.similarity_percentage || 95,
        cached_at:     new Date().toISOString(),
    };

    cache.push(entry);
    if (!cacheMap.has(key)) cacheMap.set(key, []);
    cacheMap.get(key).push(entry);

    persistToDisk();
    console.log(`[LocalCache] ✅ Saved "${medicine.brand_name}" → backend/data/medicines_cache.json  (total: ${cache.length})`);
    return true;
}

/**
 * Return stats about the local cache (used in health endpoint).
 */
export function getCacheStats() {
    return {
        total_cached: cache.length,
        cache_file:   CACHE_FILE,
    };
}

/**
 * Return the full list of cached medicines (for admin/debug).
 */
export function getAllCached() {
    return [...cache];
}

// Initialise immediately when the module is imported
init();
