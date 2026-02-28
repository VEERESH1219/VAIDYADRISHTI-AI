/**
 * VAIDYADRISHTI AI — AI Verification Service (Stage 4 Fallback)
 *
 * This service is triggered when the internal database has no match.
 * It uses a chain of reputable sources:
 *   1. Web Source: OpenFDA API
 *   2. Web Source: RxNorm API
 *   3. AI Knowledge Base (configured LLM — openai, anthropic, gemini, or ollama)
 */

import { chatJSON, chatText, PROVIDER } from './llmService.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Helper: Universal fetch with timeout to prevent hangs.
 */
async function fetchWithTimeout(url, timeoutLimit = 4000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutLimit);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (!response.ok) return null;
        return await response.json();
    } catch {
        clearTimeout(id);
        return null;
    }
}

/**
 * 1. AI Knowledge Base (uses configured LLM provider)
 */
async function lookupAI(brandName, variant, form) {
    // Do NOT include form in the query — let AI determine the correct form from knowledge.
    // Passing the NLP-guessed form would bias the result (e.g. "Amoxicillin 625 Capsule" → AI echoes Capsule)
    const query = [brandName, variant].filter(Boolean).join(' ');
    console.log(`[Stage4-AI/${PROVIDER}] Verifying: "${query}"...`);

    const systemPrompt = `You are a professional medical knowledge engine.
Verify if this medicine exists in the real-world market (focusing on India/Global).
RULES:
1. ONLY return if you are 95%+ confident.
2. If it's a typo, suggest the correction.
3. Return ONLY clean JSON.

SCHEMA:
{
  "exists": boolean,
  "confidence": number(0-100),
  "official_brand": "string",
  "generic_name": "string",
  "std_strength": "string",
  "std_form": "string"
}`;

    try {
        const parsed = await chatJSON(systemPrompt, `Verify: "${query}"`, 0);
        if (parsed.exists && parsed.confidence >= 90) {
            console.log(`[Stage4-AI/${PROVIDER}] ✓ Match found: "${parsed.official_brand}"`);
            return {
                id: `ai_v_${Date.now()}`,
                brand_name: parsed.official_brand,
                generic_name: parsed.generic_name,
                strength: parsed.std_strength,
                form: parsed.std_form,
                similarity_percentage: parsed.confidence,
                confidence: 'High',
                verified_by: `AI Knowledge (${PROVIDER.charAt(0).toUpperCase() + PROVIDER.slice(1)})`
            };
        }
    } catch (err) {
        console.error(`[Stage4-AI/${PROVIDER}] Error:`, err.message);
    }
    return null;
}

/**
 * 2. Web Source: OpenFDA
 */
async function lookupOpenFDA(brandName, variant) {
    const query = variant ? `"${brandName}" AND "${variant}"` : `"${brandName}"`;
    const url = `https://api.fda.gov/drug/label.json?search=openfda.brand_name:${encodeURIComponent(query)}&limit=1`;

    console.log(`[Stage4-OpenFDA] Searching web source...`);
    const data = await fetchWithTimeout(url);

    if (data?.results?.[0]?.openfda) {
        const fda = data.results[0].openfda;
        console.log(`[Stage4-OpenFDA] ✓ Match found in web sources.`);
        return {
            id: `fda_${Date.now()}`,
            brand_name: fda.brand_name?.[0] || brandName,
            generic_name: fda.substance_name?.join(' + ') || fda.generic_name?.[0] || 'Unknown Generic',
            strength: fda.strength?.[0] || '',
            form: fda.dosage_form?.[0] || '',
            similarity_percentage: 95,
            confidence: 'High',
            verified_by: 'Web Source: OpenFDA'
        };
    }
    return null;
}

/**
 * 3. Web Source: RxNorm (NLM)
 */
async function lookupRxNorm(brandName) {
    const url = `https://rxnav.nlm.nih.gov/REST/drugs.json?name=${encodeURIComponent(brandName)}`;

    console.log(`[Stage4-RxNorm] Searching web source...`);
    const data = await fetchWithTimeout(url);

    const groups = data?.drugGroup?.conceptGroup;
    if (groups?.length) {
        const brandGroup = groups.find(g => g.tty === 'BN' || g.tty === 'SBD');
        const concept = brandGroup?.conceptProperties?.[0];

        if (concept) {
            console.log(`[Stage4-RxNorm] ✓ Match found in web sources.`);
            return {
                id: `rx_${concept.rxcui}`,
                brand_name: concept.name,
                generic_name: 'Standardized Formulation',
                strength: '',
                form: '',
                similarity_percentage: 92,
                confidence: 'High',
                verified_by: 'Web Source: RxNorm (NLM)'
            };
        }
    }
    return null;
}

/**
 * Main Export: Orchestrates multi-source real-world lookup.
 * Prioritizes official Web Sources (OpenFDA/RxNorm) as requested.
 */
export async function verifyMedicineRealWorld(brandName, variant = '', form = '') {
    console.log(`\n[Stage4] Fallback engaged for: "${brandName}"`);

    // 1. OpenFDA (Primary Web Fallback)
    const fdaResult = await lookupOpenFDA(brandName, variant);
    if (fdaResult) {
        console.log('[Stage4] ✅ Found in Web Source: OpenFDA.');
        return fdaResult;
    }

    // 2. RxNorm (Secondary Web Fallback)
    const rxResult = await lookupRxNorm(brandName);
    if (rxResult) {
        console.log('[Stage4] ✅ Found in Web Source: RxNorm.');
        return rxResult;
    }

    // 3. AI Knowledge Base (Intelligent Cleanup & Knowledge Fallback)
    const aiResult = await lookupAI(brandName, variant, form);
    if (aiResult) {
        console.log('[Stage4] ✅ Found in AI Knowledge Base.');
        return aiResult;
    }

    console.log(`[Stage4] ✗ No matches found in any web source.`);
    return null;
}
/**
 * Get a short, professional 1-line description/usage for a medicine using OpenAI.
 */
export async function getMedicineDescription(brandName, genericName) {
    if (!brandName && !genericName) return null;

    const query = [brandName, genericName].filter(Boolean).join(' / ');
    console.log(`[Description] Generating usage for: "${query}"...`);

    const systemPrompt = `You are a professional pharmacist. Give ONE sentence (max 20 words) describing what the medicine treats. Focus on the GENERIC NAME only, not brand names. No lists, no brand comparisons, no disclaimers.`;

    try {
        return await chatText(systemPrompt, `Describe usage for: ${query}`, 0.5);
    } catch (err) {
        console.error(`[Description] ${PROVIDER} Error:`, err.message);
        return null;
    }
}
