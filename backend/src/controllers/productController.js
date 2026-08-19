const { getDb } = require('../models/database');
const logger = require('../config/logger');
const { createAuditLog } = require('../middleware/auditMiddleware');

/**
 * GET /api/products
 */
function getProducts(req, res) {
  try {
    const db = getDb();
    const products = db.prepare(`
      SELECT p.*, t.name as label_template_name
      FROM products p
      LEFT JOIN label_templates t ON p.label_template_id = t.id
      ORDER BY p.name ASC
    `).all();
    res.json({ success: true, data: products });
  } catch (err) {
    logger.error('Get products error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/products/barcode/:barcode
 */
function getProductByBarcode(req, res) {
  try {
    const { barcode } = req.params;
    const db = getDb();
    const product = db.prepare(`
      SELECT p.*, t.name as label_template_name
      FROM products p
      LEFT JOIN label_templates t ON p.label_template_id = t.id
      WHERE p.barcode = ?
    `).get(barcode);

    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    res.json({ success: true, data: product });
  } catch (err) {
    logger.error('Get product by barcode error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/products
 */
function createProduct(req, res) {
  try {
    const { barcode, name, target_revs, speed_rpm, label_template_id } = req.body;

    if (!barcode || !name) {
      return res.status(400).json({ success: false, error: 'Barcode and name are required' });
    }

    const db = getDb();
    const id = require('crypto').randomBytes(16).toString('hex');
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO products (id, barcode, name, target_revs, speed_rpm, label_template_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, barcode, name, target_revs || 1000, speed_rpm || 500, label_template_id || null, now, now);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);

    createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'CREATE_PRODUCT',
      resource: 'products',
      resourceId: id,
      details: { name, barcode },
      req
    });

    res.status(201).json({ success: true, data: product });
  } catch (err) {
    logger.error('Create product error:', err);
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ success: false, error: 'Product barcode already exists' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * PUT /api/products/:id
 */
function updateProduct(req, res) {
  try {
    const { id } = req.params;
    const { barcode, name, target_revs, speed_rpm, label_template_id } = req.body;

    const db = getDb();
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE products 
      SET barcode = ?, name = ?, target_revs = ?, speed_rpm = ?, label_template_id = ?, updated_at = ?
      WHERE id = ?
    `).run(barcode || existing.barcode, name || existing.name, 
      target_revs !== undefined ? target_revs : existing.target_revs, 
      speed_rpm !== undefined ? speed_rpm : existing.speed_rpm, 
      label_template_id !== undefined ? label_template_id : existing.label_template_id, 
      now, id);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);

    createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'UPDATE_PRODUCT',
      resource: 'products',
      resourceId: id,
      details: { name, barcode },
      req
    });

    res.json({ success: true, data: product });
  } catch (err) {
    logger.error('Update product error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * DELETE /api/products/:id
 */
function deleteProduct(req, res) {
  try {
    const { id } = req.params;
    const db = getDb();

    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    db.prepare('DELETE FROM products WHERE id = ?').run(id);

    createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'DELETE_PRODUCT',
      resource: 'products',
      resourceId: id,
      details: { name: existing.name, barcode: existing.barcode },
      req
    });

    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (err) {
    logger.error('Delete product error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getProducts, getProductByBarcode, createProduct, updateProduct, deleteProduct };
