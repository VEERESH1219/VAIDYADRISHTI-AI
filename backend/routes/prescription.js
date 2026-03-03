/**
 * VAIDYADRISHTI AI - Prescription Processing Route
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import {
    createProcessingJob,
    getProcessingJob,
    insertPrescriptionLog,
    markProcessingJobFailed,
} from '../services/pgService.js';
import { getPrescriptionQueue } from '../jobs/prescriptionQueue.js';
import { processPrescriptionPayload } from '../jobs/prescriptionProcessor.js';

const router = Router();

router.post(['/process-prescription', '/process_prescription'], async (req, res, next) => {
    try {
        const result = await processPrescriptionPayload(req.body);

        await insertPrescriptionLog({
            tenantId: req.tenantId,
            userId: req.user?.userId,
            rawInput: req.body?.raw_text || '[image]',
            extractedCount: result.extracted_count || 0,
        });

        return res.json({
            ...result,
            requestId: req.requestId,
        });
    } catch (err) {
        err.statusCode = err.statusCode || 500;
        return next(err);
    }
});

router.post('/process-prescription-async', async (req, res, next) => {
    try {
        const { image, raw_text } = req.body || {};
        if (!image && !raw_text) {
            return res.status(400).json({
                status: 'error',
                code: 'MISSING_INPUT',
                message: 'Either "image" (base64) or "raw_text" must be provided.',
                requestId: req.requestId,
            });
        }

        const jobId = randomUUID();

        await createProcessingJob({
            jobId,
            tenantId: req.tenantId,
            userId: req.user?.userId,
            status: 'queued',
            inputPayload: req.body,
        });

        try {
            const queue = getPrescriptionQueue();
            await Promise.race([
                queue.add('process', {
                    jobId,
                    tenantId: req.tenantId,
                    userId: req.user?.userId,
                    payload: req.body,
                }, {
                    jobId,
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('queue_add_timeout')), 1500)),
            ]);
        } catch (queueErr) {
            await markProcessingJobFailed(jobId, queueErr?.message || 'Queue unavailable');
            const err = new Error('Unable to enqueue processing job');
            err.statusCode = 503;
            throw err;
        }

        return res.status(202).json({
            status: 'accepted',
            job_id: jobId,
            requestId: req.requestId,
        });
    } catch (err) {
        err.statusCode = err.statusCode || 500;
        return next(err);
    }
});

router.get('/jobs/:jobId', async (req, res, next) => {
    try {
        const job = await getProcessingJob(req.params.jobId, req.tenantId);
        if (!job) {
            return res.status(404).json({
                success: false,
                requestId: req.requestId,
                message: 'Job not found',
            });
        }

        return res.json({
            status: 'success',
            requestId: req.requestId,
            job: {
                id: job.id,
                status: job.status,
                created_at: job.created_at,
                started_at: job.started_at,
                completed_at: job.completed_at,
                error_message: job.error_message,
                result: job.output_payload,
            },
        });
    } catch (err) {
        err.statusCode = err.statusCode || 500;
        return next(err);
    }
});

export default router;
