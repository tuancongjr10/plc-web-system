const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { LabelRenderer } = require('../src/services/printer/labelRenderer');
const { PrinterService } = require('../src/services/printer/printerService');

function emitter(methods = {}) {
  return Object.assign(new EventEmitter(), { start() {}, stop() {}, ...methods });
}

function createHarness({ submitError = null, retentionMs = 60 * 60 * 1000 } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-label-retention-test-'));
  const labelDir = path.join(tempRoot, 'labels');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, queue_name TEXT, print_mode TEXT NOT NULL,
      is_active INTEGER NOT NULL, is_enabled INTEGER NOT NULL, connection_status TEXT,
      last_seen_at TEXT, last_error TEXT, updated_at TEXT
    );
    CREATE TABLE label_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL, is_active INTEGER NOT NULL
    );
    CREATE TABLE print_jobs (
      id TEXT PRIMARY KEY, production_job_id TEXT, printer_id TEXT, user_id TEXT,
      job_name TEXT NOT NULL, template_id TEXT, template_name TEXT, queue_name_snapshot TEXT,
      rendered_file TEXT, payload_content TEXT NOT NULL DEFAULT '', copies INTEGER,
      status TEXT NOT NULL, error_message TEXT, metadata TEXT, started_at TEXT,
      rendered_at TEXT, submitted_at TEXT, completed_at TEXT, retry_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO printers VALUES
      ('printer-1','Test','QUEUE-1','WINDOWS_QUEUE',1,1,'unknown',NULL,NULL,NULL);
    INSERT INTO label_templates VALUES
      ('template-1','product-label','{"unit":"mm","width":100,"height":50,"fields":[]}',1);
  `);
  const renderer = new LabelRenderer(labelDir);
  const windowsAdapter = emitter({
    async printFile() {
      if (submitError) throw submitError;
      return { accepted: true };
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
    labelRenderer: renderer,
    labelRetentionMs: retentionMs,
  });
  return {
    db, renderer, service, labelDir,
    close() {
      service.stop();
      db.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function insertReference(db, filePath, metadata = '{"audit":"keep"}') {
  db.prepare(`INSERT INTO print_jobs
    (id,printer_id,job_name,rendered_file,payload_content,copies,status,metadata,rendered_at,submitted_at)
    VALUES (?,?,?,?,?,?,'submitted',?,?,?)`)
    .run(`job-${Math.random()}`, 'printer-1', 'retention-test', filePath, '', 1, metadata,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
}

test('CASE A: submitted PDF remains present and rendered_file points to it', async () => {
  const harness = createHarness();
  try {
    await harness.service.printFromTemplate('printer-1', 'product-label');
    const row = harness.db.prepare('SELECT status,rendered_file FROM print_jobs').get();
    assert.equal(row.status, 'submitted');
    assert.equal(harness.renderer.isManagedPath(row.rendered_file), true);
    assert.equal(fs.existsSync(row.rendered_file), true);
  } finally { harness.close(); }
});

test('CASE B: submit failure retains PDF and valid rendered_file for debugging', async () => {
  const harness = createHarness({ submitError: new Error('submit_failed_for_retention_test') });
  try {
    await assert.rejects(harness.service.printFromTemplate('printer-1', 'product-label'), /submit_failed/);
    const row = harness.db.prepare('SELECT status,rendered_file FROM print_jobs').get();
    assert.equal(row.status, 'failed');
    assert.equal(harness.renderer.isManagedPath(row.rendered_file), true);
    assert.equal(fs.existsSync(row.rendered_file), true);
  } finally { harness.close(); }
});

test('CASE C: expired managed file is deleted and only rendered_file is cleared', async () => {
  const harness = createHarness({ retentionMs: 1000 });
  try {
    fs.mkdirSync(harness.labelDir, { recursive: true });
    const filePath = path.join(harness.labelDir, 'label-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf');
    fs.writeFileSync(filePath, 'expired');
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(filePath, old, old);
    insertReference(harness.db, filePath);
    await harness.service.cleanupExpiredLabelFiles();
    const row = harness.db.prepare('SELECT * FROM print_jobs').get();
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(row.rendered_file, null);
    assert.equal(row.metadata, '{"audit":"keep"}');
    assert.ok(row.rendered_at);
    assert.ok(row.submitted_at);
  } finally { harness.close(); }
});

test('CASE D: unexpired managed file is retained', async () => {
  const harness = createHarness({ retentionMs: 60 * 60 * 1000 });
  try {
    fs.mkdirSync(harness.labelDir, { recursive: true });
    const filePath = path.join(harness.labelDir, 'label-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf');
    fs.writeFileSync(filePath, 'fresh');
    insertReference(harness.db, filePath);
    await harness.service.cleanupExpiredLabelFiles();
    assert.equal(fs.existsSync(filePath), true);
    assert.equal(harness.db.prepare('SELECT rendered_file FROM print_jobs').pluck().get(), filePath);
  } finally { harness.close(); }
});

test('CASE E: path outside label directory is not deleted or cleared', async () => {
  const harness = createHarness({ retentionMs: 1 });
  const outsidePath = path.join(path.dirname(harness.labelDir), 'label-cccccccccccccccccccccccccccccccc.pdf');
  try {
    fs.writeFileSync(outsidePath, 'outside');
    insertReference(harness.db, outsidePath);
    await harness.service.cleanupExpiredLabelFiles();
    assert.equal(fs.existsSync(outsidePath), true);
    assert.equal(harness.db.prepare('SELECT rendered_file FROM print_jobs').pluck().get(), outsidePath);
  } finally { harness.close(); }
});

test('CASE F: missing managed file is idempotently cleared from DB', async () => {
  const harness = createHarness();
  try {
    const missingPath = path.join(harness.labelDir, 'label-dddddddddddddddddddddddddddddddd.pdf');
    insertReference(harness.db, missingPath);
    await harness.service.cleanupExpiredLabelFiles();
    await harness.service.cleanupExpiredLabelFiles();
    assert.equal(harness.db.prepare('SELECT rendered_file FROM print_jobs').pluck().get(), null);
  } finally { harness.close(); }
});
