import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './config/env.js';
import { validateEnvOrThrow } from './config/validateEnv.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import prescriptionRouter from './routes/prescription.js';
import adminTenantRouter from './routes/admin/tenant.js';
import adminResetTenantUsageRouter from './routes/admin/resetTenantUsage.js';
import tenantUsageRouter from './routes/tenant/usage.js';
import { requireAuth } from './middleware/authMiddleware.js';
import { attachRequestContext } from './middleware/requestContext.js';
import { authRateLimiter, redisRateLimiter } from './middleware/rateLimiter.js';
import { httpMetricsMiddleware } from './middleware/httpMetrics.js';
import { blockPrototypePollution } from './middleware/validation.js';
import { enforceTenantIsolation } from './middleware/tenantIsolation.js';

import { getLLMInfo } from './services/llmService.js';
import {
    hasPostgres,
    pingDbDetailed,
    getMedicineCount,
    getTenantDailyLimit,
    getTenantTodayUsage,
    closePool,
} from './services/pgService.js';
import { pingRedisDetailed, closeRedisClient } from './config/redis.js';
import { closePrescriptionQueue, getPrescriptionQueueState } from './jobs/prescriptionQueue.js';
import { getMetricsContentType, getMetricsSnapshot } from './observability/metrics.js';
import { captureError, flushErrorTracker, initErrorTracker } from './observability/errorTracker.js';
import { startResourceMonitor } from './observability/resourceMonitor.js';
import { logger, getLogLevel } from './utils/logger.js';

loadEnv();
validateEnvOrThrow({ role: 'api' });
await initErrorTracker({ service: 'api' });

Object.keys(process.env).forEach((key) => {
    if (typeof process.env[key] === 'string') {
        process.env[key] = process.env[key].replace(/[^\x20-\x7E]/g, '').trim();
    }
});

const app = express();
const PORT = Number(process.env.PORT);
const GLOBAL_REQUEST_TIMEOUT_MS = Number(process.env.GLOBAL_REQUEST_TIMEOUT_MS);
const COMPRESSION_THRESHOLD_BYTES = Number(process.env.COMPRESSION_THRESHOLD_BYTES || 1024);
const REQUEST_BODY_LIMIT_BYTES = Number(process.env.REQUEST_BODY_LIMIT_BYTES || 25 * 1024 * 1024);
const URLENCODED_BODY_LIMIT_BYTES = Number(process.env.URLENCODED_BODY_LIMIT_BYTES || 25 * 1024 * 1024);
const stopResourceMonitor = startResourceMonitor({ role: 'api' });

function sanitizeHeaderValue(value) {
    return (value || '').replace(/[^\x20-\x7E]/g, '');
}

app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(attachRequestContext);
app.use(httpMetricsMiddleware);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'none'"],
            baseUri: ["'none'"],
            frameAncestors: ["'none'"],
            formAction: ["'none'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
            // Allow Google Fonts stylesheets and self-hosted styles
            styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
            // Allow Google Fonts font files and self-hosted fonts
            fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
            scriptSrc: ["'self'"],
            // Allow same-origin XHR/fetch for API calls + blob: for workers
            connectSrc: ["'self'", 'blob:'],
            workerSrc: ["'self'", 'blob:'],
        },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
}));

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

app.use(cors({
    origin: (origin, callback) => callback(null, true),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'X-Request-Id', 'X-Master-Key'],
    credentials: true,
    maxAge: 86400,
}));

app.use(compression({
    threshold: COMPRESSION_THRESHOLD_BYTES,
    filter: (req, res) => {
        if (req.path === '/metrics') return false;
        const cacheControl = req.headers['cache-control'];
        if (typeof cacheControl === 'string' && cacheControl.includes('no-transform')) {
            return false;
        }
        return compression.filter(req, res);
    },
}));

app.use(express.json({
    strict: true,
    limit: `${REQUEST_BODY_LIMIT_BYTES}b`,
    type: ['application/json', 'application/*+json'],
}));
app.use(express.urlencoded({
    extended: false,
    limit: `${URLENCODED_BODY_LIMIT_BYTES}b`,
    parameterLimit: 50,
}));
app.use(blockPrototypePollution);

app.get('/health/live', (req, res) => {
    return res.json({
        status: 'ok',
        check: 'liveness',
        timestamp: new Date().toISOString(),
        requestId: req.requestId,
    });
});

app.get('/health/ready', async (req, res) => {
    const dbProbe = hasPostgres()
        ? await pingDbDetailed().catch(() => ({ ok: false, latencyMs: null }))
        : { ok: false, latencyMs: null };
    const redisProbe = await pingRedisDetailed().catch(() => ({ ok: false, latencyMs: null }));
    const queueState = getPrescriptionQueueState();
    const ready = dbProbe.ok && redisProbe.ok;

    return res.status(ready ? 200 : 503).json({
        status: ready ? 'ok' : 'degraded',
        check: 'readiness',
        database: {
            status: dbProbe.ok ? 'connected' : 'disconnected',
            latency_ms: dbProbe.latencyMs == null ? null : Number(dbProbe.latencyMs.toFixed(2)),
        },
        redis: {
            status: redisProbe.ok ? 'connected' : 'disconnected',
            latency_ms: redisProbe.latencyMs == null ? null : Number(redisProbe.latencyMs.toFixed(2)),
        },
        queue: queueState,
        timestamp: new Date().toISOString(),
        requestId: req.requestId,
    });
});

app.get('/health', async (req, res, next) => {
    try {
        const dbProbe = hasPostgres()
            ? await pingDbDetailed().catch(() => ({ ok: false }))
            : { ok: false };
        const dbOnline = dbProbe.ok;
        const redisProbe = await pingRedisDetailed().catch(() => ({ ok: false }));
        const redisOnline = redisProbe.ok;
        const medicineCount = dbOnline ? await getMedicineCount().catch(() => 0) : 0;

        return res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            version: process.env.APP_VERSION || '1.1.0',
            llm: getLLMInfo(),
            database: {
                type: 'PostgreSQL 16',
                status: dbOnline ? 'connected' : 'disconnected',
                medicines: medicineCount.toLocaleString(),
            },
            redis: {
                status: redisOnline ? 'connected' : 'disconnected',
            },
            requestId: req.requestId,
        });
    } catch (err) {
        next(err);
    }
});

app.get('/metrics', async (req, res, next) => {
    try {
        const metrics = await getMetricsSnapshot();
        res.setHeader('Content-Type', getMetricsContentType());
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        return res.status(200).send(metrics);
    } catch (err) {
        return next(err);
    }
});

app.use('/admin', authRateLimiter, redisRateLimiter, adminTenantRouter);
app.use('/admin', authRateLimiter, redisRateLimiter, adminResetTenantUsageRouter);

app.use('/api', requireAuth, enforceTenantIsolation, redisRateLimiter, async (req, res, next) => {
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

app.use('/api', prescriptionRouter);
app.use('/api', tenantUsageRouter);

const frontendDistPath = path.join(__dirname, '../frontend/dist');
app.use(express.static(frontendDistPath));

app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/admin') || req.path.startsWith('/health') || req.path.startsWith('/metrics')) {
        return next();
    }
    res.sendFile(path.join(frontendDistPath, 'index.html'));
});

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

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const statusCode = Number(err?.statusCode || err?.status || 500);

    logger.error({
        requestId: req.requestId,
        method: req.method,
        path: req.path || req.originalUrl || req.url,
        statusCode,
        message: err?.message,
        stack: statusCode >= 500 ? err?.stack : undefined,
    }, 'server_error');
    if (statusCode >= 500) {
        captureError(err, {
            requestId: req.requestId,
            method: req.method,
            path: req.path || req.originalUrl || req.url,
            statusCode,
        });
    }

    const safeMessage = statusCode >= 500
        ? 'Internal server error.'
        : (err?.message || 'Request failed.');

    const origin = sanitizeHeaderValue(req.headers.origin);
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    return res.status(statusCode).json({
        success: false,
        error: safeMessage,
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : (err?.code || 'REQUEST_ERROR'),
        requestId: req.requestId,
        message: safeMessage,
    });
});

const server = app.listen(PORT, () => {
    const llm = getLLMInfo();
    logger.info({
        port: PORT,
        chat: `${llm.chat_provider}/${llm.chat_model}`,
        vision: `${llm.vision_provider}/${llm.vision_model}`,
        logLevel: getLogLevel(),
    }, 'server_started');
});

let shuttingDown = false;

async function shutdown(signal, error = null) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.warn({ signal, error: error?.message }, 'server_shutdown_started');

    const closeHttp = new Promise((resolve) => server.close(resolve));
    const timeout = new Promise((resolve) => setTimeout(resolve, 10_000));
    await Promise.race([closeHttp, timeout]);

    await Promise.allSettled([
        closePrescriptionQueue(),
        closeRedisClient(),
        closePool(),
        flushErrorTracker(),
    ]);
    stopResourceMonitor();

    if (error) {
        logger.fatal({ err: error }, 'server_shutdown_due_to_fatal_error');
        process.exit(1);
    }

    logger.warn('server_shutdown_completed');
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => shutdown('uncaughtException', err));
process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    shutdown('unhandledRejection', err);
});
