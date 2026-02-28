/**
 * VAIDYADRISHTI AI — Express Server Entry Point
 *
 * CORS-enabled Express server with JSON body parsing (25MB limit),
 * health check endpoint, and prescription processing route.
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import prescriptionRouter from './routes/prescription.js';
import { getLLMInfo } from './services/llmService.js';

// Always load .env from the same directory as server.js (backend/)
// regardless of where `node` was invoked from.
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

// ── Global Sanitization ──────────────────────────
// Clean environment variables at startup (removes hidden Unicode)
Object.keys(process.env).forEach(key => {
    if (typeof process.env[key] === 'string') {
        process.env[key] = process.env[key].replace(/[^\x20-\x7E]/g, '').trim();
    }
});

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ─────────────────────────────────────
// Enhanced Request Logging
app.use((req, res, next) => {
    const origin = (req.headers.origin || '').replace(/[^\x20-\x7E]/g, '');
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} | Origin: ${origin}`);
    next();
});

// Hyper-Robust CORS Configuration
const corsOptions = {
    origin: (origin, callback) => {
        // Echo back any origin, but ensures we call back with true
        callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
    credentials: true,
    maxAge: 86400
};

app.use(cors(corsOptions));

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ── Health Check ──────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.4',
        llm: getLLMInfo(),
        env: {
            frontend_url: process.env.FRONTEND_URL ? 'set' : 'not set',
            supabase_url:  process.env.SUPABASE_URL  ? 'set' : 'not set',
            openai_key:    process.env.OPENAI_API_KEY    ? 'set' : 'not set',
            anthropic_key: process.env.ANTHROPIC_API_KEY ? 'set' : 'not set',
            gemini_key:    process.env.GEMINI_API_KEY    ? 'set' : 'not set',
        }
    });
});

// ── Routes ────────────────────────────────────────
app.use('/api', prescriptionRouter);

// ── 404 Handler ───────────────────────────────────
app.use((req, res) => {
    const origin = (req.headers.origin || '').replace(/[^\x20-\x7E]/g, '');
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    console.warn(`[404] ${req.method} ${req.path}`);
    res.status(404).json({
        status: 'error',
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.path} not found.`,
    });
});

// ── Global Error Handler ──────────────────────────
app.use((err, req, res, next) => {
    console.error('[Server Error Handled]:', err);

    const origin = (req.headers.origin || '').replace(/[^\x20-\x7E]/g, '');
    res.setHeader('Access-Control-Allow-Origin', origin || 'https://vaidyadrishti-ai.vercel.app');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    res.status(500).json({
        status: 'error',
        code: 'SERVER_ERROR',
        message: err.message || 'Internal server error.',
    });
});

// ── Start Server ──────────────────────────────────
app.listen(PORT, () => {
    const llm = getLLMInfo();
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║  🧬 VAIDYADRISHTI AI Server v1.0.4        ║`);
    console.log(`  ║  Port   : ${PORT}                            ║`);
    console.log(`  ║  LLM    : ${llm.chat_provider} / ${llm.chat_model.padEnd(18)} ║`);
    console.log(`  ║  Vision : ${llm.vision_provider} / ${llm.vision_model.padEnd(15)} ║`);
    console.log(`  ║  Status : LIVE & HEALTHY                  ║`);
    console.log(`  ╚══════════════════════════════════════════╝\n`);
});
