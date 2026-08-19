const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb } = require('../models/database');
const { createAuditLog } = require('./auditMiddleware');

/**
 * JWT Authentication Middleware
 */
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Access token required',
    });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Token expired' });
    }
    return res.status(403).json({ success: false, error: 'Invalid token' });
  }
}

/**
 * Role-based Authorization Middleware
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `Access denied. Required role: ${allowedRoles.join(' or ')}`,
      });
    }

    next();
  };
}

/**
 * Check if user account is active
 */
function checkActive(req, res, next) {
  const db = getDb();
  const user = db.prepare('SELECT is_active FROM users WHERE id = ?').get(req.user.id);

  if (!user || !user.is_active) {
    return res.status(403).json({
      success: false,
      error: 'Account is deactivated',
    });
  }

  next();
}

module.exports = { authenticate, authorize, checkActive };
