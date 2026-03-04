import { Queue } from 'bullmq';
import { getRedisClient } from '../config/redis.js';
import { logger } from '../utils/logger.js';

export const PRESCRIPTION_QUEUE_NAME = 'prescription-processing';

let queue;

export function getPrescriptionQueue() {
    if (!queue) {
        queue = new Queue(PRESCRIPTION_QUEUE_NAME, {
            connection: getRedisClient(),
            defaultJobOptions: {
                removeOnComplete: 200,
                removeOnFail: 500,
                attempts: Number(process.env.JOB_MAX_ATTEMPTS || 3),
                backoff: {
                    type: 'exponential',
                    delay: Number(process.env.JOB_BACKOFF_MS || 2000),
                },
            },
        });

        // Suppress unhandled promise rejections for connection refused
        queue.on('error', (err) => {
            if (err.code === 'ECONNREFUSED') {
                logger.warn({ err: err.message }, 'prescription_queue_redis_unreachable_retrying');
            } else {
                logger.error({ err: err.message }, 'prescription_queue_error');
            }
        });
    }

    return queue;
}

export function getPrescriptionQueueState() {
    // Safely read redis status — getRedisClient() will create a client if not yet
    // initialized, so wrapping in try/catch prevents crashes if Redis is unavailable.
    let redis_status = 'unknown';
    try {
        redis_status = getRedisClient().status || 'unknown';
    } catch {
        redis_status = 'unavailable';
    }
    return {
        initialized: !!queue,
        redis_status,
    };
}

export async function closePrescriptionQueue() {
    if (!queue) return;
    await queue.close();
    queue = null;
}
