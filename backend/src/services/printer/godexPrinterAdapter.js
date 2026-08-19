const net = require('net');
const EventEmitter = require('events');
const config = require('../../config');
const logger = require('../../config/logger');
class GodexPrinterAdapter extends EventEmitter {
  validate(printer) {
    if (!printer.model) throw new Error('printer_model_not_configured');
    if (!printer.command_language) throw new Error('printer_language_not_configured');
    if (!printer.ip_address || !printer.port) throw new Error('printer_endpoint_not_configured');
  }
  connect(printer) {
    this.validate(printer);
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(config.godex.connectTimeoutMs);
      socket.once('connect', () => resolve(socket));
      socket.once('timeout', () => { socket.destroy(); reject(new Error('printer_connection_timeout')); });
      socket.once('error', (error) => { socket.destroy(); reject(new Error(`printer_connection_error:${error.message}`)); });
      socket.connect(printer.port, printer.ip_address);
    });
  }
  async disconnect(socket) { if (socket && !socket.destroyed) socket.end(); }
  async print(printer, payload, copies) {
    let socket;
    try {
      socket = await this.connect(printer);
      await new Promise((resolve, reject) => socket.write(payload, 'utf8', (error) => error ? reject(error) : resolve()));
      this.emit('status', { printerId: printer.id, status: 'online', mode: 'REAL' });
      return { accepted: true, simulated: false, mode: 'REAL', printerId: printer.id, copies };
    } catch (error) {
      this.emit('status', { printerId: printer.id, status: 'offline', mode: 'REAL', error: error.message });
      logger.error(`Godex printer ${printer.id} failed: ${error.message}`);
      throw error;
    } finally { await this.disconnect(socket); }
  }
  async getStatus(printer) {
    let socket;
    try { socket = await this.connect(printer); return { printerId: printer.id, name: printer.name, status: 'online', mode: 'REAL', isDemo: false }; }
    catch (error) { return { printerId: printer.id, name: printer.name, status: 'offline', mode: 'REAL', isDemo: false, error: error.message }; }
    finally { await this.disconnect(socket); }
  }
  start() { logger.info('Godex printer adapter started'); }
  stop() { logger.info('Godex printer adapter stopped'); }
}
module.exports = new GodexPrinterAdapter();
