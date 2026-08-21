const crypto = require('crypto');
const path = require('path');
const bwipjs = require('bwip-js');
const PDFDocument = require('pdfkit');
const { getDb } = require('../../models/database');

const TRACE_PREFIX = 'DOC-';
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function traceCodeFromSha256(sha256) {
  return `${TRACE_PREFIX}${String(sha256).slice(0, 16).toUpperCase()}`;
}

function safeDownloadName(originalFileName) {
  const originalBase = path.parse(path.basename(String(originalFileName || 'document.pdf'))).name;
  const asciiBase = originalBase.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  return `QR_${asciiBase || 'document'}.pdf`;
}

function renderQrPdf({ qrPng, traceCode, originalFileName, productId, productionJobId }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [288, 288], margin: 18, info: { Title: `Trace QR ${traceCode}` } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.font('Helvetica-Bold').fontSize(12).text('PDF Trace QR', 18, 10, { width: 252, align: 'center' });
    doc.image(qrPng, 58, 28, { width: 172, height: 172 });
    doc.font('Helvetica-Bold').fontSize(11).text(traceCode, 18, 204, { width: 252, align: 'center' });
    doc.font('Helvetica').fontSize(8).text(`File: ${path.basename(originalFileName)}`, 18, 219, { width: 252, align: 'center', ellipsis: true });
    if (productId) doc.text(`Product ID: ${productId}`, 18, 231, { width: 252, align: 'center', ellipsis: true });
    if (productionJobId) doc.text(`Job ID: ${productionJobId}`, 18, productId ? 243 : 231, { width: 252, align: 'center', ellipsis: true });
    doc.end();
  });
}

class DocumentTraceService {
  constructor(dependencies = {}) {
    this.dbProvider = dependencies.dbProvider || getDb;
    this.qrEncoder = dependencies.qrEncoder || ((options) => bwipjs.toBuffer(options));
  }

  _db() { return this.dbProvider(); }

  _validatePdf({ buffer, originalFileName, mimeType }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw requestError('pdf_file_required');
    if (String(mimeType || '').toLowerCase() !== 'application/pdf') throw requestError('invalid_pdf_mime_type');
    if (path.extname(String(originalFileName || '')).toLowerCase() !== '.pdf') throw requestError('invalid_pdf_extension');
    if (buffer.length < PDF_MAGIC.length || !buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      throw requestError('invalid_pdf_content');
    }
  }

  _validateLinks(productId, productionJobId) {
    const db = this._db();
    if (productId && !db.prepare('SELECT id FROM products WHERE id=?').get(productId)) throw requestError('product_not_found');
    if (productionJobId && !db.prepare('SELECT id FROM production_jobs WHERE id=?').get(productionJobId)) throw requestError('production_job_not_found');
  }

  async generateTraceQr({ buffer, originalFileName, mimeType, productId = null, productionJobId = null, description = null, userId = null }) {
    this._validatePdf({ buffer, originalFileName, mimeType });
    this._validateLinks(productId, productionJobId);
    if (description && String(description).length > 1000) throw requestError('description_too_long');

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const traceCode = traceCodeFromSha256(sha256);
    const db = this._db();
    const collision = db.prepare('SELECT sha256 FROM document_traces WHERE trace_code=?').get(traceCode);
    if (collision && collision.sha256 !== sha256) throw requestError('trace_code_collision', 409);

    const qrPng = await this.qrEncoder({
      bcid: 'qrcode',
      text: traceCode,
      scale: 8,
      padding: 4,
      eclevel: 'M',
      backgroundcolor: 'FFFFFF',
    });
    const pdfBuffer = await renderQrPdf({ qrPng, traceCode, originalFileName, productId, productionJobId });
    db.prepare(`INSERT INTO document_traces
      (trace_code,original_file_name,sha256,file_size,description,product_id,production_job_id,uploaded_by)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(trace_code) DO UPDATE SET
        description=COALESCE(excluded.description,document_traces.description),
        product_id=COALESCE(excluded.product_id,document_traces.product_id),
        production_job_id=COALESCE(excluded.production_job_id,document_traces.production_job_id)`).run(
      traceCode,
      path.basename(originalFileName),
      sha256,
      buffer.length,
      description ? String(description).trim() : null,
      productId || null,
      productionJobId || null,
      userId || null,
    );
    return {
      traceCode,
      sha256,
      fileSize: buffer.length,
      originalFileName: path.basename(originalFileName),
      downloadFileName: safeDownloadName(originalFileName),
      pdfBuffer,
      qrPng,
    };
  }

  lookup(traceCode) {
    if (!/^DOC-[0-9A-F]{16}$/.test(String(traceCode || '').toUpperCase())) throw requestError('invalid_trace_code');
    const row = this._db().prepare(`SELECT
      dt.trace_code,dt.original_file_name,dt.sha256,dt.file_size,dt.description,dt.uploaded_at,
      p.id product_id,p.barcode product_barcode,p.name product_name,
      j.id production_job_id,j.job_code,j.status job_status
      FROM document_traces dt
      LEFT JOIN products p ON p.id=dt.product_id
      LEFT JOIN production_jobs j ON j.id=dt.production_job_id
      WHERE dt.trace_code=?`).get(String(traceCode).toUpperCase());
    if (!row) throw requestError('trace_code_not_found', 404);
    return {
      traceCode: row.trace_code,
      originalFileName: row.original_file_name,
      sha256: row.sha256,
      fileSize: row.file_size,
      description: row.description,
      uploadedAt: row.uploaded_at,
      product: row.product_id ? { id: row.product_id, barcode: row.product_barcode, name: row.product_name } : null,
      productionJob: row.production_job_id ? { id: row.production_job_id, jobCode: row.job_code, status: row.job_status } : null,
    };
  }
}

const documentTraceService = new DocumentTraceService();
module.exports = documentTraceService;
module.exports.DocumentTraceService = DocumentTraceService;
module.exports.traceCodeFromSha256 = traceCodeFromSha256;
module.exports.safeDownloadName = safeDownloadName;
