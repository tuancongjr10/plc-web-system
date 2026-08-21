const assert = require('node:assert/strict');
const EventEmitter = require('events');
const test = require('node:test');
const Database = require('better-sqlite3');
const { PrinterService } = require('../src/services/printer/printerService');
const { WindowsPrinterAdapter } = require('../src/services/printer/windowsPrinterAdapter');

function emitter(methods = {}) {
  return Object.assign(new EventEmitter(), { start() {}, stop() {}, ...methods });
}

function createHarness(responses, options = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id TEXT PRIMARY KEY, connection_status TEXT, updated_at TEXT, is_enabled INTEGER,
      last_seen_at TEXT, last_error TEXT
    );
    CREATE TABLE print_jobs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, error_message TEXT, metadata TEXT,
      submitted_at TEXT, completed_at TEXT, rendered_file TEXT, queue_name_snapshot TEXT
    );
  `);
  let clock = options.clock ?? 0;
  let queryIndex = 0;
  const statusesAtQuery = [];
  const windowsAdapter = emitter({
    async getPrintJobs() {
      statusesAtQuery.push(db.prepare('SELECT id,status FROM print_jobs ORDER BY id').all());
      const response = responses[Math.min(queryIndex++, responses.length - 1)];
      if (response instanceof Error) throw response;
      return response;
    },
  });
  const service = new PrinterService({
    dbProvider: () => db,
    windowsAdapter,
    demoAdapter: emitter(),
    legacyAdapter: emitter(),
    legacyRenderer: { render() { return ''; } },
    labelRenderer: { async cleanupExpired() { return []; }, isManagedPath() { return false; } },
    trackingTimeoutMs: 2,
    trackingPollIntervalMs: 1,
    reconciliationPollIntervalMs: options.reconciliationPollIntervalMs ?? 5,
    reconcileMaxMs: options.reconcileMaxMs,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const addJob = (id, values = {}) => db.prepare(`INSERT INTO print_jobs
    (id,status,metadata,submitted_at,queue_name_snapshot) VALUES (?,?,?,?,?)`)
    .run(id, values.status || 'submitted', values.metadata || '{}', values.submittedAt || '2026-01-01T00:00:00.000Z', values.queueName || null);
  return { db, service, addJob, statusesAtQuery, getQueryCount: () => queryIndex, close: () => { service.stop(); db.close(); } };
}

function spoolerJob(documentName, jobStatus = 'Printing', jobId = 101) {
  return { jobId, documentName, printerName: 'QUEUE-1', jobStatus, submittedTime: null, size: 123 };
}

test('CASE A: correlated job observed printing then disappears -> completed', async () => {
  const name = 'PLCWEB-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf';
  const harness = createHarness([[spoolerJob(name)], []]);
  try {
    harness.addJob('a');
    assert.equal(await harness.service._trackWindowsJob('a', 'QUEUE-1', name), 'completed');
    const row = harness.db.prepare('SELECT * FROM print_jobs WHERE id=?').get('a');
    assert.equal(row.status, 'completed');
    assert.ok(row.completed_at);
    assert.deepEqual(harness.statusesAtQuery.map((rows) => rows[0].status), ['submitted', 'printing']);
  } finally { harness.close(); }
});

test('CASE B: correlated spooler error -> failed with error_message', async () => {
  const name = 'PLCWEB-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf';
  const harness = createHarness([[spoolerJob(name, 'Error, PaperOut')]]);
  try {
    harness.addJob('b');
    assert.equal(await harness.service._trackWindowsJob('b', 'QUEUE-1', name), 'failed');
    const row = harness.db.prepare('SELECT * FROM print_jobs WHERE id=?').get('b');
    assert.equal(row.status, 'failed');
    assert.match(row.error_message, /windows_spooler/i);
  } finally { harness.close(); }
});

test('CASE C: job never observed -> unknown, never completed', async () => {
  const harness = createHarness([[]]);
  try {
    harness.addJob('c');
    assert.equal(await harness.service._trackWindowsJob('c', 'QUEUE-1', 'PLCWEB-cccccccccccccccccccccccccccccccc.pdf'), 'unknown');
    const row = harness.db.prepare('SELECT * FROM print_jobs WHERE id=?').get('c');
    assert.equal(row.status, 'unknown');
    assert.equal(row.completed_at, null);
  } finally { harness.close(); }
});

test('CASE D: correlated job remains printing at timeout -> printing', async () => {
  const name = 'PLCWEB-dddddddddddddddddddddddddddddddd.pdf';
  const harness = createHarness([[spoolerJob(name)]]);
  try {
    harness.addJob('d');
    assert.equal(await harness.service._trackWindowsJob('d', 'QUEUE-1', name), 'printing');
    const row = harness.db.prepare('SELECT * FROM print_jobs WHERE id=?').get('d');
    assert.equal(row.status, 'printing');
    assert.equal(row.completed_at, null);
  } finally { harness.close(); }
});

test('CASE E: unrelated job in same queue is never correlated', async () => {
  const harness = createHarness([[spoolerJob('PLCWEB-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.pdf')]]);
  try {
    harness.addJob('target');
    assert.equal(await harness.service._trackWindowsJob('target', 'QUEUE-1', 'PLCWEB-ffffffffffffffffffffffffffffffff.pdf'), 'unknown');
    assert.equal(harness.db.prepare('SELECT status FROM print_jobs WHERE id=?').pluck().get('target'), 'unknown');
  } finally { harness.close(); }
});

test('CASE F: two application jobs in one queue retain independent identity', async () => {
  const first = 'PLCWEB-11111111111111111111111111111111.pdf';
  const second = 'PLCWEB-22222222222222222222222222222222.pdf';
  const harness = createHarness([
    [spoolerJob(first, 'Printing', 111), spoolerJob(second, 'Printing', 222)],
    [spoolerJob(second, 'Printing', 222)],
    [spoolerJob(second, 'Printing', 222)],
    [],
  ]);
  try {
    harness.addJob('first');
    harness.addJob('second');
    assert.equal(await harness.service._trackWindowsJob('first', 'QUEUE-1', first), 'completed');
    assert.equal(await harness.service._trackWindowsJob('second', 'QUEUE-1', second), 'completed');
    const rows = harness.db.prepare('SELECT id,status,metadata FROM print_jobs ORDER BY id').all();
    assert.deepEqual(rows.map(({ id, status }) => ({ id, status })), [
      { id: 'first', status: 'completed' },
      { id: 'second', status: 'completed' },
    ]);
    assert.equal(JSON.parse(rows[0].metadata).spoolerJobId, 111);
    assert.equal(JSON.parse(rows[1].metadata).spoolerJobId, 222);
  } finally { harness.close(); }
});

test('CASE G: spooler query failure -> conservative unknown without completed_at', async () => {
  const harness = createHarness([new Error('get_print_job_failed')]);
  try {
    harness.addJob('g');
    assert.equal(await harness.service._trackWindowsJob('g', 'QUEUE-1', 'PLCWEB-gggggggggggggggggggggggggggggggg.pdf'), 'unknown');
    const row = harness.db.prepare('SELECT * FROM print_jobs WHERE id=?').get('g');
    assert.equal(row.status, 'unknown');
    assert.equal(row.completed_at, null);
    assert.match(row.error_message, /spooler_query_failed/);
  } finally { harness.close(); }
});

test('adapter query passes queue safely and normalizes the Windows DTO', async () => {
  let invocation;
  const adapter = new WindowsPrinterAdapter({
    async execFile(file, args, options) {
      invocation = { file, args, options };
      return { stdout: JSON.stringify({
        ID: 42,
        DocumentName: 'PLCWEB-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf',
        PrinterName: 'Queue; Write-Error unsafe',
        JobStatus: 'Printing',
        SubmittedTime: '2026-01-01T00:00:00Z',
        Size: 1234,
      }) };
    },
  });
  const queueName = 'Queue; Write-Error unsafe';
  const jobs = await adapter.getPrintJobs(queueName);
  assert.equal(invocation.file, 'powershell.exe');
  assert.equal(invocation.args.includes(queueName), false);
  assert.equal(invocation.options.env.PLCWEB_PRINT_QUEUE, queueName);
  assert.deepEqual(jobs, [{
    jobId: 42,
    documentName: 'PLCWEB-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf',
    printerName: queueName,
    jobStatus: 'Printing',
    submittedTime: '2026-01-01T00:00:00Z',
    size: 1234,
  }]);
});

test('CASE H: submit returns immediately while tracking continues in background', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (id TEXT PRIMARY KEY,connection_status TEXT,last_seen_at TEXT,last_error TEXT,updated_at TEXT);
    CREATE TABLE print_jobs (
      id TEXT PRIMARY KEY,production_job_id TEXT,printer_id TEXT,user_id TEXT,job_name TEXT,
      template_id TEXT,template_name TEXT,queue_name_snapshot TEXT,rendered_file TEXT,
      payload_content TEXT,copies INTEGER,status TEXT,error_message TEXT,metadata TEXT,
      rendered_at TEXT,submitted_at TEXT,completed_at TEXT
    );
    INSERT INTO printers VALUES ('printer-1','unknown',NULL,NULL,NULL);
  `);
  let releaseQuery;
  const queryGate = new Promise((resolve) => { releaseQuery = resolve; });
  let clock = 0;
  const adapter = emitter({
    async printFile(pdfPath) {
      return { accepted: true, submitted: true, documentName: require('path').basename(pdfPath) };
    },
    async getPrintJobs() { await queryGate; return []; },
  });
  const service = new PrinterService({
    dbProvider: () => db,
    windowsAdapter: adapter,
    demoAdapter: emitter(), legacyAdapter: emitter(), legacyRenderer: { render() { return ''; } },
    labelRenderer: {
      async renderLabelPdf(_template, _variables, options) {
        return { pdfPath: `C:\\temp\\PLCWEB-${options.correlationId}.pdf`, label: {} };
      },
    },
    trackingTimeoutMs: 2, trackingPollIntervalMs: 1,
    now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  try {
    const result = await service._executeWindows(
      { id: 'printer-1', queue_name: 'QUEUE-1', print_mode: 'WINDOWS_QUEUE' },
      { id: 'template-1', name: 'product-label' }, {}, 1, {},
    );
    assert.equal(result.status, 'submitted');
    assert.equal(db.prepare('SELECT status FROM print_jobs').pluck().get(), 'submitted');
    assert.equal(service.activeTrackers.size, 1);
    const trackerPromise = [...service.activeTrackers.values()][0].promise;
    releaseQuery();
    assert.equal(await trackerPromise, 'unknown');
  } finally { service.stop(); db.close(); }
});

test('CASE I: printing after initial window continues reconciliation then completes', async () => {
  const name = 'PLCWEB-33333333333333333333333333333333.pdf';
  const job = spoolerJob(name);
  const harness = createHarness([[job], [job], [job], []]);
  try {
    harness.addJob('i');
    const tracker = harness.service._launchWindowsJobTracker('i', 'QUEUE-1', name);
    assert.equal(await tracker, 'completed');
    assert.equal(harness.db.prepare('SELECT status FROM print_jobs WHERE id=?').pluck().get('i'), 'completed');
  } finally { harness.close(); }
});

test('CASE J: transient query failures retry and later successful correlation completes', async () => {
  const name = 'PLCWEB-44444444444444444444444444444444.pdf';
  const harness = createHarness([new Error('temporary-1'), new Error('temporary-2'), [spoolerJob(name)], []]);
  try {
    harness.addJob('j');
    assert.equal(await harness.service._launchWindowsJobTracker('j', 'QUEUE-1', name), 'completed');
    assert.equal(harness.db.prepare('SELECT status FROM print_jobs WHERE id=?').pluck().get('j'), 'completed');
  } finally { harness.close(); }
});

test('CASE K: service start reconciles persisted submitted job with correlation metadata', async () => {
  const name = 'PLCWEB-55555555555555555555555555555555.pdf';
  const harness = createHarness([[spoolerJob(name)], []]);
  try {
    harness.addJob('k', { queueName: 'QUEUE-1', metadata: JSON.stringify({ spoolerDocumentName: name }) });
    harness.service.start();
    const tracker = harness.service.activeTrackers.get('k')?.promise;
    assert.ok(tracker);
    assert.equal(await tracker, 'completed');
    assert.equal(harness.db.prepare('SELECT status FROM print_jobs WHERE id=?').pluck().get('k'), 'completed');
  } finally { harness.close(); }
});

test('CASE L: restart without correlation evidence becomes conservative unknown', async () => {
  const harness = createHarness([[]]);
  try {
    harness.addJob('l', { queueName: 'QUEUE-1', metadata: '{}' });
    harness.service.start();
    const row = harness.db.prepare('SELECT status,completed_at FROM print_jobs WHERE id=?').get('l');
    assert.equal(row.status, 'unknown');
    assert.equal(row.completed_at, null);
    assert.equal(harness.service.activeTrackers.size, 0);
    await new Promise((resolve) => setImmediate(resolve));
  } finally { harness.close(); }
});

test('CASE M: duplicate tracker request reuses one active task', async () => {
  const name = 'PLCWEB-66666666666666666666666666666666.pdf';
  const job = spoolerJob(name);
  const harness = createHarness([[job], [job], [job], []]);
  try {
    harness.addJob('m');
    const first = harness.service._launchWindowsJobTracker('m', 'QUEUE-1', name);
    const second = harness.service._launchWindowsJobTracker('m', 'QUEUE-1', name);
    assert.equal(first, second);
    assert.equal(harness.service.activeTrackers.size, 1);
    assert.equal(await first, 'completed');
    assert.equal(harness.service.activeTrackers.size, 0);
  } finally { harness.close(); }
});

test('CASE N: continuously printing beyond max horizon -> unknown and tracker ends', async () => {
  const name = 'PLCWEB-77777777777777777777777777777777.pdf';
  const harness = createHarness([[spoolerJob(name)]], { reconcileMaxMs: 7 });
  try {
    harness.addJob('n');
    assert.equal(await harness.service._launchWindowsJobTracker('n', 'QUEUE-1', name), 'unknown');
    const row = harness.db.prepare('SELECT status,error_message,completed_at FROM print_jobs WHERE id=?').get('n');
    assert.equal(row.status, 'unknown');
    assert.equal(row.error_message, 'spooler_reconcile_timeout');
    assert.equal(row.completed_at, null);
    assert.equal(harness.service.activeTrackers.size, 0);
  } finally { harness.close(); }
});

test('CASE O: job disappearing before max horizon completes normally', async () => {
  const name = 'PLCWEB-88888888888888888888888888888888.pdf';
  const job = spoolerJob(name);
  const harness = createHarness([[job], [job], [job], []], { reconcileMaxMs: 20 });
  try {
    harness.addJob('o');
    assert.equal(await harness.service._launchWindowsJobTracker('o', 'QUEUE-1', name), 'completed');
    const row = harness.db.prepare('SELECT status,error_message,completed_at FROM print_jobs WHERE id=?').get('o');
    assert.equal(row.status, 'completed');
    assert.equal(row.error_message, null);
    assert.ok(row.completed_at);
  } finally { harness.close(); }
});

test('CASE P: restart reconciliation preserves submitted_at horizon', async () => {
  const name = 'PLCWEB-99999999999999999999999999999999.pdf';
  const harness = createHarness([[spoolerJob(name)]], { clock: 20, reconcileMaxMs: 10 });
  try {
    harness.addJob('p', {
      status: 'printing',
      queueName: 'QUEUE-1',
      submittedAt: '1970-01-01T00:00:00.000Z',
      metadata: JSON.stringify({ spoolerDocumentName: name, spoolerObserved: true }),
    });
    harness.service.start();
    const tracker = harness.service.activeTrackers.get('p')?.promise;
    assert.ok(tracker);
    assert.equal(await tracker, 'unknown');
    const row = harness.db.prepare('SELECT status,error_message,completed_at FROM print_jobs WHERE id=?').get('p');
    assert.equal(row.status, 'unknown');
    assert.equal(row.error_message, 'spooler_reconcile_timeout');
    assert.equal(row.completed_at, null);
    assert.equal(harness.getQueryCount(), 0);
  } finally { harness.close(); }
});
