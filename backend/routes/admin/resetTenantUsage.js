import { Router } from 'express';
import { getPool, hasPostgres } from '../../services/pgService.js';
import { clearAuthFailures, consumeAuthFailure } from '../../middleware/rateLimiter.js';
import { validateJsonObjectBody, validateRequest } from '../../middleware/validation.js';

const router = Router();

function isNonEmptyString(value, min = 1, max = 100) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
}

const validateResetUsagePayload = validateRequest((req) => {
  const bodyError = validateJsonObjectBody(req);
  if (bodyError) return bodyError;

  if (!isNonEmptyString(req.body?.tenantId)) {
    return 'tenantId is required';
  }

  return null;
});

router.post('/reset-tenant-usage', validateResetUsagePayload, async (req, res, next) => {
  const adminKey = req.headers['x-master-key'];

  if (!adminKey || adminKey !== process.env.MASTER_ADMIN_KEY) {
    const limit = await consumeAuthFailure(req, 'admin_master_key');
    if (limit.blocked) {
      res.set('Retry-After', String(limit.retryAfterSeconds));
      return res.status(429).json({
        success: false,
        requestId: req.requestId,
        message: 'Too many failed authentication attempts. Please try again later.',
      });
    }

    return res.status(403).json({
      success: false,
      requestId: req.requestId,
      message: 'Unauthorized'
    });
  }

  await clearAuthFailures(req, 'admin_master_key');

  const tenantId = req.body.tenantId.trim();

  if (!hasPostgres()) {
    return res.json({
      success: true,
      requestId: req.requestId,
      deleted_rows: 0
    });
  }

  try {
    const result = await getPool().query(
      `
      DELETE FROM prescription_logs
      WHERE tenant_id = $1
        AND created_at >= CURRENT_DATE
      `,
      [tenantId]
    );

    return res.json({
      success: true,
      requestId: req.requestId,
      deleted_rows: result.rowCount || 0
    });
  } catch (err) {
    err.statusCode = err.statusCode || 500;
    return next(err);
  }
});

export default router;
