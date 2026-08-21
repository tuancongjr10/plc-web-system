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
    const result = await printerService.printFromTemplate(id, templateName, variables || {}, copies, { userId: req.user.id });

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
    const result = await printerService.printTestLabel(id, { userId: req.user.id });
    res.json({ success: true, data: result, message: 'Test label sent to printer' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getAvailableQueues(req, res) {
  try {
    const queues = await printerService.listAvailableQueues();
    res.json({ success: true, data: queues });
  } catch (err) {
    logger.error(`Printer queue discovery failed: ${err.message}`);
    res.status(503).json({ success: false, error: 'printer_queue_discovery_failed', details: err.message });
  }
}

function updatePrinter(req, res) {
  try {
    const { queue_name, print_mode = 'WINDOWS_QUEUE', is_enabled = 1, is_default = 0 } = req.body;
    if (!['WINDOWS_QUEUE', 'RAW_TCP_LEGACY'].includes(print_mode)) {
      return res.status(400).json({ success: false, error: 'invalid_print_mode' });
    }
    if (print_mode === 'WINDOWS_QUEUE' && (!queue_name || typeof queue_name !== 'string')) {
      return res.status(400).json({ success: false, error: 'queue_name_required' });
    }
    const db = getDb();
    const existing = db.prepare('SELECT id FROM printers WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'printer_not_found' });
    db.transaction(() => {
      if (Number(is_default)) db.prepare('UPDATE printers SET is_default=0').run();
      db.prepare(`UPDATE printers SET queue_name=?,print_mode=?,is_enabled=?,is_default=?,connection_status='unknown',last_error=NULL,updated_at=? WHERE id=?`)
        .run(queue_name || null, print_mode, Number(Boolean(is_enabled)), Number(Boolean(is_default)), new Date().toISOString(), req.params.id);
    })();
    const printer = db.prepare('SELECT * FROM printers WHERE id=?').get(req.params.id);
    createAuditLog({ userId: req.user.id, username: req.user.username, action: 'CONFIGURE_PRINTER_QUEUE', resource: 'printers', resourceId: req.params.id, details: { queue_name, print_mode, is_default: Boolean(is_default) }, req });
    res.json({ success: true, data: printer });
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

module.exports = { getPrinters, getAvailableQueues, updatePrinter, printLabel, printTest, getPrinterStatus, getJobs, getTemplates, createTemplate };
