const EventEmitter = require('events');
const crypto = require('crypto');
const { getDb } = require('../../models/database');
const defaultPlcService = require('../plc/plcService');
const logger = require('../../config/logger');

const ACK_JOB = 'ACK=0001';

class WorkflowService extends EventEmitter {
  constructor(dependencies = {}) {
    super();
    this.dbProvider = dependencies.dbProvider || getDb;
    this.plcService = dependencies.plcService || defaultPlcService;
    this.now = dependencies.now || (() => new Date());
    this.loadedJobs = new Map();
    this._onTelemetry = ({ deviceId }) => {
      try { this.reconcileDevice(deviceId); }
      catch (error) { logger.warn(`PLC job reconciliation failed for ${deviceId}: ${error.message}`); }
    };
    this.plcService.on?.('telemetry:updated', this._onTelemetry);
  }

  stop() { this.plcService.removeListener?.('telemetry:updated', this._onTelemetry); }
  _db() { return this.dbProvider(); }
  _nowIso() { return this.now().toISOString(); }

  _resolvePlcDevice(db, deviceId = null) {
    const device = deviceId
      ? db.prepare('SELECT * FROM plc_devices WHERE id = ?').get(deviceId)
      : db.prepare('SELECT * FROM plc_devices WHERE is_active = 1 LIMIT 1').get();
    if (!device) throw new Error('plc_device_not_found');
    return device;
  }

  _getJobProtocolData(product) {
    let configured = {};
    try { configured = JSON.parse(process.env.PLC_JOB_MAP || '{}')[product.barcode] || {}; }
    catch { throw new Error('PLC_JOB_MAP must be valid JSON'); }
    const data = {
      productId: configured.productId ?? product.plc_product_id,
      recipeId: configured.recipeId ?? product.recipe_id,
      targetQty: configured.targetQty ?? product.target_qty,
    };
    const missing = Object.entries(data).filter(([, value]) => value === undefined || value === null || value === '').map(([key]) => key);
    if (missing.length) throw new Error(`plc_job_configuration_missing:${missing.join(',')}`);
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Number(value)]));
  }

  _snapshot(deviceId) { return this.plcService.getTelemetrySnapshot?.(deviceId) || null; }
  _requireRealConnected(snapshot) {
    if (!snapshot?.connected || snapshot.isDemo || snapshot.mode !== 'REAL') throw new Error('plc_offline');
  }
  _requireFresh(snapshot) {
    this._requireRealConnected(snapshot);
    if (!snapshot.telemetryFresh || !snapshot.telemetry) throw new Error('telemetry_stale');
    return snapshot.telemetry;
  }
  _matches(telemetry, data) {
    return Boolean(telemetry?.JobLoaded)
      && Number(telemetry.ProductID) === Number(data.productId)
      && Number(telemetry.RecipeID) === Number(data.recipeId)
      && Number(telemetry.TargetQty) === Number(data.targetQty);
  }
  _persistedData(job) { return { productId: job.plc_product_id, recipeId: job.plc_recipe_id, targetQty: job.plc_target_qty }; }
  _log(db, { jobId = null, productId = null, action, command = null, response = null, status = 'success', details = null }) {
    db.prepare(`INSERT INTO production_logs (job_id,product_id,action,command_sent,response,status,details,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(jobId, productId, action, command, response, status, details, this._nowIso());
  }
  _markNotLoaded(db, jobId, reconcileStatus = 'not_loaded') {
    db.prepare(`UPDATE production_jobs SET plc_job_loaded=0,plc_loaded_at=NULL,last_plc_ack=NULL,
      plc_reconcile_status=?,updated_at=? WHERE id=?`).run(reconcileStatus, this._nowIso(), jobId);
    this.loadedJobs.delete(jobId);
  }

  reconcileDevice(deviceId, suppliedSnapshot = null) {
    const db = this._db();
    const snapshot = suppliedSnapshot || this._snapshot(deviceId);
    if (!snapshot?.connected || snapshot.isDemo || !snapshot.telemetryFresh || !snapshot.telemetry) return { status: 'telemetry_unavailable' };
    const telemetry = snapshot.telemetry;
    const rows = db.prepare('SELECT * FROM production_jobs WHERE plc_device_id=? AND plc_job_loaded=1').all(deviceId);
    if (!telemetry.JobLoaded) {
      for (const row of rows) this._markNotLoaded(db, row.id);
      return { status: 'not_loaded', cleared: rows.length };
    }
    const matches = rows.filter((row) => this._matches(telemetry, this._persistedData(row)));
    if (matches.length === 1) {
      const row = matches[0];
      db.prepare("UPDATE production_jobs SET plc_reconcile_status='loaded',updated_at=? WHERE id=?").run(this._nowIso(), row.id);
      this.loadedJobs.set(row.id, { deviceId, protocolData: this._persistedData(row), persisted: true });
      for (const other of rows.filter((candidate) => candidate.id !== row.id)) {
        this._markNotLoaded(db, other.id, 'mismatch');
        this._log(db, { jobId: other.id, productId: other.product_id, action: 'JOB_RECONCILE_MISMATCH', status: 'failed', details: 'multiple_or_mismatched_persisted_jobs' });
      }
      return { status: 'restored', jobId: row.id };
    }
    if (rows.length === 0) {
      this._log(db, { action: 'JOB_RECONCILE_MISMATCH', status: 'failed', details: `orphan_plc_job:${telemetry.ProductID},${telemetry.RecipeID},${telemetry.TargetQty}` });
      return { status: 'orphan_plc_job' };
    }
    for (const row of rows) {
      db.prepare("UPDATE production_jobs SET plc_reconcile_status='mismatch',updated_at=? WHERE id=?").run(this._nowIso(), row.id);
      this.loadedJobs.delete(row.id);
      this._log(db, { jobId: row.id, productId: row.product_id, action: 'JOB_RECONCILE_MISMATCH', status: 'failed', details: 'db_plc_identifiers_mismatch' });
    }
    return { status: 'mismatch' };
  }

  async loadJobToPlc(job, product, deviceId = null) {
    const db = this._db();
    const device = this._resolvePlcDevice(db, deviceId);
    const data = this._getJobProtocolData(product);
    const telemetry = this._requireFresh(this._snapshot(device.id));
    const persisted = db.prepare('SELECT * FROM production_jobs WHERE id=?').get(job.id);
    if (telemetry.JobLoaded) {
      if (persisted.plc_job_loaded && persisted.plc_device_id === device.id
          && persisted.plc_reconcile_status === 'loaded' && this._matches(telemetry, data)) {
        this.loadedJobs.set(job.id, { deviceId: device.id, protocolData: data, persisted: true });
        this._log(db, { jobId: job.id, productId: product.id, action: 'JOB_ALREADY_LOADED', response: persisted.last_plc_ack, details: 'idempotent_success' });
        return { success: true, status: 'already_loaded', idempotent: true, command: null, response: persisted.last_plc_ack };
      }
      const reason = persisted.plc_job_loaded ? 'job_reconcile_mismatch' : 'orphan_plc_job';
      if (persisted.plc_job_loaded) db.prepare("UPDATE production_jobs SET plc_reconcile_status='mismatch',updated_at=? WHERE id=?").run(this._nowIso(), job.id);
      this._log(db, { jobId: job.id, productId: product.id, action: 'JOB_RECONCILE_MISMATCH', status: 'failed', details: reason });
      throw new Error(reason);
    }
    if (persisted.plc_job_loaded) this._markNotLoaded(db, job.id);
    const command = this.plcService.formatJobCommand(data.productId, data.recipeId, data.targetQty);
    this._log(db, { jobId: job.id, productId: product.id, action: 'JOB_LOAD_REQUEST', command, details: `device=${device.id}` });
    logger.info(`[PLC_JOB_TRACE] workflow ${JSON.stringify({ barcode: product.barcode, mapping: data, command })}`);
    try {
      const result = await this.plcService.sendJob(device.id, data.productId, data.recipeId, data.targetQty);
      if (result.response !== ACK_JOB || result.mode !== 'REAL') throw new Error(`invalid_job_ack:${result.response || 'none'}`);
      const now = this._nowIso();
      db.transaction(() => {
        db.prepare(`UPDATE production_jobs SET plc_device_id=?,plc_product_id=?,plc_recipe_id=?,plc_target_qty=?,
          plc_job_loaded=1,plc_loaded_at=?,last_plc_ack=?,plc_reconcile_status='loaded',updated_at=? WHERE id=?`)
          .run(device.id, data.productId, data.recipeId, data.targetQty, now, result.response, now, job.id);
        this._log(db, { jobId: job.id, productId: product.id, action: 'JOB_LOAD_ACK', command: result.command, response: result.response, details: 'persisted_after_ack' });
      })();
      this.loadedJobs.set(job.id, { deviceId: device.id, command: result.command, protocolData: data, persisted: true });
      return { ...result, status: 'loaded' };
    } catch (error) {
      this._markNotLoaded(db, job.id);
      this._log(db, { jobId: job.id, productId: product.id, action: 'JOB_LOAD_FAILED', command, response: error.message, status: 'failed', details: 'job_not_persisted_as_loaded' });
      throw error;
    }
  }

  async handleScan(barcodeData, userId = null) {
    const db = this._db();
    const product = db.prepare(`SELECT p.*,t.name label_template_name,t.definition label_definition FROM products p
      LEFT JOIN label_templates t ON p.label_template_id=t.id WHERE p.barcode=?`).get(barcodeData);
    if (!product) throw new Error(`product_not_found:${barcodeData}`);
    let job = db.prepare(`SELECT * FROM production_jobs WHERE product_id=? AND status IN ('created','running','stopped')
      ORDER BY created_at DESC LIMIT 1`).get(product.id);
    const now = this._nowIso();
    if (!job) {
      const jobId = crypto.randomBytes(16).toString('hex');
      const dateStr = now.replace(/[-:T.Z]/g, '').slice(0, 14);
      db.prepare(`INSERT INTO production_jobs
        (id,job_code,product_id,target_revs,speed_rpm,label_template_id,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'created',?,?)`).run(jobId, `JOB-${product.barcode}-${dateStr}`, product.id,
        product.target_revs, product.speed_rpm, product.label_template_id, now, now);
      job = db.prepare('SELECT * FROM production_jobs WHERE id=?').get(jobId);
    }
    this._log(db, { jobId: job.id, productId: product.id, action: 'SCAN', details: `barcode=${barcodeData};user=${userId || ''}` });
    const plcJob = await this.loadJobToPlc(job, product);
    const refreshed = db.prepare('SELECT * FROM production_jobs WHERE id=?').get(job.id);
    this.emit('job:selected', { job: refreshed, product, timestamp: now });
    return { action: 'workflow_scan', status: 'success', data: { product, job: refreshed, plcJob } };
  }

  _startGuard(job, snapshot) {
    const telemetry = this._requireFresh(snapshot);
    if (!job.plc_job_loaded) throw new Error('plc_job_not_loaded');
    if (job.plc_reconcile_status !== 'loaded' || !this._matches(telemetry, this._persistedData(job))) throw new Error('job_reconcile_mismatch');
    if (!telemetry.MachineReady) throw new Error('machine_not_ready');
    if (telemetry.MachineFault) throw new Error('machine_fault');
    if (telemetry.MoveBusy || telemetry.HaltBusy || telemetry.HomeBusy || telemetry.AxisPositioning) throw new Error('motion_busy');
  }

  async startJob(jobId, deviceId = null) {
    const db = this._db();
    const job = db.prepare('SELECT * FROM production_jobs WHERE id=?').get(jobId);
    if (!job) throw new Error('production_job_not_found');
    const device = this._resolvePlcDevice(db, deviceId || job.plc_device_id);
    this._startGuard(job, this._snapshot(device.id));
    try {
      const result = await this.plcService.sendStart(device.id);
      db.prepare("UPDATE production_jobs SET status='running',updated_at=? WHERE id=?").run(this._nowIso(), jobId);
      this._log(db, { jobId, productId: job.product_id, action: 'START', command: 'START=0000', response: result.response });
      return { success: true, job: db.prepare('SELECT * FROM production_jobs WHERE id=?').get(jobId), plcResponse: result.response };
    } catch (error) {
      this._log(db, { jobId, productId: job.product_id, action: 'START', command: 'START=0000', response: error.message, status: 'failed' });
      throw error;
    }
  }

  async stopJob(jobId, deviceId = null) {
    const db = this._db();
    const job = db.prepare('SELECT * FROM production_jobs WHERE id=?').get(jobId);
    if (!job) throw new Error('production_job_not_found');
    const device = this._resolvePlcDevice(db, deviceId || job.plc_device_id);
    this._requireRealConnected(this._snapshot(device.id));
    try {
      const result = await this.plcService.sendStop(device.id);
      db.prepare("UPDATE production_jobs SET status='stopped',updated_at=? WHERE id=?").run(this._nowIso(), jobId);
      this._log(db, { jobId, productId: job.product_id, action: 'STOP', command: 'STOP=0000', response: result.response });
      return { success: true, job: db.prepare('SELECT * FROM production_jobs WHERE id=?').get(jobId), plcResponse: result.response };
    } catch (error) {
      this._log(db, { jobId, productId: job.product_id, action: 'STOP', command: 'STOP=0000', response: error.message, status: 'failed' });
      throw error;
    }
  }

  async homeJob(jobId, deviceId = null) {
    const db = this._db();
    const job = db.prepare('SELECT * FROM production_jobs WHERE id=?').get(jobId);
    if (!job) throw new Error('production_job_not_found');
    const device = this._resolvePlcDevice(db, deviceId || job.plc_device_id);
    this._requireRealConnected(this._snapshot(device.id));
    try {
      const result = await this.plcService.sendHome(device.id);
      this._log(db, { jobId, productId: job.product_id, action: 'HOME', command: 'HOME=0000', response: result.response });
      return { success: true, job, plcResponse: result.response };
    } catch (error) {
      this._log(db, { jobId, productId: job.product_id, action: 'HOME', command: 'HOME=0000', response: error.message, status: 'failed' });
      throw error;
    }
  }

  async resetJob(jobId, deviceId = null) {
    const db = this._db();
    const job = db.prepare('SELECT * FROM production_jobs WHERE id=?').get(jobId);
    if (!job) throw new Error('production_job_not_found');
    const device = this._resolvePlcDevice(db, deviceId || job.plc_device_id);
    this._requireRealConnected(this._snapshot(device.id));
    try {
      const result = await this.plcService.sendReset(device.id);
      const ackAt = this._nowIso();
      const confirmation = await this.plcService.waitForTelemetryAfter(device.id, ackAt);
      if (!confirmation?.telemetryFresh || confirmation.telemetry?.JobLoaded !== false) throw new Error('reset_not_confirmed');
      this._markNotLoaded(db, jobId);
      db.prepare("UPDATE production_jobs SET status='completed',updated_at=? WHERE id=?").run(this._nowIso(), jobId);
      this._log(db, { jobId, productId: job.product_id, action: 'RESET', command: 'RESET=0000', response: result.response, details: 'job_clear_confirmed_by_stat' });
      return { success: true, job: db.prepare('SELECT * FROM production_jobs WHERE id=?').get(jobId), plcResponse: result.response };
    } catch (error) {
      this._log(db, { jobId, productId: job.product_id, action: 'RESET', command: 'RESET=0000', response: error.message, status: 'failed' });
      throw error;
    }
  }

  async printJobLabel(jobId, printerId, copies = 1) {
    const db = this._db();
    const printerService = require('../printer/printerService');
    const job = db.prepare(`SELECT j.*,p.name product_name,p.barcode product_barcode,lt.name label_template_name
      FROM production_jobs j LEFT JOIN products p ON j.product_id=p.id
      LEFT JOIN label_templates lt ON j.label_template_id=lt.id WHERE j.id=?`).get(jobId);
    if (!job) throw new Error('production_job_not_found');
    const templateName = job.label_template_name || 'product-label';
    const variables = { productName: job.product_name || '', jobId: job.job_code,
      productionDate: new Date().toLocaleDateString('vi-VN'), barcode: job.product_barcode || '', quantity: job.target_revs };
    try {
      const printResult = await printerService.printFromTemplate(printerId, templateName, variables, copies, { productionJobId: jobId });
      this._log(db, { jobId, productId: job.product_id, action: 'PRINT', command: `template=${templateName}`, response: JSON.stringify(printResult) });
      return { success: true, job, printResult };
    } catch (error) {
      this._log(db, { jobId, productId: job.product_id, action: 'PRINT', command: `template=${templateName}`, response: error.message, status: 'failed' });
      throw error;
    }
  }
}

const workflowService = new WorkflowService();
module.exports = workflowService;
module.exports.WorkflowService = WorkflowService;
