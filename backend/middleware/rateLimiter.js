import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getRedisClient } from '../config/redis.js';
import { logger } from '../utils/logger.js';

const WINDOW_SECONDS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS);
const PUBLIC_MAX_REQUESTS = Number(process.env.RATE_LIMIT_PUBLIC_MAX);
const TENANT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_TENANT_MAX);
const RATE_LIMIT_TIMEOUT_MS = Number(process.env.RATE_LIMIT_TIMEOUT_MS || 800);

const redisClient = getRedisClient();

const publicLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:public',
    points: PUBLIC_MAX_REQUESTS,
    duration: WINDOW_SECONDS,
});

const tenantLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:tenant',
    points: TENANT_MAX_REQUESTS,
    duration: WINDOW_SECONDS,
});

function getClientIp(req) {
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
        return xForwardedFor.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

export async function redisRateLimiter(req, res, next) {
    if (req.path === '/health' || req.path === '/health/live' || req.path === '/health/ready') {
        return next();
    }

    const tenantId = req.tenantId || req.user?.tenantId;
    const limiter = tenantId ? tenantLimiter : publicLimiter;
    const key = tenantId || getClientIp(req);

    try {
        await Promise.race([
            limiter.consume(key, 1),
            new Promise((_, reject) => setTimeout(() => reject(new Error('rate_limiter_timeout')), RATE_LIMIT_TIMEOUT_MS)),
        ]);
        return next();
    } catch (rateErr) {
        if (typeof rateErr?.msBeforeNext !== 'number') {
            logger.error({ err: rateErr?.message }, 'rate_limiter_unavailable_fail_open');
            return next();
        }

        const retryAfter = Math.max(1, Math.ceil((rateErr?.msBeforeNext || 1000) / 1000));
        res.set('Retry-After', String(retryAfter));

        return res.status(429).json({
            success: false,
            requestId: req.requestId,
            message: 'Too many requests. Please try again later.',
        });
    }
}
