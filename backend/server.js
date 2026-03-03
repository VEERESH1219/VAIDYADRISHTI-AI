import express from 'express';
import cors from 'cors';
import { loadEnv } from './config/env.js';
import { validateEnvOrThrow } from './config/validateEnv.js';

import prescriptionRouter from './routes/prescription.js';
import adminTenantRouter from './routes/admin/tenant.js';
import adminResetTenantUsageRouter from './routes/admin/resetTenantUsage.js';
import tenantUsageRouter from './routes/tenant/usage.js';
import { requireAuth } from './middleware/authMiddleware.js';
import { attachRequestContext } from './middleware/requestContext.js';
import { redisRateLimiter } from './middleware/rateLimiter.js';
import { httpMetricsMiddleware } from './middleware/httpMetrics.js';

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
import { startResourceMonitor } from './observability/resourceMonitor.js';
import { logger, getLogLevel } from './utils/logger.js';

loadEnv();
validateEnvOrThrow({ role: 'api' });

Object.keys(process.env).forEach((key) => {
    if (typeof process.env[key] === 'string') {
        process.env[key] = process.env[key].replace(/[^\x20-\x7E]/g, '').trim();
    }
});

const app = express();
const PORT = Number(process.env.PORT);
const GLOBAL_REQUEST_TIMEOUT_MS = Number(process.env.GLOBAL_REQUEST_TIMEOUT_MS);
const stopResourceMonitor = startResourceMonitor({ role: 'api' });

function sanitizeHeaderValue(value) {
    return (value || '').replace(/[^\x20-\x7E]/g, '');
}

app.set('trust proxy', true);

app.use(attachRequestContext);
app.use(httpMetricsMiddleware);

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

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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
        return res.status(200).send(metrics);
    } catch (err) {
        return next(err);
    }
});

app.use('/admin', redisRateLimiter, adminTenantRouter);
app.use('/admin', redisRateLimiter, adminResetTenantUsageRouter);

app.use('/api', requireAuth, redisRateLimiter, async (req, res, next) => {
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
