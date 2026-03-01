/**
 * VAIDYADRISHTI AI — History Service
 * Stores every scan to localStorage, including duplicates.
 * Always stores newest first.
 */

const HISTORY_KEY = 'vaidyadrishti_history';
const MAX_HISTORY = 50; // raised limit, duplicates allowed

export function getHistory() {
    try {
        const data = localStorage.getItem(HISTORY_KEY);
        return data ? JSON.parse(data) : [];
    } catch { return []; }
}

export function saveToHistory(result, inputType = 'image') {
    try {
        const history = getHistory();
        const entry = {
            id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, // unique even for same-second duplicate
            timestamp: new Date().toISOString(),
            inputType,
            medical_condition: result.medical_condition || null,
            medicine_count: result.extracted_medicines?.length || 0,
            medicines: (result.extracted_medicines || []).map(ext => ({
                brand_name: ext.structured_data?.brand_name || '',
                strength: ext.matched_medicine?.strength || null,
                confidence: ext.matched_medicine?.confidence || null,
                matched: !!ext.matched_medicine,
                form: ext.structured_data?.form || null,
                frequency: ext.structured_data?.frequency_per_day || null,
            })),
            processing_time_ms: result.processing_time_ms || 0,
            ocr_score: result.ocr_result?.consensus_score || null,
        };
        // Always prepend — no dedup
        const updated = [entry, ...history].slice(0, MAX_HISTORY);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
        return entry;
    } catch { return null; }
}

export function clearHistory() {
    try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore storage errors */ }
}

export function deleteHistoryEntry(id) {
    try {
        const updated = getHistory().filter(h => h.id !== id);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
    } catch { /* ignore storage errors */ }
}
