const { getDb } = require('../models/database');

/**
 * Create audit log entry
 */
function createAuditLog({ userId, username, action, resource, resourceId, details, req }) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_logs (user_id, username, action, resource, resource_id, details, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId || null,
      username || null,
      action,
      resource || null,
      resourceId || null,
      details ? JSON.stringify(details) : null,
      req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) : null,
      req ? req.headers['user-agent'] : null
    );
  } catch (err) {
    // Don't throw - audit log failure should not break the app
    console.error('Audit log error:', err.message);
  }
}

/**
 * Auto-audit middleware factory
 */
function auditMiddleware(action, resource) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      if (res.statusCode < 400 && req.user) {
        createAuditLog({
          userId: req.user.id,
          username: req.user.username,
          action,
          resource,
          resourceId: req.params.id || null,
          details: { method: req.method, path: req.path },
          req,
        });
      }
      return originalJson(data);
    };
    next();
  };
}

module.exports = { createAuditLog, auditMiddleware };
