const { getDb } = require('../models/database');
const workflowService = require('../services/workflow/workflowService');
const logger = require('../config/logger');
const { createAuditLog } = require('../middleware/auditMiddleware');

/**
 * GET /api/jobs
 */
function getJobs(req, res) {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const db = getDb();
    
    let query = `
      SELECT j.*, p.name as product_name, p.barcode as product_barcode, lt.name as label_template_name
      FROM production_jobs j
      LEFT JOIN products p ON j.product_id = p.id
      LEFT JOIN label_templates lt ON j.label_template_id = lt.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ' AND j.status = ?';
      params.push(status);
    }

    query += ' ORDER BY j.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const jobs = db.prepare(query).all(...params);
    res.json({ success: true, data: jobs });
  } catch (err) {
    logger.error('Get jobs error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/jobs/active
 */
function getActiveJob(req, res) {
  try {
    const db = getDb();
    const job = db.prepare(`
      SELECT j.*, p.name as product_name, p.barcode as product_barcode, lt.name as label_template_name
      FROM production_jobs j
      LEFT JOIN products p ON j.product_id = p.id
      LEFT JOIN label_templates lt ON j.label_template_id = lt.id
      WHERE j.status IN ('created', 'running')
      ORDER BY j.updated_at DESC LIMIT 1
    `).get();

    res.json({ success: true, data: job || null });
  } catch (err) {
    logger.error('Get active job error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/jobs/:id/start
 */
async function startJob(req, res) {
  try {
    const { id } = req.params;
    const { deviceId } = req.body;

    const result = await workflowService.startJob(id, deviceId);

    createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'START_JOB',
      resource: 'production_jobs',
      resourceId: id,
      details: { deviceId },
      req
    });

    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Start job error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/jobs/:id/stop
 */
async function stopJob(req, res) {
  try {
    const { id } = req.params;
    const { deviceId } = req.body;

    const result = await workflowService.stopJob(id, deviceId);

    createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'STOP_JOB',
      resource: 'production_jobs',
      resourceId: id,
      details: { deviceId },
      req
    });

    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Stop job error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

async function homeJob(req, res) {
  try {
    const { id } = req.params;
    const { deviceId } = req.body;
    const result = await workflowService.homeJob(id, deviceId);
    createAuditLog({ userId: req.user.id, username: req.user.username, action: 'HOME_JOB',
      resource: 'production_jobs', resourceId: id, details: { deviceId }, req });
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Home job error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/jobs/:id/reset
 */
async function resetJob(req, res) {
  try {
    const { id } = req.params;
    const { deviceId } = req.body;

    const result = await workflowService.resetJob(id, deviceId);

    createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'RESET_JOB',
      resource: 'production_jobs',
      resourceId: id,
      details: { deviceId },
      req
    });

    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Reset job error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/jobs/:id/print
 */
async function printJob(req, res) {
  try {
    const { id } = req.params;
    const { printerId, copies = 1 } = req.body;
    if (!printerId) {
      return res.status(400).json({ success: false, error: 'printerId is required' });
    }

    const result = await workflowService.printJobLabel(id, printerId, copies);

    createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'PRINT_JOB',
      resource: 'production_jobs',
      resourceId: id,
      details: { printerId, copies },
      req,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Print job error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/jobs/logs
 */
function getProductionLogs(req, res) {
  try {
    const { jobId, limit = 50, offset = 0 } = req.query;
    const db = getDb();

    let query = `
      SELECT l.*, p.name as product_name, p.barcode as product_barcode, j.job_code
      FROM production_logs l
      LEFT JOIN production_jobs j ON l.job_id = j.id
      LEFT JOIN products p ON l.product_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (jobId) {
      query += ' AND l.job_id = ?';
      params.push(jobId);
    }

    query += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const logs = db.prepare(query).all(...params);
    res.json({ success: true, data: logs });
  } catch (err) {
    logger.error('Get production logs error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getJobs, getActiveJob, startJob, stopJob, homeJob, resetJob, printJob, getProductionLogs };
