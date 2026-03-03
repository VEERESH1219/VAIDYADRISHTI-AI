import { Router } from 'express';
import { getPool, hasPostgres } from '../../services/pgService.js';

const router = Router();

router.post('/reset-tenant-usage', async (req, res, next) => {
  const adminKey = req.headers['x-master-key'];

  if (!adminKey || adminKey !== process.env.MASTER_ADMIN_KEY) {
    return res.status(403).json({
      success: false,
      requestId: req.requestId,
      message: 'Unauthorized'
    });
  }

  const { tenantId } = req.body;

  if (!tenantId) {
    return res.status(400).json({
      success: false,
      requestId: req.requestId,
      message: 'tenantId is required'
    });
  }

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
