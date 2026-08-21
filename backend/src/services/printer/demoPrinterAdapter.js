const EventEmitter = require('events');
// DEPRECATED: simulation-only adapter; never reports physical print completion.
class DemoPrinterAdapter extends EventEmitter {
  async print(printer, payload, copies) {
    const result = { accepted: true, simulated: true, mode: 'DEMO', printerId: printer.id, copies, payload };
    this.emit('status', { printerId: printer.id, status: 'demo', mode: 'DEMO' });
    return result;
  }
  async getStatus(printer) { return { printerId: printer.id, name: printer.name, status: 'demo', mode: 'DEMO', isDemo: true }; }
  start() {}
  stop() {}
}
module.exports = new DemoPrinterAdapter();
