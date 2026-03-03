import { Router } from 'express';
import { getPool, hasPostgres } from '../../services/pgService.js';
import { validateRequest } from '../../middleware/validation.js';

const router = Router();

const validateUsageRequest = validateRequest((req) => {
    if (req.body && Object.keys(req.body).length > 0) {
        return 'GET requests do not accept a request body.';
    }
    return null;
});

router.get('/tenant/usage', validateUsageRequest, async (req, res, next) => {
    try {
        const tenantId = req.tenantId;

        if (!tenantId) {
            return res.status(400).json({
                success: false,
                requestId: req.requestId,
                message: 'Missing tenant context.',
            });
        }

        if (!hasPostgres()) {
            return res.json({
                success: true,
                requestId: req.requestId,
                tenant_id: tenantId,
                total_requests: 0,
                total_extractions: 0,
                avg_extracted_count: 0,
                last_24h_requests: 0,
            });
        }

        const { rows } = await getPool().query(
            `
            SELECT
                COUNT(*)::int AS total_requests,
                COALESCE(SUM(extracted_count), 0)::int AS total_extractions,
                COALESCE(ROUND(AVG(extracted_count)::numeric, 2), 0)::float AS avg_extracted_count,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS last_24h_requests
            FROM prescription_logs
            WHERE tenant_id = $1
            `,
            [tenantId]
        );

        const usage = rows[0] || {};

        return res.json({
            success: true,
            requestId: req.requestId,
            tenant_id: tenantId,
            total_requests: usage.total_requests || 0,
            total_extractions: usage.total_extractions || 0,
            avg_extracted_count: usage.avg_extracted_count || 0,
            last_24h_requests: usage.last_24h_requests || 0,
        });
    } catch (err) {
        err.statusCode = err.statusCode || 500;
        return next(err);
    }
});

router.get('/tenant/usage/daily', validateUsageRequest, async (req, res, next) => {
    try {
        const tenantId = req.tenantId;

        if (!tenantId) {
            return res.status(400).json({
                success: false,
                requestId: req.requestId,
                message: 'Missing tenant context.',
            });
        }

        if (!hasPostgres()) {
            return res.json({
                success: true,
                requestId: req.requestId,
                tenant_id: tenantId,
                daily_usage: [],
            });
        }

        const { rows } = await getPool().query(
            `
            SELECT
                DATE(created_at) AS date,
                COUNT(*)::int AS total_requests,
                COALESCE(SUM(extracted_count), 0)::int AS total_extractions
            FROM prescription_logs
            WHERE tenant_id = $1
            GROUP BY DATE(created_at)
            ORDER BY DATE(created_at) DESC
            `,
            [tenantId]
        );

        return res.json({
            success: true,
            requestId: req.requestId,
            tenant_id: tenantId,
            daily_usage: rows.map((row) => ({
                date: row.date,
                total_requests: row.total_requests || 0,
                total_extractions: row.total_extractions || 0,
            })),
        });
    } catch (err) {
        err.statusCode = err.statusCode || 500;
        return next(err);
    }
});

export default router;
