const crypto = require('crypto');
const EventEmitter = require('events');
const config = require('../../config');
const logger = require('../../config/logger');
const { getDb } = require('../../models/database');
const demoAdapter = require('./demoPrinterAdapter');
const godexAdapter = require('./godexPrinterAdapter');
const renderer = require('./godexRenderer');

class PrinterService extends EventEmitter {
  constructor() {
    super();
    this.adapter = config.demoMode ? demoAdapter : godexAdapter;
    this.adapter.on('status', (event) => this._saveAndEmitStatus(event));
  }
  start() {
    getDb().prepare('UPDATE printers SET connection_status=?, updated_at=? WHERE is_active=1')
      .run(config.demoMode ? 'demo' : 'offline', new Date().toISOString());
    this.adapter.start();
    logger.info(`PrinterService started in ${config.demoMode ? 'DEMO' : 'REAL'} mode`);
  }
  stop() { this.adapter.stop(); }
  _printer(id) {
    const row = getDb().prepare('SELECT * FROM printers WHERE id = ? AND is_active = 1').get(id);
    if (!row) throw new Error('printer_not_found_or_inactive');
    return row;
  }
  _template(name) {
    const row = getDb().prepare('SELECT * FROM label_templates WHERE name = ? AND is_active = 1').get(name);
    if (!row) throw new Error(`template_not_found:${name}`);
    return row;
  }
  _saveAndEmitStatus(event) {
    const now = new Date().toISOString();
    getDb().prepare("UPDATE printers SET connection_status=?, last_connected=CASE WHEN ?='online' THEN ? ELSE last_connected END, updated_at=? WHERE id=?")
      .run(event.status, event.status, now, now, event.printerId);
    this.emit('status', event);
  }
  async printFromTemplate(printerId, templateName, variables = {}, copies = 1) {
    const printer = this._printer(printerId);
    const template = this._template(templateName);
    const language = printer.command_language || config.godex.commandLanguage;
    if (!config.demoMode && !(printer.model || config.godex.model)) throw new Error('printer_model_not_configured');
    if (!config.demoMode && !language) throw new Error('printer_language_not_configured');
    const payload = renderer.render(template, variables, language, { demo: config.demoMode });
    const configuredPrinter = { ...printer, model: printer.model || config.godex.model, command_language: language };
    return this._execute(configuredPrinter, templateName, payload, copies, variables);
  }
  async printTestLabel(printerId) {
    return this.printFromTemplate(printerId, 'product-label', {
      productName: 'TEST PRINT', jobId: 'TEST', productionDate: new Date().toLocaleDateString('vi-VN'), barcode: 'TEST123', quantity: 1,
    }, 1);
  }
  async _execute(printer, templateName, payload, copies, variables) {
    const db = getDb();
    const id = crypto.randomBytes(16).toString('hex');
    db.prepare("INSERT INTO print_jobs (id,printer_id,job_name,template_name,payload_content,copies,status,metadata,started_at) VALUES (?,?,?,?,?,?,'printing',?,?)")
      .run(id, printer.id, `Label-${Date.now()}`, templateName, payload, copies, JSON.stringify({ variables, mode: config.demoMode ? 'DEMO' : 'REAL' }), new Date().toISOString());
    try {
      const result = await this.adapter.print(printer, payload, copies);
      db.prepare("UPDATE print_jobs SET status='completed',completed_at=? WHERE id=?").run(new Date().toISOString(), id);
      return { success: true, jobId: id, ...result };
    } catch (error) {
      db.prepare("UPDATE print_jobs SET status='failed',error_message=? WHERE id=?").run(error.message, id);
      throw error;
    }
  }
  getPrintJobs({ printerId, status, limit = 50, offset = 0 } = {}) {
    let sql = 'SELECT pj.*,p.name printer_name,u.username FROM print_jobs pj LEFT JOIN printers p ON p.id=pj.printer_id LEFT JOIN users u ON u.id=pj.user_id WHERE 1=1';
    const args = [];
    if (printerId) { sql += ' AND pj.printer_id=?'; args.push(printerId); }
    if (status) { sql += ' AND pj.status=?'; args.push(status); }
    sql += ' ORDER BY pj.created_at DESC LIMIT ? OFFSET ?'; args.push(limit, offset);
    return getDb().prepare(sql).all(...args);
  }
  async getPrinterStatus(id) {
    const printer = this._printer(id);
    const configuredPrinter = {
      ...printer,
      model: printer.model || config.godex.model,
      command_language: printer.command_language || config.godex.commandLanguage,
    };
    const result = await this.adapter.getStatus(configuredPrinter);
    this._saveAndEmitStatus(result);
    return result;
  }
}
module.exports = new PrinterService();
