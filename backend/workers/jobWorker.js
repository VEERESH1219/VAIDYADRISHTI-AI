import { Worker } from 'bullmq';
import { loadEnv } from '../config/env.js';
import { getRedisClient, closeRedisClient } from '../config/redis.js';
import { validateEnvOrThrow } from '../config/validateEnv.js';
import { logger } from '../utils/logger.js';
import { PRESCRIPTION_QUEUE_NAME } from '../jobs/prescriptionQueue.js';
import { processPrescriptionPayload } from '../jobs/prescriptionProcessor.js';
import {
    recordQueueJobFinish,
    recordQueueJobRetry,
    recordQueueJobStart,
} from '../observability/metrics.js';
import { startResourceMonitor } from '../observability/resourceMonitor.js';
import {
    closePool,
    insertPrescriptionLog,
    markProcessingJobCompleted,
    markProcessingJobFailed,
    markProcessingJobInProgress,
} from '../services/pgService.js';
import { captureError, flushErrorTracker, initErrorTracker } from '../observability/errorTracker.js';

loadEnv();
validateEnvOrThrow({ role: 'worker' });
await initErrorTracker({ service: 'worker' });

const configuredConcurrency = Number(process.env.WORKER_CONCURRENCY);
const dbPoolMax = Number(process.env.DB_POOL_MAX || 10);
// Keep some headroom for non-worker DB operations to avoid pool starvation.
const safeConcurrencyCap = Math.max(1, dbPoolMax - 2);
const concurrency = Math.max(1, Math.min(configuredConcurrency, safeConcurrencyCap));
if (concurrency !== configuredConcurrency) {
    logger.warn({
        configuredConcurrency,
        appliedConcurrency: concurrency,
        dbPoolMax,
    }, 'worker_concurrency_capped_by_db_pool');
}
const stopResourceMonitor = startResourceMonitor({ role: 'worker' });

const worker = new Worker(
    PRESCRIPTION_QUEUE_NAME,
    async (job) => {
        const { jobId, tenantId, userId, payload } = job.data;
        const jobName = job.name || PRESCRIPTION_QUEUE_NAME;
        const startedAt = process.hrtime.bigint();

        recordQueueJobStart(jobName);
        if ((job.attemptsMade || 0) > 0) {
            recordQueueJobRetry(jobName);
        }

        try {
            await markProcessingJobInProgress(jobId);

            const result = await processPrescriptionPayload(payload);

            await markProcessingJobCompleted(jobId, result);
            await insertPrescriptionLog({
                tenantId,
                userId,
                rawInput: payload?.raw_text || '[image]',
                extractedCount: result.extracted_count || 0,
            });

            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            recordQueueJobFinish({
                jobName,
                durationMs,
                success: true,
            });

            return { jobId, tenantId, extractedCount: result.extracted_count || 0 };
        } catch (err) {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            recordQueueJobFinish({
                jobName,
                durationMs,
                success: false,
            });
            throw err;
        }
    },
    {
        connection: getRedisClient(),
        concurrency,
    }
);

worker.on('completed', (job, result) => {
    logger.info({ queueJobId: job.id, ...result }, 'worker_job_completed');
});

worker.on('error', (err) => {
    logger.error({ err: err.message }, 'worker_error');
    captureError(err, { area: 'worker_error_event' });
});

worker.on('failed', async (job, err) => {
    const jobId = job?.data?.jobId;
    const tenantId = job?.data?.tenantId;
    try {
        if (jobId) {
            await markProcessingJobFailed(jobId, err?.message || 'Job failed');
        }
    } catch (markErr) {
        logger.error({ err: markErr?.message, jobId }, 'worker_failed_status_update_error');
    }

    logger.error(
        {
            queueJobId: job?.id,
            domainJobId: jobId,
            tenantId,
            error: err?.message,
        },
        'worker_job_failed'
    );
    captureError(err, { area: 'worker_job_failed', jobId, tenantId });
});

logger.info({ concurrency }, 'job_worker_started');

let shuttingDown = false;

async function shutdown(signal, error = null) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.warn({ signal, error: error?.message }, 'worker_shutdown_started');

    await Promise.allSettled([
        worker.close(),
        closeRedisClient(),
        closePool(),
        flushErrorTracker(),
    ]);
    stopResourceMonitor();

    if (error) {
        logger.fatal({ err: error }, 'worker_shutdown_due_to_fatal_error');
        process.exit(1);
    }

    logger.warn('worker_shutdown_completed');
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => shutdown('uncaughtException', err));
process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (err.code === 'ECONNREFUSED' && err.message.includes('127.0.0.1:6379')) {
        logger.warn({ err: err.message }, 'worker_redis_unreachable_retrying_in_background');
        return;
    }
    shutdown('unhandledRejection', err);
});
