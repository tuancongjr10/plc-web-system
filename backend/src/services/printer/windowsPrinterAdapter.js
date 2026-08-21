const EventEmitter = require('events');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { print, getPrinters } = require('pdf-to-printer');
const logger = require('../../config/logger');

const execFileAsync = promisify(execFile);
const MM_PER_INCH = 25.4;
const DIMENSION_TOLERANCE_MM = 0.5;
const PRINT_JOB_QUERY = `
$ErrorActionPreference = 'Stop'
@(
  Get-PrintJob -PrinterName $env:PLCWEB_PRINT_QUEUE |
    Select-Object ID,DocumentName,PrinterName,@{Name='JobStatus';Expression={$_.JobStatus.ToString()}},SubmittedTime,Size
) | ConvertTo-Json -Compress
`;

function labelDimensionsMm(label) {
  if (!label || !(Number(label.width) > 0) || !(Number(label.height) > 0)) {
    throw new Error('invalid_label_dimensions');
  }
  const unit = label.unit || 'inch';
  const factor = unit === 'inch' ? MM_PER_INCH : unit === 'mm' ? 1 : unit === 'pt' ? MM_PER_INCH / 72 : null;
  if (!factor) throw new Error(`invalid_label_unit:${unit}`);
  return { width: Number(label.width) * factor, height: Number(label.height) * factor };
}

function parsePaperSizeDimensions(name) {
  const normalized = String(name || '').toLowerCase().replace(/,/g, '.');
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(mm|cm|in(?:ch(?:es)?)?|\")?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|cm|in(?:ch(?:es)?)?|\")?/i);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[3]);
  const explicitUnit = match[2] || match[4];
  const unit = explicitUnit || (Math.max(first, second) <= 20 ? 'in' : 'mm');
  const factor = unit === 'mm' ? 1 : unit === 'cm' ? 10 : MM_PER_INCH;
  return { width: first * factor, height: second * factor };
}

function dimensionsMatch(candidate, target) {
  const close = (left, right) => Math.abs(left - right) <= Math.max(DIMENSION_TOLERANCE_MM, right * 0.01);
  return (close(candidate.width, target.width) && close(candidate.height, target.height))
    || (close(candidate.width, target.height) && close(candidate.height, target.width));
}

function resolvePaperSize(paperSizes, label) {
  const dimensions = labelDimensionsMm(label);
  const driverPaperSize = (paperSizes || []).find((name) => {
    const candidate = parsePaperSizeDimensions(name);
    return candidate && dimensionsMatch(candidate, dimensions);
  });
  return driverPaperSize || null;
}

function unverifiedPaperSizeWarning(label) {
  const unit = label?.unit || 'inch';
  return `paper_size_unverified: driver không khai báo hỗ trợ khổ ${label?.width}x${label?.height}${unit}, đã in theo khổ mặc định của driver — kiểm tra kích thước vật lý thủ công`;
}

class WindowsPrinterAdapter extends EventEmitter {
  constructor(dependencies = {}) {
    super();
    this.execFile = dependencies.execFile || execFileAsync;
    this.printPdf = dependencies.print || print;
    this.getPrinters = dependencies.getPrinters || getPrinters;
  }

  async listPrinters() {
    const printers = await this.getPrinters();
    return printers.map((printer) => ({
      queueName: printer.name,
      deviceId: printer.deviceId || null,
      driverName: null,
      portName: null,
      shared: null,
      status: 'UNKNOWN',
      configured: true,
      paperSizes: Array.isArray(printer.paperSizes) ? printer.paperSizes : [],
    }));
  }

  async getPrinterStatus(printer) {
    if (!printer.queue_name) {
      return { printerId: printer.id, configured: false, status: 'UNKNOWN', error: 'printer_queue_not_configured' };
    }
    try {
      const queues = await this.listPrinters();
      const queue = queues.find((item) => item.queueName === printer.queue_name);
      if (!queue) return { printerId: printer.id, queueName: printer.queue_name, configured: false, status: 'UNKNOWN' };
      // Queue discovery proves configuration only, not physical printer health.
      return { printerId: printer.id, ...queue, status: 'UNKNOWN' };
    } catch (error) {
      return { printerId: printer.id, queueName: printer.queue_name, configured: null, status: 'UNKNOWN', error: error.message };
    }
  }

  async printFile(pdfPath, queueName, options = {}) {
    if (!queueName || typeof queueName !== 'string') throw new Error('printer_queue_not_configured');
    const queues = await this.listPrinters();
    const queue = queues.find((item) => item.queueName === queueName);
    if (!queue) throw new Error('printer_queue_not_found');
    const copies = Math.max(1, Math.min(1000, Number(options.copies) || 1));
    const paperSize = resolvePaperSize(queue.paperSizes, options.label);
    const warning = paperSize ? null : unverifiedPaperSizeWarning(options.label);
    if (warning) logger.warn(`${warning}; queue=${queueName}`);
    const printOptions = { printer: queueName, copies, scale: 'noscale', silent: true };
    if (paperSize) printOptions.paperSize = paperSize;
    // pdf-to-printer bundles SumatraPDF 3.4.6, which cannot disable auto-rotation (added in 3.5).
    // If rotation returns after paperSize is correct, upgrade SumatraPDF/pdf-to-printer before adding orientation.
    let printPromise;
    try {
      // Start SumatraPDF now, but do not keep the HTTP request open while an
      // interactive driver (for example a PDF Save As dialog) is still active.
      printPromise = this.printPdf(pdfPath, printOptions);
    } catch (error) {
      if (warning) error.paperSizeWarning = warning;
      throw error;
    }
    const completion = Promise.resolve(printPromise).then(
      () => ({ success: true }),
      (error) => {
        if (warning) error.paperSizeWarning = warning;
        return { success: false, error };
      },
    );
    return {
      accepted: true,
      submitted: true,
      queueName,
      copies,
      paperSize,
      warning,
      mode: 'WINDOWS_QUEUE',
      documentName: path.basename(pdfPath),
      spoolerJobId: null,
      completion,
    };
  }

  async getPrintJobs(queueName, options = {}) {
    if (!queueName || typeof queueName !== 'string') throw new Error('printer_queue_not_configured');
    const timeout = Math.max(250, Math.min(10000, Number(options.timeoutMs) || 10000));
    const { stdout } = await this.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PRINT_JOB_QUERY], {
      env: { ...process.env, PLCWEB_PRINT_QUEUE: queueName },
      windowsHide: true,
      timeout,
      maxBuffer: 1024 * 1024,
      signal: options.signal,
    });
    if (!String(stdout || '').trim()) return [];
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((job) => ({
      jobId: job.ID ?? null,
      documentName: job.DocumentName ?? null,
      printerName: job.PrinterName ?? queueName,
      jobStatus: job.JobStatus ?? null,
      submittedTime: job.SubmittedTime ?? null,
      size: job.Size ?? null,
    }));
  }

  async cancelPrintJob() { throw new Error('printer_job_cancel_not_supported'); }
  start() { logger.info('Windows print queue adapter started'); }
  stop() { logger.info('Windows print queue adapter stopped'); }
}

module.exports = new WindowsPrinterAdapter();
module.exports.WindowsPrinterAdapter = WindowsPrinterAdapter;
module.exports.resolvePaperSize = resolvePaperSize;
