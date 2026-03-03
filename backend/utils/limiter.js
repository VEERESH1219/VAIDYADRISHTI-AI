/**
 * VAIDYADRISHTI AI — Global LLM Concurrency Limiter
 *
 * Prevents Ollama queue overload under concurrent users.
 * Ollama is effectively single-request serialized,
 * so we limit to 1 when MODEL_PROVIDER=ollama.
 */

import pLimit from 'p-limit';
import { loadEnv } from '../config/env.js';

loadEnv();

const provider = process.env.MODEL_PROVIDER;

// For local Ollama → strict single concurrency
// For cloud providers → allow small parallelism
const concurrency = provider === 'ollama' ? 1 : Number(process.env.LLM_CONCURRENCY || 4);

export const llmLimit = pLimit(concurrency);
