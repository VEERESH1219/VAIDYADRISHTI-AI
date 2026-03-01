/**
 * VAIDYADRISHTI AI — Unified LLM Adapter Service
 *
 * Supports four LLM providers out of the box:
 *   - openai    : GPT-4o (default)    — requires OPENAI_API_KEY
 *   - anthropic : Claude Sonnet 4.6   — requires ANTHROPIC_API_KEY
 *   - gemini    : Gemini 2.0 Flash    — requires GEMINI_API_KEY
 *   - ollama    : Local models (free) — requires Ollama running at OLLAMA_ENDPOINT
 *
 * Switch provider with MODEL_PROVIDER env var (see .env.example).
 * Vision OCR can use a separate provider via VISION_PROVIDER env var.
 * Ollama vision uses OLLAMA_VISION_MODEL (default: llava).
 *
 * NO-API-KEY SETUP: Set MODEL_PROVIDER=ollama and VISION_PROVIDER=ollama
 * to run entirely local with no paid API keys.
 *
 * Embeddings always use OpenAI; without OPENAI_API_KEY, Stage 3 vector
 * search is skipped gracefully and Stage 4 Ollama fallback is used instead.
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { Ollama } from 'ollama';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

// ── Provider Resolution ────────────────────────────────────────────────────
// Priority: MODEL_PROVIDER env var  >  USE_LOCAL_LLM legacy flag
//           >  auto-detect (no key = ollama)  >  openai
export function resolveProvider() {
    if (process.env.MODEL_PROVIDER) return process.env.MODEL_PROVIDER.toLowerCase();
    if (process.env.USE_LOCAL_LLM === 'true') return 'ollama';
    // Auto-detect: if no API key is configured for any cloud provider, use local Ollama
    const hasOpenAI    = !!process.env.OPENAI_API_KEY;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasGemini    = !!process.env.GEMINI_API_KEY;
    if (!hasOpenAI && !hasAnthropic && !hasGemini) return 'ollama';
    return 'openai';
}

export function resolveVisionProvider() {
    if (process.env.VISION_PROVIDER) return process.env.VISION_PROVIDER.toLowerCase();
    const p = resolveProvider();
    // Ollama, Anthropic, and Gemini support vision; everything else falls back to openai
    return ['anthropic', 'gemini', 'ollama'].includes(p) ? p : 'openai';
}

export const PROVIDER = resolveProvider();
export const VISION_PROVIDER = resolveVisionProvider();

// ── Chat Model Names ───────────────────────────────────────────────────────
const CHAT_MODELS = {
    openai:    process.env.OPENAI_MODEL    || 'gpt-4o',
    anthropic: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    ollama:    process.env.OLLAMA_MODEL    || process.env.LLM_MODEL_NAME || 'llama3.2',
    gemini:    process.env.GEMINI_MODEL    || 'gemini-2.0-flash',
};

const VISION_MODELS = {
    openai:    'gpt-4o',
    anthropic: process.env.ANTHROPIC_MODEL     || 'claude-sonnet-4-6',
    gemini:    process.env.GEMINI_MODEL        || 'gemini-2.0-flash',
    ollama:    process.env.OLLAMA_VISION_MODEL || process.env.OLLAMA_MODEL || 'llava',
};

export const CHAT_MODEL   = CHAT_MODELS[PROVIDER]       || 'gpt-4o';
export const VISION_MODEL = VISION_MODELS[VISION_PROVIDER] || 'gpt-4o';

// ── Lazy Client Factory ────────────────────────────────────────────────────
// Clients are created on first call so a missing API key only errors when
// that provider is actually used, not at server startup.
let _openai, _anthropic, _ollama, _gemini;

function openaiClient() {
    if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _openai;
}
function anthropicClient() {
    if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _anthropic;
}
function ollamaClient() {
    if (!_ollama) _ollama = new Ollama({ host: process.env.OLLAMA_ENDPOINT || 'http://127.0.0.1:11434' });
    return _ollama;
}
function geminiAI() {
    if (!_gemini) _gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    return _gemini;
}

// ── Ollama connection error helper ────────────────────────────────────────
// Wraps any Ollama API call and translates ECONNREFUSED into a clear message.
async function ollamaCall(fn) {
    try {
        return await fn();
    } catch (err) {
        const msg = String(err?.cause?.message || err?.message || '');
        const code = err?.cause?.code || err?.code || '';
        if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
            throw new Error(
                'Ollama is not running. Please start it and retry:\n' +
                '  1. Install Ollama: https://ollama.com/download\n' +
                '  2. Start the server: ollama serve\n' +
                '  3. Pull the models:  ollama pull llama3.2  &&  ollama pull llava'
            );
        }
        throw err;
    }
}

// ── JSON extraction helper ─────────────────────────────────────────────────
// Robustly pulls a JSON object out of a string that may contain prose around it.
function extractJSON(text) {
    try { return JSON.parse(text); } catch { /* fall through */ }
    // Strip markdown code fences
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ } }
    // Grab the outermost { … } block
    const block = text.match(/(\{[\s\S]*\})/);
    if (block) { try { return JSON.parse(block[1]); } catch { /* fall through */ } }
    return {};
}

// ── chatJSON ───────────────────────────────────────────────────────────────
/**
 * Send a chat prompt and parse the response as JSON.
 * Used by NLP extraction (medicine entities) and AI verification (Stage 4).
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} [temperature=0]
 * @returns {Promise<object>} parsed JSON object
 */
export async function chatJSON(systemPrompt, userPrompt, temperature = 0) {

    // ── Anthropic ──────────────────────────────────────────────────────────
    if (PROVIDER === 'anthropic') {
        const jsonHint = '\n\nRESPONSE FORMAT: Output ONLY valid JSON. No markdown, no explanation, no code blocks.';
        const response = await anthropicClient().messages.create({
            model:      CHAT_MODEL,
            max_tokens: 2048,
            temperature,
            system:     systemPrompt + jsonHint,
            messages:   [{ role: 'user', content: userPrompt }],
        });
        return extractJSON(response.content[0]?.text || '{}');
    }

    // ── Ollama ─────────────────────────────────────────────────────────────
    if (PROVIDER === 'ollama') {
        const response = await ollamaCall(() => ollamaClient().chat({
            model:    CHAT_MODEL,
            options:  { temperature },
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt   },
            ],
        }));
        return extractJSON(response.message?.content || '{}');
    }

    // ── Gemini ─────────────────────────────────────────────────────────────
    if (PROVIDER === 'gemini') {
        const model = geminiAI().getGenerativeModel({
            model: CHAT_MODEL,
            generationConfig: { responseMimeType: 'application/json', temperature },
        });
        const result = await model.generateContent(`${systemPrompt}\n\n${userPrompt}`);
        return extractJSON(result.response.text());
    }

    // ── OpenAI (default) ───────────────────────────────────────────────────
    const response = await openaiClient().chat.completions.create({
        model:           CHAT_MODEL,
        temperature,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
        ],
    });
    return extractJSON(response.choices[0]?.message?.content || '{}');
}

// ── chatText ───────────────────────────────────────────────────────────────
/**
 * Send a chat prompt and return the plain-text reply.
 * Used for short medicine descriptions (≤ 20 words).
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} [temperature=0.5]
 * @returns {Promise<string|null>}
 */
export async function chatText(systemPrompt, userPrompt, temperature = 0.5) {

    // ── Anthropic ──────────────────────────────────────────────────────────
    if (PROVIDER === 'anthropic') {
        const response = await anthropicClient().messages.create({
            model:      CHAT_MODEL,
            max_tokens: 256,
            temperature,
            system:     systemPrompt,
            messages:   [{ role: 'user', content: userPrompt }],
        });
        return response.content[0]?.text?.trim().replace(/^"|"$/g, '') || null;
    }

    // ── Ollama ─────────────────────────────────────────────────────────────
    if (PROVIDER === 'ollama') {
        const response = await ollamaCall(() => ollamaClient().chat({
            model:    CHAT_MODEL,
            options:  { temperature },
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt   },
            ],
        }));
        return response.message?.content?.trim().replace(/^"|"$/g, '') || null;
    }

    // ── Gemini ─────────────────────────────────────────────────────────────
    if (PROVIDER === 'gemini') {
        const model = geminiAI().getGenerativeModel({
            model: CHAT_MODEL,
            generationConfig: { temperature },
        });
        const result = await model.generateContent(`${systemPrompt}\n\n${userPrompt}`);
        return result.response.text()?.trim().replace(/^"|"$/g, '') || null;
    }

    // ── OpenAI (default) ───────────────────────────────────────────────────
    const response = await openaiClient().chat.completions.create({
        model:       CHAT_MODEL,
        temperature,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
        ],
    });
    return response.choices[0]?.message?.content?.trim().replace(/^"|"$/g, '') || null;
}

// ── visionOCR ──────────────────────────────────────────────────────────────
/**
 * Extract text from an image using a vision-capable LLM.
 * Provider is selected by VISION_PROVIDER (defaults to openai).
 *
 * @param {string} base64DataUri  Full data URI — data:image/jpeg;base64,…
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string>} transcribed text
 */
export async function visionOCR(base64DataUri, systemPrompt, userPrompt) {

    // Parse data URI → mediaType + raw base64 data
    const match     = base64DataUri.match(/^data:(image\/[\w+]+);base64,(.+)$/s);
    const rawMime   = match?.[1] || 'image/jpeg';
    const base64Raw = match?.[2] || base64DataUri;
    // Anthropic only accepts these media types
    const anthropicMime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;

    // ── Anthropic Vision ───────────────────────────────────────────────────
    if (VISION_PROVIDER === 'anthropic') {
        console.log(`[OCR] Using Claude Vision (${VISION_MODEL}) as fallback…`);
        const response = await anthropicClient().messages.create({
            model:      VISION_MODEL,
            max_tokens: 2048,
            system:     systemPrompt,
            messages: [{
                role:    'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: anthropicMime, data: base64Raw } },
                    { type: 'text',  text: userPrompt },
                ],
            }],
        });
        const text = response.content[0]?.text?.trim() || '';
        console.log('[OCR] Claude Vision result:\n', text);
        return text;
    }

    // ── Gemini Vision ──────────────────────────────────────────────────────
    if (VISION_PROVIDER === 'gemini') {
        console.log(`[OCR] Using Gemini Vision (${VISION_MODEL}) as fallback…`);
        const model  = geminiAI().getGenerativeModel({ model: VISION_MODEL });
        const result = await model.generateContent([
            { text: `${systemPrompt}\n\n${userPrompt}` },
            { inlineData: { mimeType: rawMime, data: base64Raw } },
        ]);
        const text = result.response.text()?.trim() || '';
        console.log('[OCR] Gemini Vision result:\n', text);
        return text;
    }

    // ── Ollama Vision (local, no API key required) ─────────────────────────
    if (VISION_PROVIDER === 'ollama') {
        console.log(`[OCR] Using Ollama Vision (${VISION_MODEL}) as fallback…`);
        const response = await ollamaCall(() => ollamaClient().chat({
            model:    VISION_MODEL,
            messages: [{
                role:    'user',
                content: `${systemPrompt}\n\n${userPrompt}`,
                images:  [base64Raw],
            }],
        }));
        const text = response.message?.content?.trim() || '';
        console.log('[OCR] Ollama Vision result:\n', text);
        return text;
    }

    // ── OpenAI GPT-4o Vision (default) ────────────────────────────────────
    console.log('[OCR] Using GPT-4o Vision as fallback for handwritten text…');
    const response = await openaiClient().chat.completions.create({
        model:      'gpt-4o',
        temperature: 0.1,
        max_tokens:  2048,
        messages: [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: [
                    { type: 'text',      text: userPrompt },
                    { type: 'image_url', image_url: { url: base64DataUri, detail: 'high' } },
                ],
            },
        ],
    });
    const text = response.choices[0]?.message?.content?.trim() || '';
    console.log('[OCR] GPT-4o Vision full result:\n', text);
    return text;
}

// ── Provider info (for health checks and logs) ─────────────────────────────
export function getLLMInfo() {
    return {
        chat_provider:   PROVIDER,
        chat_model:      CHAT_MODEL,
        vision_provider: VISION_PROVIDER,
        vision_model:    VISION_MODEL,
    };
}
