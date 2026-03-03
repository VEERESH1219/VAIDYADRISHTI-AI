import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';

export function attachRequestContext(req, res, next) {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);

    const startedAt = Date.now();
    res.on('finish', () => {
        logger.info({
            requestId: req.requestId,
            method: req.method,
            path: req.path || req.originalUrl || req.url,
            status: res.statusCode,
            durationMs: Date.now() - startedAt,
            tenantId: req.tenantId || req.user?.tenantId || null,
            userId: req.user?.userId || null,
        }, 'http_request');
    });

    next();
}
