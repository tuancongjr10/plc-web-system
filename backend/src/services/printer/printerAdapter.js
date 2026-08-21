/**
 * Internal printer adapter contract.
 *
 * Implementations provide:
 * - listPrinters()
 * - getPrinterStatus(printer)
 * - printFile(pdfPath, queueName, options)
 * - getPrintJobs(queueName) when supported
 * - cancelPrintJob(queueName, jobId) when supported
 */
class PrinterAdapter {
  async listPrinters() { throw new Error('printer_adapter_not_implemented'); }
  async getPrinterStatus() { throw new Error('printer_adapter_not_implemented'); }
  async printFile() { throw new Error('printer_adapter_not_implemented'); }
  async getPrintJobs() { return []; }
  async cancelPrintJob() { throw new Error('printer_job_cancel_not_supported'); }
  start() {}
  stop() {}
}

module.exports = PrinterAdapter;
