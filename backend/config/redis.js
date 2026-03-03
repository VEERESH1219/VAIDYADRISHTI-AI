import IORedis from 'ioredis';
import { loadEnv } from './env.js';
import { logger } from '../utils/logger.js';

loadEnv();

const redisUrl = process.env.REDIS_URL;

let redisClient;
let lastErrorLogAt = 0;

export function getRedisClient() {
    if (!redisClient) {
        redisClient = new IORedis(redisUrl, {
            maxRetriesPerRequest: null,
            enableReadyCheck: true,
            retryStrategy(times) {
                return Math.min(times * 200, 2000);
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
    try {
        const result = await Promise.race([
            getRedisClient().ping(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('redis_ping_timeout')), 1500)),
        ]);
        return result === 'PONG';
    } catch {
        return false;
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
