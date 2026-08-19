const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../models/database');
const config = require('../config');
const logger = require('../config/logger');
const { createAuditLog } = require('../middleware/auditMiddleware');

/**
 * POST /api/auth/login
 */
async function login(req, res) {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      logger.warn(`Failed login attempt for user: ${username}`);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // Generate tokens
    const accessToken = jwt.sign(
      { id: user.id, username: user.username, role: user.role, fullName: user.full_name },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    const refreshToken = jwt.sign(
      { id: user.id, type: 'refresh' },
      config.jwt.secret,
      { expiresIn: config.jwt.refreshExpiresIn }
    );

    // Save refresh token
    const refreshExpiry = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)
    `).run(user.id, refreshToken, refreshExpiry);

    // Update last login
    db.prepare('UPDATE users SET last_login = ? WHERE id = ?')
      .run(new Date().toISOString(), user.id);

    createAuditLog({
      userId: user.id,
      username: user.username,
      action: 'LOGIN',
      resource: 'auth',
      req,
    });

    logger.info(`User logged in: ${username} (${user.role})`);

    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          username: user.username,
          fullName: user.full_name,
          email: user.email,
          role: user.role,
        },
      },
    });
  } catch (err) {
    logger.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/auth/refresh
 */
function refreshToken(req, res) {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ success: false, error: 'Refresh token required' });
  }

  try {
    const decoded = jwt.verify(refreshToken, config.jwt.secret);
    if (decoded.type !== 'refresh') {
      return res.status(400).json({ success: false, error: 'Invalid refresh token' });
    }

    const db = getDb();
    const storedToken = db.prepare(`
      SELECT * FROM refresh_tokens WHERE token = ? AND expires_at > ?
    `).get(refreshToken, new Date().toISOString());

    if (!storedToken) {
      return res.status(401).json({ success: false, error: 'Refresh token expired or invalid' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(decoded.id);
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const newAccessToken = jwt.sign(
      { id: user.id, username: user.username, role: user.role, fullName: user.full_name },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    res.json({ success: true, data: { accessToken: newAccessToken } });
  } catch {
    res.status(401).json({ success: false, error: 'Invalid refresh token' });
  }
}

/**
 * POST /api/auth/logout
 */
function logout(req, res) {
  const { refreshToken } = req.body;
  if (refreshToken) {
    const db = getDb();
    db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(refreshToken);
  }

  createAuditLog({
    userId: req.user?.id,
    username: req.user?.username,
    action: 'LOGOUT',
    resource: 'auth',
    req,
  });

  res.json({ success: true, message: 'Logged out successfully' });
}

/**
 * GET /api/auth/me
 */
function getMe(req, res) {
  const db = getDb();
  const user = db.prepare('SELECT id, username, full_name, email, role, last_login, created_at FROM users WHERE id = ?')
    .get(req.user.id);

  res.json({ success: true, data: user });
}

/**
 * PUT /api/auth/password
 */
async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'Both passwords required' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  const isValid = await bcrypt.compare(currentPassword, user.password);
  if (!isValid) {
    return res.status(400).json({ success: false, error: 'Current password is incorrect' });
  }

  const hashed = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password = ?, updated_at = ? WHERE id = ?')
    .run(hashed, new Date().toISOString(), req.user.id);

  createAuditLog({ userId: req.user.id, username: req.user.username, action: 'CHANGE_PASSWORD', req });
  res.json({ success: true, message: 'Password changed successfully' });
}

module.exports = { login, refreshToken, logout, getMe, changePassword };
