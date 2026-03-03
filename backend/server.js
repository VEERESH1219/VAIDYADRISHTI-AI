import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

import prescriptionRouter from './routes/prescription.js';
import adminTenantRouter from './routes/admin/tenant.js';
import adminResetTenantUsageRouter from './routes/admin/resetTenantUsage.js';
import tenantUsageRouter from './routes/tenant/usage.js';
import { requireAuth } from './middleware/authMiddleware.js';

import { getLLMInfo } from './services/llmService.js';
import { hasPostgres, pingDb, getMedicineCount, getTenantDailyLimit, getTenantTodayUsage } from './services/pgService.js';
import { logger, getLogLevel } from './utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

Object.keys(process.env).forEach((key) => {
    if (typeof process.env[key] === 'string') {
        process.env[key] = process.env[key].replace(/[^\x20-\x7E]/g, '').trim();
    }
});

const app = express();
const PORT = process.env.PORT || 3001;

const GLOBAL_REQUEST_TIMEOUT_MS = 45_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 120);
const rateLimitStore = new Map();

function sanitizeHeaderValue(value) {
    return (value || '').replace(/[^\x20-\x7E]/g, '');
}

function getClientIp(req) {
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
        return xForwardedFor.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

// ─────────────────────────────────────────────
// Request ID + Structured Logging
// ─────────────────────────────────────────────
app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);

    const startedAt = Date.now();
    res.on('finish', () => {
        logger.info(JSON.stringify({
            requestId: req.requestId,
            method: req.method,
            path: req.originalUrl || req.url,
            status: res.statusCode,
            durationMs: Date.now() - startedAt,
        }));
    });

    next();
});

// ─────────────────────────────────────────────
// Global Timeout (45s)
// ─────────────────────────────────────────────
app.use((req, res, next) => {
    const timeoutHandle = setTimeout(() => {
        if (res.headersSent || res.writableEnded) return;

        const timeoutError = new Error(`Request timed out after ${GLOBAL_REQUEST_TIMEOUT_MS / 1000}s`);
        timeoutError.statusCode = 504;
        next(timeoutError);
    }, GLOBAL_REQUEST_TIMEOUT_MS);

    res.on('finish', () => clearTimeout(timeoutHandle));
    res.on('close', () => clearTimeout(timeoutHandle));

    next();
});

// ─────────────────────────────────────────────
// In-Memory Rate Limiter
// ─────────────────────────────────────────────
app.use((req, res, next) => {
    if (req.path === '/health') return next();

    const now = Date.now();
    const tenantId = req.tenantId || req.user?.tenantId || null;
    const key = tenantId ? `tenant:${tenantId}` : `ip:${getClientIp(req)}`;
    const windowStart = now - RATE_LIMIT_WINDOW_MS;

    const history = rateLimitStore.get(key) || [];
    const recent = history.filter(ts => ts > windowStart);

    if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
        return res.status(429).json({
            success: false,
            requestId: req.requestId,
            message: 'Too many requests. Please try again later.',
        });
    }

    recent.push(now);
    rateLimitStore.set(key, recent);
    next();
});

// ─────────────────────────────────────────────
// CORS + Body Parsing
// ─────────────────────────────────────────────
app.use(cors({
    origin: (origin, callback) => callback(null, true),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'X-Request-Id', 'X-Master-Key'],
    credentials: true,
    maxAge: 86400,
}));

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ─────────────────────────────────────────────
// Public Health Route
// ─────────────────────────────────────────────
app.get('/health', async (req, res, next) => {
    try {
        const dbOnline = hasPostgres() ? await pingDb().catch(() => false) : false;
        const medicineCount = dbOnline ? await getMedicineCount().catch(() => 0) : 0;

        return res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            version: '1.0.4',
            llm: getLLMInfo(),
            database: {
                type: 'PostgreSQL 16 (local)',
                status: dbOnline ? 'connected' : 'disconnected',
                medicines: medicineCount.toLocaleString(),
            },
            requestId: req.requestId,
        });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────
// Admin Tenant Route (Master Key Protected)
// ─────────────────────────────────────────────
app.use('/admin', adminTenantRouter);
app.use('/admin', adminResetTenantUsageRouter);

// ─────────────────────────────────────────────
// Protected API Routes (JWT Required)
// ─────────────────────────────────────────────
app.use('/api', requireAuth, async (req, res, next) => {
    const tenantId = req.tenantId;
    if (!tenantId || !hasPostgres()) return next();

    try {
        const tenantDailyLimit = await getTenantDailyLimit(tenantId);
        if (tenantDailyLimit <= 0) return next();

        const usage = await getTenantTodayUsage(tenantId);
        if (usage.total_requests >= tenantDailyLimit) {
            return res.status(429).json({
                success: false,
                requestId: req.requestId,
                message: 'Tenant daily quota exceeded.',
            });
        }

        return next();
    } catch (err) {
        err.statusCode = err.statusCode || 500;
        return next(err);
    }
});

app.use('/api', requireAuth, prescriptionRouter);
app.use('/api', requireAuth, tenantUsageRouter);

// ─────────────────────────────────────────────
// 404 Handler
// ─────────────────────────────────────────────
app.use((req, res) => {
    const origin = sanitizeHeaderValue(req.headers.origin);
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    return res.status(404).json({
        success: false,
        requestId: req.requestId,
        message: `Route ${req.method} ${req.path} not found.`,
    });
});

// ─────────────────────────────────────────────
// Central Error Handler
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    logger.error('[server.error]', {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: err?.statusCode || err?.status || 500,
        message: err?.message,
        stack: err?.stack,
    });

    const statusCode = Number(err?.statusCode || err?.status || 500);
    const safeMessage = statusCode >= 500
        ? 'Internal server error.'
        : (err?.message || 'Request failed.');

    const origin = sanitizeHeaderValue(req.headers.origin);
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    return res.status(statusCode).json({
        success: false,
        requestId: req.requestId,
        message: safeMessage,
    });
});

process.on('uncaughtException', (err) => {
    logger.error('[Server] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
    logger.error('[Server] Unhandled rejection:', reason);
});

app.listen(PORT, () => {
    const llm = getLLMInfo();
    logger.info(`[Server] Port ${PORT} | Chat ${llm.chat_provider}/${llm.chat_model} | Vision ${llm.vision_provider}/${llm.vision_model} | LOG_LEVEL ${getLogLevel()}`);
});
