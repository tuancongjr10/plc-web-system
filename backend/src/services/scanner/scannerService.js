const EventEmitter = require('events');
const logger = require('../../config/logger');
const { getDb } = require('../../models/database');

const ALLOWED_SOURCES = new Set(['camera', 'usb', 'network', 'ethernet', 'manual']);

/**
 * Barcode / QR Code Scanner Service
 * Sources:
 *  - USB HID / keyboard wedge (scanSource = 'usb')
 *  - Manual typed input (mapped to 'usb' for compatibility)
 *  - Camera/Webcam via browser (scanSource = 'camera')
 *  - Ethernet / network scanners (scanSource = 'network') — ingest API is ready;
 *    transport-specific drivers can be added later without changing workflow.
 */
class ScannerService extends EventEmitter {
  constructor() {
    super();
    this.pendingScans = new Map();
    this.scanTimeouts = new Map();
    this.ethernetAdapters = new Map();
  }

  normalizeScanSource(scanSource) {
    const src = String(scanSource || 'usb').toLowerCase();
    if (src === 'ethernet') return 'network';
    if (src === 'manual' || src === 'keyboard' || src === 'hid') return 'usb';
    if (ALLOWED_SOURCES.has(src)) return src;
    return 'usb';
  }

  /**
   * Register a future Ethernet scanner adapter.
   * Adapter shape: { id, ip, port, start(), stop() }
   * Does not invent a fake protocol — start() must be implemented by the adapter.
   */
  registerEthernetScanner(adapter) {
    if (!adapter || !adapter.id) {
      throw new Error('Ethernet scanner adapter requires an id');
    }
    if (typeof adapter.start !== 'function') {
      throw new Error('Ethernet scanner adapter is not implemented yet (missing start())');
    }
    this.ethernetAdapters.set(adapter.id, adapter);
    logger.info(`Ethernet scanner adapter registered: ${adapter.id} (${adapter.ip || 'n/a'}:${adapter.port || 'n/a'})`);
    return { registered: true, id: adapter.id };
  }

  /**
   * Ingest a barcode from an Ethernet / network scanner (HTTP webhook or future TCP client).
   */
  async ingestEthernetScan(payload, userId = null) {
    return this.processScanResult({
      ...payload,
      scanSource: 'network',
      userId,
    });
  }

  async processScanResult(scanData) {
    const {
      barcodeData,
      barcodeType,
      rawImage,
      scanSource = 'usb',
      userId = null,
    } = scanData;

    if (!barcodeData) {
      throw new Error('Barcode data is required');
    }

    const db = getDb();
    const timestamp = new Date().toISOString();
    const source = this.normalizeScanSource(scanSource);

    const scanId = require('crypto').randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO scan_records (id, user_id, scan_source, barcode_type, barcode_data, raw_image, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(scanId, userId, source, barcodeType, barcodeData, rawImage || null, timestamp);

    logger.info(`Scan recorded: [${barcodeType}] ${barcodeData} source=${source} user=${userId || 'anonymous'}`);

    const processResult = await this._processBarcode(barcodeData, barcodeType, userId);

    db.prepare(`
      UPDATE scan_records SET processed = 1, process_result = ? WHERE id = ?
    `).run(JSON.stringify(processResult), scanId);

    this.emit('scan:processed', {
      scanId,
      barcodeData,
      barcodeType,
      processResult,
      timestamp,
    });

    if (this.pendingScans.has('active')) {
      const { resolve } = this.pendingScans.get('active');
      resolve({ scanId, barcodeData, barcodeType, processResult });
      this.pendingScans.delete('active');
      if (this.scanTimeouts.has('active')) {
        clearTimeout(this.scanTimeouts.get('active'));
        this.scanTimeouts.delete('active');
      }
    }

    return { scanId, barcodeData, barcodeType, processResult, timestamp };
  }

  async _processBarcode(barcodeData, barcodeType, userId = null) {
    const workflowService = require('../workflow/workflowService');
    try {
      return await workflowService.handleScan(barcodeData, userId);
    } catch (err) {
      logger.error(`Error in scanner process workflow: ${err.message}`);
      return {
        action: 'lookup',
        status: 'failed',
        error: err.message,
        data: {
          raw: barcodeData,
          message: err.message,
        },
      };
    }
  }

  waitForScan(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (this.pendingScans.has('active')) {
        const existing = this.pendingScans.get('active');
        existing.reject(new Error('Scan cancelled: new scan requested'));
      }

      this.pendingScans.set('active', { resolve, reject });

      const timer = setTimeout(() => {
        if (this.pendingScans.has('active')) {
          this.pendingScans.delete('active');
          reject(new Error('Scan timeout'));
        }
      }, timeoutMs);

      this.scanTimeouts.set('active', timer);
    });
  }

  getScanHistory(filters = {}) {
    const db = getDb();
    const { userId, barcodeType, limit = 50, offset = 0, dateFrom, dateTo } = filters;

    let query = `
      SELECT sr.*, u.username
      FROM scan_records sr
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (userId) { query += ' AND sr.user_id = ?'; params.push(userId); }
    if (barcodeType) { query += ' AND sr.barcode_type = ?'; params.push(barcodeType); }
    if (dateFrom) { query += ' AND sr.created_at >= ?'; params.push(dateFrom); }
    if (dateTo) { query += ' AND sr.created_at <= ?'; params.push(dateTo); }

    query += ' ORDER BY sr.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return db.prepare(query).all(...params);
  }

  getScanStats(hours = 24) {
    const db = getDb();
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    return {
      total: db.prepare('SELECT COUNT(*) as count FROM scan_records WHERE created_at >= ?').get(since).count,
      byType: db.prepare(`
        SELECT barcode_type, COUNT(*) as count
        FROM scan_records WHERE created_at >= ?
        GROUP BY barcode_type
      `).all(since),
      byHour: db.prepare(`
        SELECT strftime('%H', created_at) as hour, COUNT(*) as count
        FROM scan_records WHERE created_at >= ?
        GROUP BY hour ORDER BY hour
      `).all(since),
    };
  }
}

const scannerService = new ScannerService();
module.exports = scannerService;
