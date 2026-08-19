const { getDb } = require('../models/database');
const printerService = require('../services/printer/printerService');
const logger = require('../config/logger');
const { createAuditLog } = require('../middleware/auditMiddleware');

/**
 * GET /api/printers
 */
function getPrinters(req, res) {
  const db = getDb();
  const printers = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM print_jobs WHERE printer_id = p.id AND status = 'completed') as total_jobs
    FROM printers p
    ORDER BY p.created_at ASC
  `).all();
  res.json({ success: true, data: printers });
}

/**
 * POST /api/printers/:id/print
 */
async function printLabel(req, res) {
  try {
    const { id } = req.params;
    const { templateName, variables, copies = 1 } = req.body;
    if (!templateName) return res.status(400).json({ success: false, error: 'templateName required' });
    const result = await printerService.printFromTemplate(id, templateName, variables || {}, copies);

    createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'PRINT_LABEL', resource: 'printers', resourceId: id,
      details: { copies, templateName }, req,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Print error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/printers/:id/test
 */
async function printTest(req, res) {
  try {
    const { id } = req.params;
    const result = await printerService.printTestLabel(id);
    res.json({ success: true, data: result, message: 'Test label sent to printer' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/printers/:id/status
 */
async function getPrinterStatus(req, res) {
  try {
    const status = await printerService.getPrinterStatus(req.params.id);
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/printers/jobs
 */
function getJobs(req, res) {
  const { printerId, status, limit = 50, offset = 0 } = req.query;
  const jobs = printerService.getPrintJobs({ printerId, status, limit: parseInt(limit), offset: parseInt(offset) });
  res.json({ success: true, data: jobs });
}

/**
 * GET /api/printers/templates
 */
function getTemplates(req, res) {
  const db = getDb();
  const templates = db.prepare('SELECT * FROM label_templates WHERE is_active = 1 ORDER BY name').all();
  res.json({ success: true, data: templates });
}

/**
 * POST /api/printers/templates
 */
function createTemplate(req, res) {
  try {
    const { name, description, definition, variables } = req.body;
    if (!name || !definition) {
      return res.status(400).json({ success: false, error: 'Name and logical label definition required' });
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO label_templates (name, description, definition, variables, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, description || null, JSON.stringify(definition),
      variables ? JSON.stringify(variables) : null, req.user.id);

    const template = db.prepare('SELECT * FROM label_templates WHERE name = ?').get(name);
    res.status(201).json({ success: true, data: template });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ success: false, error: 'Template name already exists' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getPrinters, printLabel, printTest, getPrinterStatus, getJobs, getTemplates, createTemplate };
