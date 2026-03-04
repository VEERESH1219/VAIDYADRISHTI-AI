import jwt from 'jsonwebtoken';
import { clearAuthFailures, consumeAuthFailure } from './rateLimiter.js';

const JWT_ALGORITHMS = ['HS256'];
// NOTE: JWT_ISSUER, JWT_AUDIENCE, JWT_MAX_TOKEN_AGE_SECONDS are read lazily inside
// each function to ensure loadEnv() has already populated process.env in ESM.

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function handleAuthFailure(req, res, message) {
  const limit = await consumeAuthFailure(req, 'jwt');
  if (limit.blocked) {
    res.set('Retry-After', String(limit.retryAfterSeconds));
    return res.status(429).json({
      success: false,
      requestId: req.requestId,
      message: 'Too many failed authentication attempts. Please try again later.',
    });
  }

  return res.status(401).json({
    success: false,
    requestId: req.requestId,
    message,
  });
}

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return handleAuthFailure(req, res, 'Missing or invalid Authorization header');
  }

  const token = authHeader.split(' ')[1];
  if (!isNonEmptyString(token) || token.split('.').length !== 3) {
    return handleAuthFailure(req, res, 'Invalid or expired token');
  }

  try {
    const JWT_ISSUER = process.env.JWT_ISSUER;
    const JWT_AUDIENCE = process.env.JWT_AUDIENCE;
    const JWT_MAX_TOKEN_AGE_SECONDS = Number(process.env.JWT_MAX_TOKEN_AGE_SECONDS || 43_200);

    const decodedToken = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: JWT_ALGORITHMS,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      maxAge: `${JWT_MAX_TOKEN_AGE_SECONDS}s`,
      ignoreExpiration: false,
      complete: true,
      clockTolerance: 0,
    });

    const header = decodedToken?.header || {};
    const decoded = decodedToken?.payload || {};
    if (header.alg !== 'HS256') {
      return handleAuthFailure(req, res, 'Invalid or expired token');
    }

    if (
      !isNonEmptyString(decoded.tenantId) ||
      !isNonEmptyString(decoded.userId) ||
      !isNonEmptyString(decoded.role) ||
      !isNonEmptyString(decoded.sub) ||
      !Number.isInteger(decoded.iat) ||
      !Number.isInteger(decoded.exp)
    ) {
      return res.status(403).json({
        success: false,
        requestId: req.requestId,
        message: 'Invalid token payload'
      });
    }

    req.user = {
      userId: decoded.userId,
      tenantId: decoded.tenantId,
      role: decoded.role
    };

    req.tenantId = decoded.tenantId;
    req.role = decoded.role;

    await clearAuthFailures(req, 'jwt');
    return next();
  } catch (err) {
    return handleAuthFailure(req, res, 'Invalid or expired token');
  }
}

export function requireRole(rolesArray = []) {
  return (req, res, next) => {
    if (!req.user || !req.role) {
      return res.status(401).json({
        success: false,
        requestId: req.requestId,
        message: 'Authentication required'
      });
    }

    if (!Array.isArray(rolesArray) || rolesArray.length === 0) {
      return next();
    }

    if (!rolesArray.includes(req.role)) {
      return res.status(403).json({
        success: false,
        requestId: req.requestId,
        message: 'Forbidden: insufficient role permissions'
      });
    }

    return next();
  };
}
