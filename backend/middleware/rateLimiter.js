import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getRedisClient } from '../config/redis.js';
import { logger } from '../utils/logger.js';

// ── Configuration (with safe defaults to avoid NaN) ──────────────────────
const WINDOW_SECONDS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60);
const PUBLIC_MAX_REQUESTS = Number(process.env.RATE_LIMIT_PUBLIC_MAX || 120);
const TENANT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_TENANT_MAX || 300);
const IP_MAX_REQUESTS = Number(process.env.RATE_LIMIT_IP_MAX || PUBLIC_MAX_REQUESTS || 120);
const AUTH_MAX_REQUESTS = Number(process.env.RATE_LIMIT_AUTH_MAX || 20);
const AUTH_FAIL_MAX_REQUESTS = Number(process.env.RATE_LIMIT_AUTH_FAIL_MAX || 10);
const RATE_LIMIT_TIMEOUT_MS = Number(process.env.RATE_LIMIT_TIMEOUT_MS || 800);

// ── Lazy-initialized rate limiters ──────────────────────────────────────
// Previously these were created eagerly at module load which called
// getRedisClient() before env vars were loaded — causing NaN config and
// premature Redis connection attempts.
let _ipLimiter, _publicLimiter, _tenantLimiter, _authLimiter, _authFailureLimiter;

function getIpLimiter() {
    if (!_ipLimiter) {
        _ipLimiter = new RateLimiterRedis({
            storeClient: getRedisClient(),
            keyPrefix: 'rl:ip',
            points: IP_MAX_REQUESTS,
            duration: WINDOW_SECONDS,
        });
    }
    return _ipLimiter;
}

function getPublicLimiter() {
    if (!_publicLimiter) {
        _publicLimiter = new RateLimiterRedis({
            storeClient: getRedisClient(),
            keyPrefix: 'rl:public',
            points: PUBLIC_MAX_REQUESTS,
            duration: WINDOW_SECONDS,
        });
    }
    return _publicLimiter;
}

function getTenantLimiter() {
    if (!_tenantLimiter) {
        _tenantLimiter = new RateLimiterRedis({
            storeClient: getRedisClient(),
            keyPrefix: 'rl:tenant',
            points: TENANT_MAX_REQUESTS,
            duration: WINDOW_SECONDS,
        });
    }
    return _tenantLimiter;
}

function getAuthLimiter() {
    if (!_authLimiter) {
        _authLimiter = new RateLimiterRedis({
            storeClient: getRedisClient(),
            keyPrefix: 'rl:auth',
            points: AUTH_MAX_REQUESTS,
            duration: WINDOW_SECONDS,
        });
    }
    return _authLimiter;
}

function getAuthFailureLimiter() {
    if (!_authFailureLimiter) {
        _authFailureLimiter = new RateLimiterRedis({
            storeClient: getRedisClient(),
            keyPrefix: 'rl:authfail',
            points: AUTH_FAIL_MAX_REQUESTS,
            duration: WINDOW_SECONDS,
        });
    }
    return _authFailureLimiter;
}

function getClientIp(req) {
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
        return xForwardedFor.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

async function consumeOrFailOpen(limiter, key) {
    return Promise.race([
        limiter.consume(key, 1),
        new Promise((_, reject) => setTimeout(() => reject(new Error('rate_limiter_timeout')), RATE_LIMIT_TIMEOUT_MS)),
    ]);
}

function tooManyRequests(res, requestId, msBeforeNext) {
    const retryAfter = Math.max(1, Math.ceil((msBeforeNext || 1000) / 1000));
    res.set('Retry-After', String(retryAfter));

    return res.status(429).json({
        success: false,
        requestId,
        message: 'Too many requests. Please try again later.',
    });
}

export async function redisRateLimiter(req, res, next) {
    if (req.path === '/health' || req.path === '/health/live' || req.path === '/health/ready' || req.path === '/metrics') {
        return next();
    }

    const ip = getClientIp(req);
    const tenantId = req.tenantId || req.user?.tenantId;

    try {
        await consumeOrFailOpen(getIpLimiter(), ip);

        if (tenantId) {
            await consumeOrFailOpen(getTenantLimiter(), tenantId);
        } else {
            await consumeOrFailOpen(getPublicLimiter(), ip);
        }

        return next();
    } catch (rateErr) {
        if (typeof rateErr?.msBeforeNext !== 'number') {
            logger.error({ err: rateErr?.message }, 'rate_limiter_unavailable_fail_open');
            return next();
        }
        return tooManyRequests(res, req.requestId, rateErr?.msBeforeNext);
    }
}

export async function authRateLimiter(req, res, next) {
    const ip = getClientIp(req);

    try {
        await consumeOrFailOpen(getAuthLimiter(), ip);
        return next();
    } catch (rateErr) {
        if (typeof rateErr?.msBeforeNext !== 'number') {
            logger.error({ err: rateErr?.message }, 'auth_rate_limiter_unavailable_fail_open');
            return next();
        }
        return tooManyRequests(res, req.requestId, rateErr?.msBeforeNext);
    }
}

export async function consumeAuthFailure(req, scope = 'auth') {
    const ip = getClientIp(req);
    const key = `${scope}:${ip}`;

    try {
        await consumeOrFailOpen(getAuthFailureLimiter(), key);
        return { blocked: false, retryAfterSeconds: 0 };
    } catch (rateErr) {
        if (typeof rateErr?.msBeforeNext !== 'number') {
            logger.error({ err: rateErr?.message }, 'auth_failure_limiter_unavailable_fail_open');
            return { blocked: false, retryAfterSeconds: 0 };
        }

        return {
            blocked: true,
            retryAfterSeconds: Math.max(1, Math.ceil((rateErr?.msBeforeNext || 1000) / 1000)),
        };
    }
}

export async function clearAuthFailures(req, scope = 'auth') {
    const ip = getClientIp(req);
    const key = `${scope}:${ip}`;
    try {
        await getAuthFailureLimiter().delete(key);
    } catch {
        // Non-critical cleanup.
    }
}
