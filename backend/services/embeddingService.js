/**
 * MedMap AI — Embedding Service
 *
 * Generates text embeddings using OpenAI text-embedding-3-small (1536 dim).
 * Includes retry logic with exponential backoff.
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

// Lazy client — avoids crash at startup when OPENAI_API_KEY is not yet set
let _openai;
function openaiClient() {
    if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _openai;
}

/**
 * Generate a 1536-dimension embedding for the given text.
 *
 * @param {string} text — input text to embed
 * @returns {Promise<number[]>} — float array of length 1536
 */
export async function getEmbedding(text) {
    if (!text || text.trim().length === 0) {
        throw new Error('Cannot generate embedding for empty text.');
    }

    // Skip immediately if no API key — Stage 3 vector search will be bypassed
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY not set — vector search unavailable. Falling back to Stage 4.');
    }

    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await openaiClient().embeddings.create({
                model: 'text-embedding-3-small',
                input: text.trim(),
            });

            const embedding = response.data[0]?.embedding;

            if (!embedding || embedding.length !== 1536) {
                throw new Error(`Invalid embedding dimension: expected 1536, got ${embedding?.length}`);
            }

            return embedding;
        } catch (err) {
            lastError = err;
            console.warn(`[Embedding] Attempt ${attempt}/${maxRetries} failed:`, err.message);

            if (attempt < maxRetries) {
                // Exponential backoff: 1s, 2s, 4s
                const delay = Math.pow(2, attempt - 1) * 1000;
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    throw new Error(`Embedding generation failed after ${maxRetries} retries: ${lastError?.message}`);
}

/**
 * Generate a zero vector (1536 dimensions) — used for trigram-only search.
 *
 * @returns {number[]}
 */
export function getZeroVector() {
    return new Array(1536).fill(0);
}
