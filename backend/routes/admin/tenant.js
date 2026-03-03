import { Router } from 'express';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { clearAuthFailures, consumeAuthFailure } from '../../middleware/rateLimiter.js';
import { validateJsonObjectBody, validateRequest } from '../../middleware/validation.js';

const router = Router();
const JWT_ISSUER = process.env.JWT_ISSUER;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE;
const JWT_TOKEN_TTL_SECONDS = Number(process.env.JWT_TOKEN_TTL_SECONDS || 43_200);

function isNonEmptyString(value, min = 1, max = 128) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
}

const validateGenerateTokenPayload = validateRequest((req) => {
  const bodyError = validateJsonObjectBody(req);
  if (bodyError) return bodyError;

  const { tenantId, userId, role } = req.body || {};
  if (!isNonEmptyString(tenantId, 1, 100)) return 'tenantId is required';
  if (!isNonEmptyString(userId, 1, 100)) return 'userId is required';
  if (!isNonEmptyString(role, 1, 50)) return 'role is required';
  return null;
});

router.post('/generate-token', validateGenerateTokenPayload, async (req, res) => {
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

  const { tenantId, userId, role } = req.body;

  const token = jwt.sign(
    {
      sub: userId,
      tenantId: tenantId.trim(),
      userId: userId.trim(),
      role: role.trim(),
      jti: randomUUID(),
    },
    process.env.JWT_SECRET,
    {
      algorithm: 'HS256',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: JWT_TOKEN_TTL_SECONDS,
    }
  );

  return res.json({
    success: true,
    requestId: req.requestId,
    token
  });
});

export default router;
