import { Router } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();

router.post('/generate-token', (req, res) => {
  const adminKey = req.headers['x-master-key'];

  if (!adminKey || adminKey !== process.env.MASTER_ADMIN_KEY) {
    return res.status(403).json({
      success: false,
      requestId: req.requestId,
      message: 'Unauthorized'
    });
  }

  const { tenantId, userId, role } = req.body;

  if (!tenantId || !userId || !role) {
    return res.status(400).json({
      success: false,
      requestId: req.requestId,
      message: 'tenantId, userId, and role are required'
    });
  }

  const token = jwt.sign(
    {
      tenantId,
      userId,
      role
    },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  return res.json({
    success: true,
    requestId: req.requestId,
    token
  });
});

export default router;
