const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const PDFDocument = require('pdfkit');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const { DocumentTraceService, traceCodeFromSha256 } = require('../src/services/traceability/documentTraceService');

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE products (id TEXT PRIMARY KEY,barcode TEXT,name TEXT);
    CREATE TABLE production_jobs (id TEXT PRIMARY KEY,job_code TEXT,status TEXT);
    CREATE TABLE document_traces (
      trace_code TEXT PRIMARY KEY,original_file_name TEXT NOT NULL,sha256 TEXT NOT NULL UNIQUE,
      file_size INTEGER NOT NULL,description TEXT,product_id TEXT REFERENCES products(id),
      production_job_id TEXT REFERENCES production_jobs(id),uploaded_by TEXT REFERENCES users(id),
      uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO users VALUES ('user-1');
    INSERT INTO products VALUES ('product-2','PROD-002','Product 002');
    INSERT INTO production_jobs VALUES ('job-2','JOB-002','created');
  `);
  return db;
}

function createContentPdf(filePath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const output = fs.createWriteStream(filePath, { flags: 'wx' });
    output.on('finish', resolve);
    output.on('error', reject);
    doc.on('error', reject);
    doc.pipe(output);
    doc.fontSize(18).text('Signal Processing 2907 - immutable source document');
    doc.end();
  });
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('PDF -> Trace QR preserves source, decodes exact TraceCode, and supports metadata lookup', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-document-trace-test-'));
  const inputPath = path.join(tempDir, 'Signal_Processing_2907.pdf');
  const outputPath = path.join(tempDir, 'QR_Signal_Processing_2907.pdf');
  const db = createDb();
  try {
    await createContentPdf(inputPath);
    const beforeSize = fs.statSync(inputPath).size;
    const beforeHash = sha256File(inputPath);
    const service = new DocumentTraceService({ dbProvider: () => db });
    const result = await service.generateTraceQr({
      buffer: fs.readFileSync(inputPath),
      originalFileName: path.basename(inputPath),
      mimeType: 'application/pdf',
      productId: 'product-2',
      productionJobId: 'job-2',
      description: 'DSP source',
      userId: 'user-1',
    });
    fs.writeFileSync(outputPath, result.pdfBuffer, { flag: 'wx' });

    assert.equal(fs.existsSync(inputPath), true);
    assert.equal(fs.statSync(inputPath).size, beforeSize);
    assert.equal(sha256File(inputPath), beforeHash);
    assert.notEqual(path.resolve(outputPath), path.resolve(inputPath));
    assert.ok(fs.statSync(outputPath).size > 0);
    assert.equal(result.pdfBuffer.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.equal(result.traceCode, traceCodeFromSha256(beforeHash));
    assert.equal(result.downloadFileName, 'QR_Signal_Processing_2907.pdf');

    const png = PNG.sync.read(result.qrPng);
    const pixels = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength);
    const decoded = jsQR(pixels, png.width, png.height);
    assert.ok(decoded, 'generated QR must be decodable');
    assert.equal(decoded.data, result.traceCode);

    assert.deepEqual(service.lookup(result.traceCode), {
      traceCode: result.traceCode,
      originalFileName: 'Signal_Processing_2907.pdf',
      sha256: beforeHash,
      fileSize: beforeSize,
      description: 'DSP source',
      uploadedAt: service.lookup(result.traceCode).uploadedAt,
      product: { id: 'product-2', barcode: 'PROD-002', name: 'Product 002' },
      productionJob: { id: 'job-2', jobCode: 'JOB-002', status: 'created' },
    });
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('document trace workflow validates PDF and is isolated from printer/spooler code', async () => {
  const db = createDb();
  const service = new DocumentTraceService({ dbProvider: () => db });
  try {
    await assert.rejects(service.generateTraceQr({
      buffer: Buffer.from('not a pdf'), originalFileName: 'bad.pdf', mimeType: 'application/pdf',
    }), /invalid_pdf_content/);
    await assert.rejects(service.generateTraceQr({
      buffer: Buffer.from('%PDF-test'), originalFileName: 'bad.txt', mimeType: 'application/pdf',
    }), /invalid_pdf_extension/);

    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/traceability/documentTraceService.js'), 'utf8');
    assert.doesNotMatch(source, /pdf-to-printer|SumatraPDF|windowsPrinterAdapter|printPdf|paperSize/i);
    const route = fs.readFileSync(path.resolve(__dirname, '../src/routes/documentTraceRoutes.js'), 'utf8');
    assert.match(route, /upload\.single\('pdf'\)/);
    assert.match(route, /router\.post\('\/generate'/);
    assert.match(route, /router\.get\('\/:traceCode'/);
  } finally { db.close(); }
});

test('application schema creates the minimal document_traces mapping table', () => {
  const db = new Database(':memory:');
  try {
    db.exec(fs.readFileSync(path.resolve(__dirname, '../database/schema.sql'), 'utf8'));
    const columns = db.prepare('PRAGMA table_info(document_traces)').all().map((column) => column.name);
    assert.deepEqual(columns, [
      'trace_code', 'original_file_name', 'sha256', 'file_size', 'description',
      'product_id', 'production_job_id', 'uploaded_by', 'uploaded_at',
    ]);
  } finally { db.close(); }
});
