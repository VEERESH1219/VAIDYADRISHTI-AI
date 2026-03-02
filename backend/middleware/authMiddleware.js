import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      requestId: req.requestId,
      message: 'Missing or invalid Authorization header'
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.tenantId || !decoded.userId || !decoded.role) {
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

    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      requestId: req.requestId,
      message: 'Invalid or expired token'
    });
  }
}
