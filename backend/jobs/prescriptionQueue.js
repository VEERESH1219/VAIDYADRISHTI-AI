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
                attempts: Number(process.env.JOB_MAX_ATTEMPTS),
                backoff: {
                    type: 'exponential',
                    delay: Number(process.env.JOB_BACKOFF_MS),
                },
            },
        });
        queue.on('error', (err) => {
            logger.error({ err: err.message }, 'prescription_queue_error');
        });
    }

    return queue;
}

export function getPrescriptionQueueState() {
    return {
        initialized: !!queue,
        redis_status: getRedisClient().status || 'unknown',
    };
}

export async function closePrescriptionQueue() {
    if (!queue) return;
    await queue.close();
    queue = null;
}
