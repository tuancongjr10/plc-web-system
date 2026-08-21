const assert = require('node:assert/strict');
const EventEmitter = require('events');
const test = require('node:test');
const Database = require('better-sqlite3');
const { PrinterService } = require('../src/services/printer/printerService');

function createDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, queue_name TEXT,
      print_mode TEXT NOT NULL, is_active INTEGER NOT NULL,
      is_enabled INTEGER NOT NULL, connection_status TEXT,
      last_seen_at TEXT, last_error TEXT, updated_at TEXT
    );
    CREATE TABLE label_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL,
      is_active INTEGER NOT NULL
    );
    CREATE TABLE print_jobs (
      id TEXT PRIMARY KEY, production_job_id TEXT, printer_id TEXT, user_id TEXT,
      job_name TEXT NOT NULL, template_id TEXT, template_name TEXT,
      queue_name_snapshot TEXT, rendered_file TEXT,
      payload_content TEXT NOT NULL DEFAULT '', copies INTEGER,
      status TEXT NOT NULL, error_message TEXT, metadata TEXT,
      started_at TEXT, rendered_at TEXT, submitted_at TEXT, completed_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO printers (id,name,queue_name,print_mode,is_active,is_enabled,connection_status,updated_at)
      VALUES ('printer-1','Test queue','QUEUE-1','WINDOWS_QUEUE',1,1,'unknown','2026-01-01T00:00:00.000Z');
    INSERT INTO label_templates (id,name,definition,is_active)
      VALUES ('template-1','product-label','{"unit":"mm","width":100,"height":50,"fields":[]}',1);
  `);
  return db;
}

function emitter(methods = {}) {
  return Object.assign(new EventEmitter(), { start() {}, stop() {}, ...methods });
}

function createHarness({ renderError = null, submitError = null, submissionCompletion = null } = {}) {
  const db = createDatabase();
  const transitions = [];
  let printFileCalls = 0;
  const labelRenderer = {
    async renderLabelPdf() {
      transitions.push(db.prepare('SELECT status FROM print_jobs').pluck().get());
      if (renderError) throw renderError;
      return { pdfPath: 'D:\\temp\\label-test.pdf', label: {} };
    },
    async cleanup() {},
    async cleanupExpired() {},
  };
  const windowsAdapter = emitter({
    async printFile() {
      printFileCalls += 1;
      transitions.push(db.prepare('SELECT status FROM print_jobs').pluck().get());
      if (submitError) throw submitError;
      return {
        accepted: true,
        submitted: true,
        warning: 'paper_size_unverified: test warning',
        ...(submissionCompletion ? { completion: submissionCompletion } : {}),
      };
    },
    async listPrinters() { return []; },
    async getPrinterStatus() { return { status: 'UNKNOWN' }; },
  });
  const service = new PrinterService({
    dbProvider: () => db,
    windowsAdapter,
    demoAdapter: emitter(),
    legacyAdapter: emitter(),
    legacyRenderer: { render() { return ''; } },
    labelRenderer,
  });
  return { db, service, transitions, getPrintFileCalls: () => printFileCalls };
}

test('CASE A: pending -> rendered -> submitted uses one row', async () => {
  const harness = createHarness();
  try {
    const result = await harness.service.printFromTemplate('printer-1', 'product-label', { barcode: 'TEST' }, 1);
    const rows = harness.db.prepare('SELECT * FROM print_jobs').all();
    assert.deepEqual(harness.transitions, ['pending', 'rendered']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'submitted');
    assert.ok(rows[0].rendered_at);
    assert.ok(rows[0].submitted_at);
    assert.equal(result.status, 'submitted');
    assert.equal(JSON.parse(rows[0].metadata).paperSizeWarning, 'paper_size_unverified: test warning');
  } finally { harness.db.close(); }
});

test('CASE B: render failure keeps pending row as failed and never submits', async () => {
  const harness = createHarness({ renderError: new Error('render_failed_for_test') });
  try {
    await assert.rejects(
      harness.service.printFromTemplate('printer-1', 'product-label', {}, 1),
      /render_failed_for_test/,
    );
    const rows = harness.db.prepare('SELECT * FROM print_jobs').all();
    assert.deepEqual(harness.transitions, ['pending']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].error_message, 'render_failed_for_test');
    assert.equal(rows[0].rendered_at, null);
    assert.equal(rows[0].submitted_at, null);
    assert.equal(harness.getPrintFileCalls(), 0);
  } finally { harness.db.close(); }
});

test('CASE C: submit failure keeps rendered timestamp and marks same row failed', async () => {
  const submitError = new Error('submit_failed_for_test');
  submitError.paperSizeWarning = 'paper_size_unverified: failed submit warning';
  const harness = createHarness({ submitError });
  try {
    await assert.rejects(
      harness.service.printFromTemplate('printer-1', 'product-label', {}, 1),
      /submit_failed_for_test/,
    );
    const rows = harness.db.prepare('SELECT * FROM print_jobs').all();
    assert.deepEqual(harness.transitions, ['pending', 'rendered']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'failed');
    assert.ok(rows[0].rendered_at);
    assert.equal(rows[0].submitted_at, null);
    assert.equal(rows[0].error_message, 'submit_failed_for_test');
    assert.equal(JSON.parse(rows[0].metadata).paperSizeWarning, 'paper_size_unverified: failed submit warning');
    assert.notEqual(rows[0].status, 'completed');
  } finally { harness.db.close(); }
});

test('CASE D: productionJobId is stored on the pending print job', async () => {
  const harness = createHarness();
  try {
    await harness.service.printFromTemplate('printer-1', 'product-label', {}, 1, { productionJobId: 'production-job-42' });
    const row = harness.db.prepare('SELECT production_job_id FROM print_jobs').get();
    assert.equal(row.production_job_id, 'production-job-42');
  } finally { harness.db.close(); }
});

test('returns submitted without waiting for the interactive print process to finish', async () => {
  let finishSubmission;
  const submissionCompletion = new Promise((resolve) => { finishSubmission = resolve; });
  const harness = createHarness({ submissionCompletion });
  try {
    const result = await harness.service.printFromTemplate('printer-1', 'product-label', {}, 1);
    assert.equal(result.status, 'submitted');
    assert.equal(Object.hasOwn(result, 'completion'), false);
    assert.equal(harness.db.prepare('SELECT status FROM print_jobs').pluck().get(), 'submitted');

    finishSubmission({ success: false, error: new Error('save_dialog_cancelled') });
    await new Promise((resolve) => setImmediate(resolve));
    const row = harness.db.prepare('SELECT status,error_message FROM print_jobs').get();
    assert.equal(row.status, 'failed');
    assert.equal(row.error_message, 'save_dialog_cancelled');
  } finally { harness.db.close(); }
});
