const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const logger = require('../../config/logger');
const { getDb } = require('../../models/database');
const windowsAdapter = require('./windowsPrinterAdapter');
const demoAdapter = require('./demoPrinterAdapter');
const legacyAdapter = require('./godexPrinterAdapter');
const legacyRenderer = require('./godexRenderer');
const labelRenderer = require('./labelRenderer');

const WINDOWS_QUEUE = 'WINDOWS_QUEUE';
const RAW_TCP_LEGACY = 'RAW_TCP_LEGACY';
const TRACKING_TIMEOUT_MS = 15000;
const TRACKING_POLL_INTERVAL_MS = 750;
const RECONCILIATION_POLL_INTERVAL_MS = 5000;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error('printer_tracking_aborted');
      error.name = 'AbortError';
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

class PrinterService extends EventEmitter {
  constructor(dependencies = {}) {
    super();
    this.dbProvider = dependencies.dbProvider || getDb;
    this.windowsAdapter = dependencies.windowsAdapter || windowsAdapter;
    this.demoAdapter = dependencies.demoAdapter || demoAdapter;
    this.legacyAdapter = dependencies.legacyAdapter || legacyAdapter;
    this.legacyRenderer = dependencies.legacyRenderer || legacyRenderer;
    this.labelRenderer = dependencies.labelRenderer || labelRenderer;
    this.labelRetentionMs = dependencies.labelRetentionMs || config.printer.labelTempRetentionHours * 60 * 60 * 1000;
    this.cleanupIntervalMs = dependencies.cleanupIntervalMs || 60 * 60 * 1000;
    this.cleanupTimer = null;
    this.cleanupRun = null;
    this.trackingTimeoutMs = dependencies.trackingTimeoutMs ?? TRACKING_TIMEOUT_MS;
    this.trackingPollIntervalMs = dependencies.trackingPollIntervalMs ?? TRACKING_POLL_INTERVAL_MS;
    this.reconciliationPollIntervalMs = dependencies.reconciliationPollIntervalMs ?? RECONCILIATION_POLL_INTERVAL_MS;
    this.reconcileMaxMs = dependencies.reconcileMaxMs ?? config.printer.spoolerReconcileMaxHours * 60 * 60 * 1000;
    this.sleep = dependencies.sleep || sleep;
    this.now = dependencies.now || Date.now;
    this.activeTrackers = new Map();
    for (const adapter of [this.windowsAdapter, this.demoAdapter, this.legacyAdapter]) {
      adapter.on('status', (event) => this._saveAndEmitStatus(event));
    }
  }

  _db() { return this.dbProvider(); }

  start() {
    this._db().prepare("UPDATE printers SET connection_status='unknown', updated_at=? WHERE is_enabled=1").run(new Date().toISOString());
    this.windowsAdapter.start();
    this.cleanupExpiredLabelFiles().catch((error) => logger.warn(`Label temp cleanup failed: ${error.message}`));
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupExpiredLabelFiles().catch((error) => logger.warn(`Label temp cleanup failed: ${error.message}`));
      }, this.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
    this._reconcileWindowsJobsOnStart();
    logger.info('PrinterService started with WINDOWS_QUEUE as the default print mode');
  }

  stop() {
    this.windowsAdapter.stop();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    for (const tracker of this.activeTrackers.values()) tracker.controller.abort();
    this.activeTrackers.clear();
  }

  _reconcileWindowsJobsOnStart() {
    const rows = this._db().prepare(`SELECT id,status,queue_name_snapshot,metadata FROM print_jobs
      WHERE status IN ('submitted','printing')`).all();
    for (const row of rows) {
      let metadata = {};
      try { metadata = JSON.parse(row.metadata || '{}'); } catch { metadata = {}; }
      const documentName = metadata.spoolerDocumentName;
      if (!row.queue_name_snapshot || !documentName) {
        this._db().prepare("UPDATE print_jobs SET status='unknown' WHERE id=? AND status IN ('submitted','printing')").run(row.id);
        logger.warn(`Print job ${row.id} cannot be reconciled after restart: missing correlation evidence`);
        continue;
      }
      this._launchWindowsJobTracker(row.id, row.queue_name_snapshot, documentName, {
        observed: metadata.spoolerObserved === true,
      });
    }
  }

  async cleanupExpiredLabelFiles() {
    if (this.cleanupRun) return this.cleanupRun;
    this.cleanupRun = this._cleanupExpiredLabelFiles();
    try {
      return await this.cleanupRun;
    } finally {
      this.cleanupRun = null;
    }
  }

  async _cleanupExpiredLabelFiles() {
    const deleted = await this.labelRenderer.cleanupExpired(this.labelRetentionMs);
    const clearReference = this._db().prepare('UPDATE print_jobs SET rendered_file=NULL WHERE rendered_file=?');
    for (const filePath of deleted) clearReference.run(filePath);

    const references = this._db().prepare('SELECT DISTINCT rendered_file FROM print_jobs WHERE rendered_file IS NOT NULL').all();
    for (const { rendered_file: filePath } of references) {
      if (!this.labelRenderer.isManagedPath(filePath)) {
        logger.warn(`Skipped unmanaged rendered_file path: ${filePath}`);
        continue;
      }
      if (!fs.existsSync(filePath)) {
        logger.warn(`Clearing missing rendered_file reference: ${filePath}`);
        clearReference.run(filePath);
      }
    }
    return { deleted: deleted.length };
  }

  _printer(id) {
    const row = this._db().prepare('SELECT * FROM printers WHERE id = ? AND is_active = 1 AND is_enabled = 1').get(id);
    if (!row) throw new Error('printer_not_found_or_inactive');
    return row;
  }

  _template(name) {
    const row = this._db().prepare('SELECT * FROM label_templates WHERE name = ? AND is_active = 1').get(name);
    if (!row) throw new Error(`template_not_found:${name}`);
    return row;
  }

  _saveAndEmitStatus(event) {
    if (!event?.printerId) return;
    const now = new Date().toISOString();
    this._db().prepare('UPDATE printers SET connection_status=?, last_seen_at=?, last_error=?, updated_at=? WHERE id=?')
      .run(String(event.status || 'UNKNOWN').toLowerCase(), now, event.error || null, now, event.printerId);
    this.emit('status', event);
  }

  async listAvailableQueues() { return this.windowsAdapter.listPrinters(); }

  async printFromTemplate(printerId, templateName, variables = {}, copies = 1, context = {}) {
    const printer = this._printer(printerId);
    const template = this._template(templateName);
    const mode = printer.print_mode || WINDOWS_QUEUE;
    if (mode === WINDOWS_QUEUE) return this._executeWindows(printer, template, variables, copies, context);
    if (mode === RAW_TCP_LEGACY) return this._executeLegacy(printer, template, variables, copies, context);
    throw new Error(`printer_mode_not_supported:${mode}`);
  }

  async printTestLabel(printerId, context = {}) {
    return this.printFromTemplate(printerId, 'product-label', {
      productName: 'TEST PRINT', jobId: 'TEST', productionDate: new Date().toLocaleDateString('vi-VN'), barcode: 'TEST123', quantity: 1,
    }, 1, context);
  }

  _createJob(printer, template, copies, variables, context, renderedFile = null) {
    const id = crypto.randomBytes(16).toString('hex');
    const metadata = JSON.stringify({ variables, mode: printer.print_mode || WINDOWS_QUEUE });
    this._db().prepare(`INSERT INTO print_jobs
      (id,production_job_id,printer_id,user_id,job_name,template_id,template_name,queue_name_snapshot,rendered_file,payload_content,copies,status,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?)`)
      .run(id, context.productionJobId || null, printer.id, context.userId || null, `Label-${Date.now()}`,
        template.id || null, template.name, printer.queue_name || null, renderedFile, renderedFile || '', copies, metadata);
    return id;
  }

  _updateJobMetadata(jobId, additions) {
    const row = this._db().prepare('SELECT metadata FROM print_jobs WHERE id=?').get(jobId);
    let metadata = {};
    try { metadata = JSON.parse(row?.metadata || '{}'); } catch { metadata = {}; }
    this._db().prepare('UPDATE print_jobs SET metadata=? WHERE id=?').run(JSON.stringify({ ...metadata, ...additions }), jobId);
  }

  _isCorrelatedDocument(actual, expected) {
    if (!actual || !expected) return false;
    const normalized = (value) => path.basename(String(value)).toLowerCase().replace(/\.pdf$/i, '');
    return normalized(actual) === normalized(expected);
  }

  _spoolerState(jobStatus) {
    const status = String(jobStatus || '').toLowerCase();
    if (/error|offline|paperout|blocked|userintervention|deleted/.test(status)) return 'failed';
    if (/printing|processing|spooling/.test(status)) return 'printing';
    return 'observed';
  }

  _launchWindowsJobTracker(jobId, queueName, documentName, options = {}) {
    const existing = this.activeTrackers.get(jobId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const tracker = { controller, promise: null };
    tracker.promise = this._trackWindowsJob(jobId, queueName, documentName, {
      ...options,
      continueAfterInitialWindow: true,
      signal: controller.signal,
    }).catch((error) => {
      if (error.name !== 'AbortError') {
        logger.error(`Background print tracker failed for ${jobId}: ${error.message}`);
        try {
          this._db().prepare("UPDATE print_jobs SET status='unknown',error_message=? WHERE id=? AND status IN ('submitted','printing')")
            .run(`spooler_tracker_failed:${error.message}`, jobId);
        } catch (updateError) {
          logger.error(`Could not persist background tracker failure for ${jobId}: ${updateError.message}`);
        }
      }
      return 'stopped';
    }).finally(() => {
      if (this.activeTrackers.get(jobId) === tracker) this.activeTrackers.delete(jobId);
    });
    this.activeTrackers.set(jobId, tracker);
    return tracker.promise;
  }

  async _trackWindowsJob(jobId, queueName, documentName, options = {}) {
    const trackingStartedAt = this.now();
    const submittedAtRaw = this._db().prepare('SELECT submitted_at FROM print_jobs WHERE id=?').pluck().get(jobId);
    const submittedAt = submittedAtRaw ? new Date(submittedAtRaw).getTime() : NaN;
    const horizonStartedAt = Number.isFinite(submittedAt) && submittedAt >= 0 && submittedAt <= trackingStartedAt
      ? submittedAt
      : trackingStartedAt;
    const reconciliationDeadline = horizonStartedAt + this.reconcileMaxMs;
    const deadline = trackingStartedAt + this.trackingTimeoutMs;
    let observed = options.observed === true;
    let lastState = observed ? 'printing' : 'submitted';
    let reconciliationMode = false;
    let queryFailureSince = null;
    while (true) {
      if (options.signal?.aborted) {
        const error = new Error('printer_tracking_aborted');
        error.name = 'AbortError';
        throw error;
      }
      if (observed && lastState === 'printing' && this.now() >= reconciliationDeadline) {
        this._db().prepare("UPDATE print_jobs SET status='unknown',error_message='spooler_reconcile_timeout' WHERE id=? AND status IN ('submitted','printing')")
          .run(jobId);
        return 'unknown';
      }
      let jobs;
      try {
        jobs = await this.windowsAdapter.getPrintJobs(queueName, {
          timeoutMs: Math.min(10000, Math.max(250, deadline - this.now())),
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          const abortError = new Error('printer_tracking_aborted');
          abortError.name = 'AbortError';
          throw abortError;
        }
        logger.warn(`Print spooler query failed for ${jobId}; will retry: ${error.message}`);
        queryFailureSince ??= this.now();
        const failureDeadline = reconciliationMode ? queryFailureSince + this.trackingTimeoutMs : deadline;
        if (this.now() >= failureDeadline) {
          this._db().prepare("UPDATE print_jobs SET status='unknown',error_message=? WHERE id=? AND status IN ('submitted','printing')")
            .run(`spooler_query_failed:${error.message}`, jobId);
          return 'unknown';
        }
        const retryDelay = reconciliationMode ? this.reconciliationPollIntervalMs : this.trackingPollIntervalMs;
        await this.sleep(Math.min(retryDelay, Math.max(0, failureDeadline - this.now())), options.signal);
        continue;
      }
      queryFailureSince = null;

      const spoolerJob = jobs.find((job) => this._isCorrelatedDocument(job.documentName, documentName));
      if (spoolerJob) {
        observed = true;
        lastState = this._spoolerState(spoolerJob.jobStatus);
        this._updateJobMetadata(jobId, {
          spoolerDocumentName: documentName,
          spoolerJobId: spoolerJob.jobId ?? null,
          spoolerObserved: true,
        });
        if (lastState === 'failed') {
          const message = `windows_spooler:${spoolerJob.jobStatus || 'error'}`;
          this._db().prepare("UPDATE print_jobs SET status='failed',error_message=? WHERE id=? AND status IN ('submitted','printing')")
            .run(message, jobId);
          return 'failed';
        }
        if (lastState === 'printing') {
          this._db().prepare("UPDATE print_jobs SET status='printing' WHERE id=? AND status IN ('submitted','printing')").run(jobId);
        }
      } else if (observed) {
        // completed means: this exact job was observed in Windows spooler, then
        // disappeared from that queue without an observed error. It is not
        // confirmation that a physical label was printed.
        this._db().prepare("UPDATE print_jobs SET status='completed',completed_at=? WHERE id=? AND status IN ('submitted','printing')")
          .run(new Date().toISOString(), jobId);
        return 'completed';
      }

      if (this.now() >= deadline) {
        if (observed && lastState === 'printing' && options.continueAfterInitialWindow) {
          reconciliationMode = true;
        } else if (observed && lastState === 'printing') {
          return 'printing';
        } else {
          this._db().prepare("UPDATE print_jobs SET status='unknown' WHERE id=? AND status IN ('submitted','printing')").run(jobId);
          return 'unknown';
        }
      }
      const pollInterval = reconciliationMode ? this.reconciliationPollIntervalMs : this.trackingPollIntervalMs;
      await this.sleep(Math.min(pollInterval, Math.max(0, reconciliationMode ? pollInterval : deadline - this.now())), options.signal);
    }
  }

  async _executeWindows(printer, template, variables, copies, context) {
    let rendered;
    const jobId = this._createJob(printer, template, copies, variables, context);
    try {
      rendered = await this.labelRenderer.renderLabelPdf(template, variables, { correlationId: jobId });
      this._db().prepare("UPDATE print_jobs SET status='rendered',rendered_at=?,rendered_file=? WHERE id=?")
        .run(new Date().toISOString(), rendered.pdfPath, jobId);
      const result = await this.windowsAdapter.printFile(rendered.pdfPath, printer.queue_name, { copies, label: rendered.label });
      const { completion, ...submittedResult } = result;
      this._db().prepare("UPDATE print_jobs SET status='submitted',submitted_at=? WHERE id=?").run(new Date().toISOString(), jobId);
      this._updateJobMetadata(jobId, {
        spoolerDocumentName: result.documentName || path.basename(rendered.pdfPath),
        ...(result.warning ? { paperSizeWarning: result.warning } : {}),
      });
      this._saveAndEmitStatus({ printerId: printer.id, queueName: printer.queue_name, configured: true, status: 'UNKNOWN' });
      if (result.documentName) this._launchWindowsJobTracker(jobId, printer.queue_name, result.documentName);
      if (completion?.then) {
        completion.then((outcome) => {
          if (outcome?.success) return;
          const error = outcome?.error || new Error('windows_print_process_failed');
          if (error.paperSizeWarning) this._updateJobMetadata(jobId, { paperSizeWarning: error.paperSizeWarning });
          this._db().prepare("UPDATE print_jobs SET status='failed',error_message=? WHERE id=? AND status IN ('submitted','printing','unknown')")
            .run(error.message, jobId);
          this._db().prepare('UPDATE printers SET last_error=?,updated_at=? WHERE id=?')
            .run(error.message, new Date().toISOString(), printer.id);
          logger.error(`Windows print process failed after submission for job ${jobId}: ${error.message}`);
        }).catch((error) => logger.error(`Windows print completion watcher failed for job ${jobId}: ${error.message}`));
      }
      return { success: true, jobId, status: 'submitted', ...submittedResult };
    } catch (error) {
      if (error.paperSizeWarning) this._updateJobMetadata(jobId, { paperSizeWarning: error.paperSizeWarning });
      this._db().prepare("UPDATE print_jobs SET status='failed',error_message=? WHERE id=?").run(error.message, jobId);
      this._db().prepare('UPDATE printers SET last_error=?,updated_at=? WHERE id=?').run(error.message, new Date().toISOString(), printer.id);
      throw error;
    }
  }

  async _executeLegacy(printer, template, variables, copies, context) {
    logger.warn(`Using deprecated RAW_TCP_LEGACY printer path for ${printer.id}`);
    const jobId = this._createJob(printer, template, copies, variables, context);
    try {
      const payload = this.legacyRenderer.render(template, variables, printer.command_language || config.godex.commandLanguage, { demo: config.demoMode });
      this._db().prepare("UPDATE print_jobs SET status='rendered',rendered_at=? WHERE id=?").run(new Date().toISOString(), jobId);
      const adapter = config.demoMode ? this.demoAdapter : this.legacyAdapter;
      const result = await adapter.print(printer, payload, copies);
      this._db().prepare("UPDATE print_jobs SET status='submitted',submitted_at=? WHERE id=?").run(new Date().toISOString(), jobId);
      return { success: true, jobId, status: 'submitted', deprecated: true, ...result };
    } catch (error) {
      this._db().prepare("UPDATE print_jobs SET status='failed',error_message=? WHERE id=?").run(error.message, jobId);
      throw error;
    }
  }

  getPrintJobs({ printerId, status, limit = 50, offset = 0 } = {}) {
    let sql = 'SELECT pj.*,p.name printer_name,u.username FROM print_jobs pj LEFT JOIN printers p ON p.id=pj.printer_id LEFT JOIN users u ON u.id=pj.user_id WHERE 1=1';
    const args = [];
    if (printerId) { sql += ' AND pj.printer_id=?'; args.push(printerId); }
    if (status) { sql += ' AND pj.status=?'; args.push(String(status).toLowerCase()); }
    sql += ' ORDER BY pj.created_at DESC LIMIT ? OFFSET ?'; args.push(Number(limit) || 50, Number(offset) || 0);
    return this._db().prepare(sql).all(...args);
  }

  async getPrinterStatus(id) {
    const printer = this._printer(id);
    if ((printer.print_mode || WINDOWS_QUEUE) === RAW_TCP_LEGACY) {
      const result = config.demoMode ? await this.demoAdapter.getStatus(printer) : await this.legacyAdapter.getStatus(printer);
      this._saveAndEmitStatus(result);
      return { ...result, configured: Boolean(printer.ip_address && printer.port), deprecated: true };
    }
    const result = await this.windowsAdapter.getPrinterStatus(printer);
    this._saveAndEmitStatus(result);
    return result;
  }
}

const printerService = new PrinterService();
module.exports = printerService;
module.exports.PrinterService = PrinterService;
