const assert = require('node:assert/strict');
const EventEmitter = require('events');
const test = require('node:test');
const Database = require('better-sqlite3');
const { WorkflowService } = require('../src/services/workflow/workflowService');

const ACTIONS = "'START','STOP','HOME','RESET','SCAN','PRINT','JOB_LOAD_REQUEST','JOB_LOAD_ACK','JOB_ALREADY_LOADED','JOB_LOAD_FAILED','JOB_RECONCILE_MISMATCH'";

function createDb({ loaded = false } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE plc_devices (id TEXT PRIMARY KEY,is_active INTEGER);
    CREATE TABLE products (id TEXT PRIMARY KEY,barcode TEXT,plc_product_id INTEGER,recipe_id INTEGER,target_qty INTEGER,target_revs INTEGER,speed_rpm INTEGER,label_template_id TEXT);
    CREATE TABLE label_templates (id TEXT PRIMARY KEY,name TEXT,definition TEXT);
    CREATE TABLE production_jobs (
      id TEXT PRIMARY KEY,job_code TEXT,product_id TEXT,target_revs INTEGER,speed_rpm INTEGER,label_template_id TEXT,
      status TEXT,plc_device_id TEXT,plc_product_id INTEGER,plc_recipe_id INTEGER,plc_target_qty INTEGER,
      plc_job_loaded INTEGER DEFAULT 0,plc_loaded_at TEXT,last_plc_ack TEXT,plc_reconcile_status TEXT DEFAULT 'not_loaded',
      created_at TEXT,updated_at TEXT
    );
    CREATE TABLE production_logs (id INTEGER PRIMARY KEY,job_id TEXT,product_id TEXT,action TEXT CHECK(action IN (${ACTIONS})),command_sent TEXT,response TEXT,status TEXT,details TEXT,created_at TEXT);
    INSERT INTO plc_devices VALUES ('plc-1',1);
    INSERT INTO label_templates VALUES ('tpl-1','product-label','{}');
    INSERT INTO products VALUES ('product-1','P1',11,22,33,33,100,'tpl-1');
    INSERT INTO production_jobs VALUES ('job-1','JOB-1','product-1',33,100,'tpl-1','created','plc-1',11,22,33,${loaded ? 1 : 0},${loaded ? "'2026-01-01T00:00:00.000Z'" : 'NULL'},${loaded ? "'ACK=0001'" : 'NULL'},'${loaded ? 'loaded' : 'not_loaded'}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  `);
  return db;
}

function readyTelemetry(overrides = {}) {
  return { JobLoaded: true, ProductID: 11, RecipeID: 22, TargetQty: 33, MachineReady: true,
    MachineFault: false, MoveBusy: false, HaltBusy: false, HomeBusy: false, AxisPositioning: false, ...overrides };
}

class MockPlc extends EventEmitter {
  constructor(telemetry = readyTelemetry({ JobLoaded: false })) {
    super();
    this.telemetry = telemetry;
    this.calls = [];
    this.jobError = null;
    this.resetTelemetry = readyTelemetry({ JobLoaded: false });
  }
  getTelemetrySnapshot() { return { connected: true, isDemo: false, mode: 'REAL', telemetryFresh: true, telemetry: this.telemetry }; }
  formatJobCommand(p, r, q) { return `JOB=${String(p).padStart(4, '0')},${String(r).padStart(4, '0')},${String(q).padStart(4, '0')}`; }
  async sendJob(...args) { this.calls.push(['JOB', ...args]); if (this.jobError) throw this.jobError; return { command: this.formatJobCommand(...args.slice(1)), response: 'ACK=0001', mode: 'REAL' }; }
  async sendStart(id) { this.calls.push(['START', id]); return { response: 'ACK=0002', mode: 'REAL' }; }
  async sendStop(id) { this.calls.push(['STOP', id]); return { response: 'ACK=0003', mode: 'REAL' }; }
  async sendHome(id) { this.calls.push(['HOME', id]); return { response: 'ACK=0005', mode: 'REAL' }; }
  async sendReset(id) { this.calls.push(['RESET', id]); return { response: 'ACK=0004', mode: 'REAL' }; }
  async waitForTelemetryAfter() { this.telemetry = this.resetTelemetry; return this.getTelemetrySnapshot(); }
}

function harness(options = {}) {
  const db = createDb(options);
  const plc = new MockPlc(options.telemetry);
  const service = new WorkflowService({ dbProvider: () => db, plcService: plc, now: () => new Date('2026-01-02T00:00:00.000Z') });
  return { db, plc, service, close() { service.stop(); db.close(); } };
}

test('A/P: JOB ACK persists loaded state and tests use only mock PLC', async () => {
  const h = harness();
  try {
    const job = h.db.prepare('SELECT * FROM production_jobs').get();
    const product = h.db.prepare('SELECT * FROM products').get();
    await h.service.loadJobToPlc(job, product, 'plc-1');
    const row = h.db.prepare('SELECT * FROM production_jobs').get();
    assert.equal(row.plc_job_loaded, 1);
    assert.equal(row.last_plc_ack, 'ACK=0001');
    assert.deepEqual(h.plc.calls, [['JOB', 'plc-1', 11, 22, 33]]);
    assert.equal(h.db.prepare("SELECT COUNT(*) FROM production_logs WHERE action='JOB_LOAD_ACK'").pluck().get(), 1);
  } finally { h.close(); }
});

test('B: JOB timeout does not persist loaded state', async () => {
  const h = harness(); h.plc.jobError = new Error('job_timeout');
  try {
    await assert.rejects(h.service.loadJobToPlc(h.db.prepare('SELECT * FROM production_jobs').get(), h.db.prepare('SELECT * FROM products').get()), /job_timeout/);
    assert.equal(h.db.prepare('SELECT plc_job_loaded FROM production_jobs').pluck().get(), 0);
    assert.equal(h.db.prepare("SELECT COUNT(*) FROM production_logs WHERE action='JOB_LOAD_FAILED'").pluck().get(), 1);
  } finally { h.close(); }
});

test('C/D/E: restart reconciliation restores match, clears unloaded, blocks mismatch', () => {
  const matched = harness({ loaded: true, telemetry: readyTelemetry() });
  try { assert.equal(matched.service.reconcileDevice('plc-1').status, 'restored'); assert.ok(matched.service.loadedJobs.has('job-1')); } finally { matched.close(); }
  const cleared = harness({ loaded: true, telemetry: readyTelemetry({ JobLoaded: false }) });
  try { assert.equal(cleared.service.reconcileDevice('plc-1').status, 'not_loaded'); assert.equal(cleared.db.prepare('SELECT plc_job_loaded FROM production_jobs').pluck().get(), 0); } finally { cleared.close(); }
  const mismatch = harness({ loaded: true, telemetry: readyTelemetry({ ProductID: 99 }) });
  try { assert.equal(mismatch.service.reconcileDevice('plc-1').status, 'mismatch'); assert.equal(mismatch.db.prepare('SELECT plc_reconcile_status FROM production_jobs').pluck().get(), 'mismatch'); } finally { mismatch.close(); }
});

test('F: duplicate same-job load is idempotent and sends no second JOB', async () => {
  const h = harness({ loaded: true, telemetry: readyTelemetry() });
  try {
    const result = await h.service.loadJobToPlc(h.db.prepare('SELECT * FROM production_jobs').get(), h.db.prepare('SELECT * FROM products').get());
    assert.equal(result.status, 'already_loaded');
    assert.equal(h.plc.calls.length, 0);
  } finally { h.close(); }
});

test('G/H: START blocks not-loaded and stale telemetry with reason codes', async () => {
  const notLoaded = harness({ telemetry: readyTelemetry({ JobLoaded: false }) });
  try { await assert.rejects(notLoaded.service.startJob('job-1'), /plc_job_not_loaded/); assert.equal(notLoaded.plc.calls.length, 0); } finally { notLoaded.close(); }
  const stale = harness({ loaded: true, telemetry: readyTelemetry() });
  stale.plc.getTelemetrySnapshot = () => ({ connected: true, isDemo: false, mode: 'REAL', telemetryFresh: false, telemetry: null });
  try { await assert.rejects(stale.service.startJob('job-1'), /telemetry_stale/); assert.equal(stale.plc.calls.length, 0); } finally { stale.close(); }
});

test('I/M: STOP preserves loaded state and START is allowed again when ready', async () => {
  const h = harness({ loaded: true, telemetry: readyTelemetry() });
  try {
    await h.service.stopJob('job-1');
    assert.equal(h.db.prepare('SELECT plc_job_loaded FROM production_jobs').pluck().get(), 1);
    await h.service.startJob('job-1');
    assert.deepEqual(h.plc.calls.map((call) => call[0]), ['STOP', 'START']);
  } finally { h.close(); }
});

test('J/L/N: HOME logs HOME, preserves loaded state and START remains allowed', async () => {
  const h = harness({ loaded: true, telemetry: readyTelemetry() });
  try {
    await h.service.homeJob('job-1');
    assert.equal(h.db.prepare('SELECT plc_job_loaded FROM production_jobs').pluck().get(), 1);
    assert.equal(h.db.prepare('SELECT action FROM production_logs ORDER BY id DESC').pluck().get(), 'HOME');
    await h.service.startJob('job-1');
  } finally { h.close(); }
});

test('K/L/O: RESET requires STAT false, clears persistence, logs RESET not HOME, then START blocks', async () => {
  const h = harness({ loaded: true, telemetry: readyTelemetry() });
  try {
    await h.service.resetJob('job-1');
    assert.equal(h.db.prepare('SELECT plc_job_loaded FROM production_jobs').pluck().get(), 0);
    assert.equal(h.db.prepare('SELECT action FROM production_logs ORDER BY id DESC').pluck().get(), 'RESET');
    assert.equal(h.db.prepare("SELECT COUNT(*) FROM production_logs WHERE action='HOME'").pluck().get(), 0);
    await assert.rejects(h.service.startJob('job-1'), /plc_job_not_loaded/);
  } finally { h.close(); }
});
