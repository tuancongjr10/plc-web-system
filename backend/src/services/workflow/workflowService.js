const EventEmitter = require('events');
const crypto = require('crypto');
const { getDb } = require('../../models/database');
const plcService = require('../plc/plcService');
const logger = require('../../config/logger');

/**
 * Production Workflow Service
 * Coordinates barcode scanner, SQLite database, and Siemens S7-1200 PLC
 */
class WorkflowService extends EventEmitter {
  constructor() {
    super();
  }

  /**
   * Handle barcode scan event
   * 1. Search product in SQLite
   * 2. Auto-load configuration (target_revs, speed_rpm, label_template)
   * 3. Create or select a Production Job
   */
  async handleScan(barcodeData, userId = null) {
    const db = getDb();
    logger.info(`Workflow processing barcode scan: ${barcodeData}`);

    // 1. Search product in SQLite and load target_revs / speed / label
    const product = db.prepare(`
      SELECT p.*, t.name as label_template_name, t.definition as label_definition
      FROM products p
      LEFT JOIN label_templates t ON p.label_template_id = t.id
      WHERE p.barcode = ?
    `).get(barcodeData);
    if (!product) {
      const errorMsg = `Không tìm thấy sản phẩm với mã vạch: ${barcodeData}`;
      logger.warn(errorMsg);
      throw new Error(errorMsg);
    }

    // 2. Load and create/select active job
    // Check if there is an existing job for this product that is in 'created' or 'running' status
    let job = db.prepare(`
      SELECT * FROM production_jobs 
      WHERE product_id = ? AND status IN ('created', 'running')
      ORDER BY created_at DESC LIMIT 1
    `).get(product.id);

    const now = new Date().toISOString();

    if (!job) {
      // Create new job if none exists in active status
      const jobId = crypto.randomBytes(16).toString('hex');
      const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      const jobCode = `JOB-${product.barcode}-${dateStr}`;

      db.prepare(`
        INSERT INTO production_jobs (id, job_code, product_id, target_revs, speed_rpm, label_template_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(jobId, jobCode, product.id, product.target_revs, product.speed_rpm, product.label_template_id, 'created', now, now);

      job = db.prepare('SELECT * FROM production_jobs WHERE id = ?').get(jobId);
      logger.info(`Created new production job: ${jobCode} for product: ${product.name}`);
    } else {
      logger.info(`Selected existing active production job: ${job.job_code} for product: ${product.name}`);
    }

    // 3. Log SCAN action
    db.prepare(`
      INSERT INTO production_logs (job_id, product_id, action, command_sent, response, status, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job.id, product.id, 'SCAN', null, null, 'success', `Barcode scanned: ${barcodeData}. Loaded product: ${product.name}. Job: ${job.job_code}`, now);

    const result = {
      action: 'workflow_scan',
      status: 'success',
      message: `Đã tải sản phẩm: ${product.name}. Mã Job: ${job.job_code}`,
      data: {
        product,
        job
      }
    };

    // Emit event
    this.emit('job:selected', { job, product, timestamp: now });
    
    return result;
  }

  /**
   * START Command -> sends MOVE=xxxx
   */
  async startJob(jobId, deviceId = null) {
    const db = getDb();
    const job = db.prepare('SELECT * FROM production_jobs WHERE id = ?').get(jobId);
    if (!job) {
      throw new Error('Không tìm thấy yêu cầu sản xuất');
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(job.product_id);

    // Resolve target PLC device
    let plcDevice = null;
    if (deviceId) {
      plcDevice = db.prepare('SELECT * FROM plc_devices WHERE id = ?').get(deviceId);
    } else {
      plcDevice = db.prepare('SELECT * FROM plc_devices WHERE is_active = 1 LIMIT 1').get();
    }

    if (!plcDevice) {
      throw new Error('Không tìm thấy thiết bị PLC đang hoạt động');
    }

    const targetRevs = job.target_revs || 0;
    const formattedRevs = String(targetRevs).padStart(4, '0');
    const cmdStr = `MOVE=${formattedRevs}`;
    let plcResponse = null;
    let status = 'success';
    let errorMsg = null;

    try {
      // Send move down to PLC
      const plcResult = await plcService.sendCommand(plcDevice.id, cmdStr);
      plcResponse = plcResult.response;
    } catch (err) {
      status = 'failed';
      errorMsg = err.message;
      logger.error(`PLC write failed in startJob: ${err.message}`);
      throw err;
    } finally {
      const now = new Date().toISOString();
      
      if (status === 'success') {
        // Update job status to running
        db.prepare("UPDATE production_jobs SET status = 'running', updated_at = ? WHERE id = ?")
          .run(now, jobId);
        job.status = 'running';
      }

      // Log production action
      db.prepare(`
        INSERT INTO production_logs (job_id, product_id, action, command_sent, response, status, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(jobId, job.product_id, 'START', cmdStr, plcResponse || errorMsg, status, 
        status === 'success' ? `Lệnh START gửi MOVE=${formattedRevs} thành công.` : `Lỗi gửi lệnh START: ${errorMsg}`, now);

      this.emit('job:updated', { job, timestamp: now });
    }

    return { success: true, job, plcResponse };
  }

  /**
   * STOP Command -> sends STOP=0000
   */
  async stopJob(jobId, deviceId = null) {
    const db = getDb();
    const job = db.prepare('SELECT * FROM production_jobs WHERE id = ?').get(jobId);
    if (!job) {
      throw new Error('Không tìm thấy yêu cầu sản xuất');
    }

    let plcDevice = null;
    if (deviceId) {
      plcDevice = db.prepare('SELECT * FROM plc_devices WHERE id = ?').get(deviceId);
    } else {
      plcDevice = db.prepare('SELECT * FROM plc_devices WHERE is_active = 1 LIMIT 1').get();
    }

    if (!plcDevice) {
      throw new Error('Không tìm thấy thiết bị PLC đang hoạt động');
    }

    const cmdStr = 'STOP=0000';
    let plcResponse = null;
    let status = 'success';
    let errorMsg = null;

    try {
      const plcResult = await plcService.sendCommand(plcDevice.id, cmdStr);
      plcResponse = plcResult.response;
    } catch (err) {
      status = 'failed';
      errorMsg = err.message;
      logger.error(`PLC write failed in stopJob: ${err.message}`);
      throw err;
    } finally {
      const now = new Date().toISOString();

      if (status === 'success') {
        // Update job status to stopped
        db.prepare("UPDATE production_jobs SET status = 'stopped', updated_at = ? WHERE id = ?")
          .run(now, jobId);
        job.status = 'stopped';
      }

      // Log production action
      db.prepare(`
        INSERT INTO production_logs (job_id, product_id, action, command_sent, response, status, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(jobId, job.product_id, 'STOP', cmdStr, plcResponse || errorMsg, status,
        status === 'success' ? 'Lệnh STOP gửi thành công.' : `Lỗi gửi lệnh STOP: ${errorMsg}`, now);

      this.emit('job:updated', { job, timestamp: now });
    }

    return { success: true, job, plcResponse };
  }

  /**
   * HOME Command -> sends ZERO=0000
   */
  async homeJob(jobId, deviceId = null) {
    const db = getDb();
    const job = db.prepare('SELECT * FROM production_jobs WHERE id = ?').get(jobId);
    if (!job) {
      throw new Error('Không tìm thấy yêu cầu sản xuất');
    }

    let plcDevice = null;
    if (deviceId) {
      plcDevice = db.prepare('SELECT * FROM plc_devices WHERE id = ?').get(deviceId);
    } else {
      plcDevice = db.prepare('SELECT * FROM plc_devices WHERE is_active = 1 LIMIT 1').get();
    }

    if (!plcDevice) {
      throw new Error('Không tìm thấy thiết bị PLC đang hoạt động');
    }

    const cmdStr = 'ZERO=0000';
    let plcResponse = null;
    let status = 'success';
    let errorMsg = null;

    try {
      const plcResult = await plcService.sendCommand(plcDevice.id, cmdStr);
      plcResponse = plcResult.response;
    } catch (err) {
      status = 'failed';
      errorMsg = err.message;
      logger.error(`PLC write failed in homeJob: ${err.message}`);
      throw err;
    } finally {
      const now = new Date().toISOString();

      if (status === 'success') {
        // Update job status to completed
        db.prepare("UPDATE production_jobs SET status = 'completed', updated_at = ? WHERE id = ?")
          .run(now, jobId);
        job.status = 'completed';
      }

      // Log production action
      db.prepare(`
        INSERT INTO production_logs (job_id, product_id, action, command_sent, response, status, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(jobId, job.product_id, 'HOME', cmdStr, plcResponse || errorMsg, status,
        status === 'success' ? 'Lệnh HOME gửi ZERO=0000 thành công.' : `Lỗi gửi lệnh HOME: ${errorMsg}`, now);

      this.emit('job:updated', { job, timestamp: now });
    }

    return { success: true, job, plcResponse };
  }

  /**
   * Print a logical job label through PrinterService.
   */
  async printJobLabel(jobId, printerId, copies = 1) {
    const db = getDb();
    const printerService = require('../printer/printerService');
    const job = db.prepare(`
      SELECT j.*, p.name as product_name, p.barcode as product_barcode, lt.name as label_template_name
      FROM production_jobs j
      LEFT JOIN products p ON j.product_id = p.id
      LEFT JOIN label_templates lt ON j.label_template_id = lt.id
      WHERE j.id = ?
    `).get(jobId);

    if (!job) throw new Error('Không tìm thấy yêu cầu sản xuất');

    const templateName = job.label_template_name || 'product-label';
    const variables = {
      productName: job.product_name || '',
      jobId: job.job_code,
      productionDate: new Date().toLocaleDateString('vi-VN'),
      barcode: job.product_barcode || '',
      quantity: job.target_revs,
    };

    let printResult = null;
    let status = 'success';
    let errorMsg = null;

    try {
      printResult = await printerService.printFromTemplate(printerId, templateName, variables, copies);
    } catch (err) {
      status = 'failed';
      errorMsg = err.message;
      logger.error(`Print failed in printJobLabel: ${err.message}`);
      throw err;
    } finally {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO production_logs (job_id, product_id, action, command_sent, response, status, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        jobId,
        job.product_id,
        'PRINT',
        `template=${templateName}`,
        printResult ? JSON.stringify(printResult) : errorMsg,
        status,
        status === 'success' ? `In nhãn ${templateName} (${copies} bản)` : `Lỗi in: ${errorMsg}`,
        now
      );
    }

    return { success: true, job, printResult };
  }
}

const workflowService = new WorkflowService();
module.exports = workflowService;
