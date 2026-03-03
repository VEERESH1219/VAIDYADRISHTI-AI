import { Worker } from 'bullmq';
import { loadEnv } from '../config/env.js';
import { getRedisClient, closeRedisClient } from '../config/redis.js';
import { validateEnvOrThrow } from '../config/validateEnv.js';
import { logger } from '../utils/logger.js';
import { PRESCRIPTION_QUEUE_NAME } from '../jobs/prescriptionQueue.js';
import { processPrescriptionPayload } from '../jobs/prescriptionProcessor.js';
import {
    closePool,
    insertPrescriptionLog,
    markProcessingJobCompleted,
    markProcessingJobFailed,
    markProcessingJobInProgress,
} from '../services/pgService.js';

loadEnv();
validateEnvOrThrow({ role: 'worker' });

const concurrency = Number(process.env.WORKER_CONCURRENCY);

const worker = new Worker(
    PRESCRIPTION_QUEUE_NAME,
    async (job) => {
        const { jobId, tenantId, userId, payload } = job.data;
        await markProcessingJobInProgress(jobId);

        const result = await processPrescriptionPayload(payload);

        await markProcessingJobCompleted(jobId, result);
        await insertPrescriptionLog({
            tenantId,
            userId,
            rawInput: payload?.raw_text || '[image]',
            extractedCount: result.extracted_count || 0,
        });

        return { jobId, extractedCount: result.extracted_count || 0 };
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
});

worker.on('failed', async (job, err) => {
    const jobId = job?.data?.jobId;
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
            error: err?.message,
        },
        'worker_job_failed'
    );
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
    ]);

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
    shutdown('unhandledRejection', err);
});
