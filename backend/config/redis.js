import IORedis from 'ioredis';
import { loadEnv } from './env.js';
import { logger } from '../utils/logger.js';
import { recordRedisLatency } from '../observability/metrics.js';

loadEnv();

const redisUrl = process.env.REDIS_URL;
const REDIS_CONNECT_TIMEOUT_MS = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 5_000);
const REDIS_RETRY_BASE_MS = Number(process.env.REDIS_RETRY_BASE_MS || 200);
const REDIS_RETRY_MAX_MS = Number(process.env.REDIS_RETRY_MAX_MS || 2_000);

let redisClient;
let lastErrorLogAt = 0;

export function getRedisClient() {
    if (!redisClient) {
        redisClient = new IORedis(redisUrl, {
            maxRetriesPerRequest: null,
            enableReadyCheck: true,
            enableAutoPipelining: true,
            enableOfflineQueue: false,
            connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
            keepAlive: 10_000,
            connectionName: process.env.SERVICE_NAME || 'vaidyadrishti-backend',
            retryStrategy(times) {
                const jitterMs = Math.floor(Math.random() * 100);
                return Math.min((times * REDIS_RETRY_BASE_MS) + jitterMs, REDIS_RETRY_MAX_MS);
            },
        });

        redisClient.on('error', (err) => {
            const now = Date.now();
            if (now - lastErrorLogAt >= 5_000) {
                lastErrorLogAt = now;
                logger.error({ err: err.message }, '[Redis] connection error');
            }
        });
    }

    return redisClient;
}

export async function pingRedis() {
    const details = await pingRedisDetailed();
    return details.ok;
}

export async function pingRedisDetailed() {
    const startedAt = process.hrtime.bigint();
    try {
        const result = await Promise.race([
            getRedisClient().ping(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('redis_ping_timeout')), 1500)),
        ]);
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const ok = result === 'PONG';
        recordRedisLatency({ operation: 'ping', durationMs, success: ok });
        return { ok, latencyMs: durationMs };
    } catch (err) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        recordRedisLatency({ operation: 'ping', durationMs, success: false });
        return { ok: false, latencyMs: durationMs, error: err?.message };
    }
}

export async function closeRedisClient() {
    if (!redisClient) return;
    try {
        await redisClient.quit();
    } catch {
        redisClient.disconnect();
    } finally {
        redisClient = null;
    }
}
