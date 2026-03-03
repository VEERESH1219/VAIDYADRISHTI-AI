import { recordHttpMetrics } from '../observability/metrics.js';

export function httpMetricsMiddleware(req, res, next) {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const route = req.route?.path || req.originalUrl || req.url || 'unknown';

        recordHttpMetrics({
            method: req.method,
            route,
            statusCode: res.statusCode,
            durationMs,
        });
    });

    next();
}
