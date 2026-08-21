/**
 * Initialize database and seed default data
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb, initializeSchema } = require('./database');
const logger = require('../config/logger');
const config = require('../config');

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function migrateLegacyProtocol(db) {
  if (!tableExists(db, 'plc_devices')) return;
  try {
    db.prepare(`
      UPDATE plc_devices
      SET protocol = 's7-tcp',
          ip_address = '192.168.0.1',
          port = 2000,
          updated_at = ?
      WHERE protocol IN ('ethernet-ip', 'EtherNet/IP', 'cip', 's7')
    `).run(new Date().toISOString());
  } catch (err) {
    logger.warn(`Legacy PLC protocol migrate skipped: ${err.message}`);
  }
}

function migrateLegacyMoveTag(db) {
  if (!tableExists(db, 'plc_tags')) return;
  try {
    db.prepare(`
      UPDATE plc_tags
      SET address = 'LOCAL.PRODUCT_TARGET_REVS',
          description = 'Product target_revs - chưa truyền PLC',
          is_writable = 0,
          is_monitored = 0
      WHERE lower(tag_name) = 'targetrevs'
         OR upper(address) = 'CMD.MOVE'
         OR upper(COALESCE(description, '')) LIKE '%MOVE=XXXX%'
    `).run();
  } catch (err) {
    logger.warn(`Legacy MOVE tag migrate skipped: ${err.message}`);
  }
}

function migrateProductPlcFields(db) {
  if (!tableExists(db, 'products')) return;
  const columns = new Set(db.prepare('PRAGMA table_info(products)').all().map((column) => column.name));
  const additions = [
    ['plc_product_id', 'INTEGER'],
    ['recipe_id', 'INTEGER'],
    ['target_qty', 'INTEGER'],
  ];
  for (const [name, type] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${type}`);
  }
}

function migratePhase2Workflow(db) {
  if (!tableExists(db, 'production_jobs') || !tableExists(db, 'production_logs')) return;
  const jobColumns = new Set(db.prepare('PRAGMA table_info(production_jobs)').all().map((column) => column.name));
  const additions = [
    ['plc_device_id', 'TEXT REFERENCES plc_devices(id) ON DELETE SET NULL'],
    ['plc_product_id', 'INTEGER'],
    ['plc_recipe_id', 'INTEGER'],
    ['plc_target_qty', 'INTEGER'],
    ['plc_job_loaded', 'INTEGER NOT NULL DEFAULT 0 CHECK(plc_job_loaded IN (0,1))'],
    ['plc_loaded_at', 'TEXT'],
    ['last_plc_ack', 'TEXT'],
    ['plc_reconcile_status', "TEXT NOT NULL DEFAULT 'not_loaded' CHECK(plc_reconcile_status IN ('not_loaded','loaded','mismatch','unknown'))"],
  ];
  for (const [name, type] of additions) {
    if (!jobColumns.has(name)) db.exec(`ALTER TABLE production_jobs ADD COLUMN ${name} ${type}`);
  }

  const logSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='production_logs'").pluck().get() || '';
  if (!logSql.includes('JOB_RECONCILE_MISMATCH') || !logSql.includes("'RESET'")) {
    const objects = db.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name='production_logs'
      AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`).all();
    const foreignKeysWereEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');
    db.transaction(() => {
      db.exec(`ALTER TABLE production_logs RENAME TO production_logs_pre_phase2;
        CREATE TABLE production_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT REFERENCES production_jobs(id) ON DELETE CASCADE,
          product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
          action TEXT NOT NULL CHECK(action IN ('START','STOP','HOME','RESET','SCAN','PRINT','JOB_LOAD_REQUEST','JOB_LOAD_ACK','JOB_ALREADY_LOADED','JOB_LOAD_FAILED','JOB_RECONCILE_MISMATCH')),
          command_sent TEXT,response TEXT,status TEXT DEFAULT 'success',details TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        INSERT INTO production_logs (id,job_id,product_id,action,command_sent,response,status,details,created_at)
        SELECT id,job_id,product_id,action,command_sent,response,status,details,created_at FROM production_logs_pre_phase2;
        DROP TABLE production_logs_pre_phase2;`);
      for (const object of objects) db.exec(object.sql);
    })();
    db.pragma('legacy_alter_table = OFF');
    if (foreignKeysWereEnabled) db.pragma('foreign_keys = ON');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_production_jobs_plc_loaded ON production_jobs(plc_device_id, plc_job_loaded, plc_reconcile_status)');
}

function migrateDbSocketTags(db) {
  if (!tableExists(db, 'plc_devices') || !tableExists(db, 'plc_tags')) return;
  const device = db.prepare("SELECT id FROM plc_devices WHERE name = 'PLC-SIEMENS-S71200'").get();
  if (!device) return;

  const tags = [
    ['MachineState', 'PLC.MACHINE_STATE', 'INT', 'Trạng thái máy', null],
    ['JobLoaded', 'PLC.JOB_LOADED', 'BOOL', 'Job đã được PLC nạp', null],
    ['ProductID', 'PLC.PRODUCT_ID', 'INT', 'Product ID', null],
    ['RecipeID', 'PLC.RECIPE_ID', 'INT', 'Recipe ID', null],
    ['TargetQty', 'PLC.TARGET_QTY', 'INT', 'Số lượng mục tiêu', 'pcs'],
    ['MachineReady', 'PLC.MACHINE_READY', 'BOOL', 'Máy sẵn sàng', null],
    ['MachineRunning', 'PLC.MACHINE_RUNNING', 'BOOL', 'Máy đang chạy', null],
    ['MachineFault', 'PLC.MACHINE_FAULT', 'BOOL', 'Máy báo lỗi', null],
    ['FaultCode', 'PLC.FAULT_CODE', 'INT', 'Mã lỗi', null],
    ['AxisReady', 'PLC.AXIS_READY', 'BOOL', 'Trục sẵn sàng', null],
    ['MoveBusy', 'PLC.MOVE_BUSY', 'BOOL', 'Trục đang di chuyển', null],
    ['HaltBusy', 'PLC.HALT_BUSY', 'BOOL', 'Trục đang dừng có kiểm soát', null],
    ['AxisPositioning', 'PLC.AXIS_POSITIONING', 'BOOL', 'Trục đang định vị', null],
    ['HomeBusy', 'PLC.HOME_BUSY', 'BOOL', 'Trục đang homing', null],
    ['MotionState', 'PLC.MOTION_STATE', 'INT', 'Trạng thái motion', null],
  ];

  db.prepare('UPDATE plc_tags SET is_monitored = 0 WHERE device_id = ?').run(device.id);
  const find = db.prepare('SELECT id FROM plc_tags WHERE device_id = ? AND lower(tag_name) = lower(?)');
  const update = db.prepare('UPDATE plc_tags SET address = ?, data_type = ?, description = ?, unit = ?, is_writable = 0, is_monitored = 1 WHERE id = ?');
  const insert = db.prepare('INSERT INTO plc_tags (id, device_id, tag_name, address, data_type, description, unit, is_writable, is_monitored) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, 0, 1)');
  db.transaction(() => {
    for (const [name, address, type, description, unit] of tags) {
      const existing = find.get(device.id, name);
      if (existing) update.run(address, type, description, unit, existing.id);
      else insert.run(device.id, name, address, type, description, unit);
    }
  })();
}

// One-time compatibility migration from the former vendor-specific schema.
function migratePrinterArchitecture(db) {
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  // Keep dependent foreign-key declarations pointed at the final table names
  // while each legacy table is renamed for data copying.
  db.pragma('legacy_alter_table = ON');
  if (columns('printers').includes('printer_type')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`ALTER TABLE printers RENAME TO printers_legacy;
      CREATE TABLE printers (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT,manufacturer TEXT NOT NULL DEFAULT 'Godex',model TEXT,ip_address TEXT,port INTEGER DEFAULT 9100,command_language TEXT,dpi INTEGER DEFAULT 203,label_width REAL DEFAULT 4.0,label_height REAL DEFAULT 2.0,is_active INTEGER NOT NULL DEFAULT 1,connection_status TEXT DEFAULT 'unknown' CHECK(connection_status IN ('online','offline','error','printing','unknown','demo')),last_connected TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO printers SELECT id,'Godex Printer','Godex label printer','Godex',NULL,ip_address,port,NULL,dpi,label_width,label_height,is_active,'unknown',NULL,created_at,updated_at FROM printers_legacy;
      DROP TABLE printers_legacy;`);
    db.pragma('foreign_keys = ON');
  }
  if (columns('label_templates').includes('zpl_template')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`ALTER TABLE label_templates RENAME TO label_templates_legacy;
      CREATE TABLE label_templates (id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,description TEXT,definition TEXT NOT NULL,variables TEXT,preview_image TEXT,is_active INTEGER DEFAULT 1,created_by TEXT REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO label_templates SELECT id,name,description,'{"width":4,"height":2,"fields":[{"key":"productName","type":"text"},{"key":"jobId","type":"text"},{"key":"productionDate","type":"text"},{"key":"barcode","type":"barcode"},{"key":"quantity","type":"text"}]}','["productName","jobId","productionDate","barcode","quantity"]',preview_image,is_active,created_by,created_at,updated_at FROM label_templates_legacy;
      DROP TABLE label_templates_legacy;`);
    db.pragma('foreign_keys = ON');
  }
  if (columns('print_jobs').includes('zpl_content')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`ALTER TABLE print_jobs RENAME TO print_jobs_legacy;
      CREATE TABLE print_jobs (id TEXT PRIMARY KEY,printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,user_id TEXT REFERENCES users(id) ON DELETE SET NULL,job_name TEXT NOT NULL,template_name TEXT,payload_content TEXT NOT NULL DEFAULT '',copies INTEGER DEFAULT 1,status TEXT DEFAULT 'pending',error_message TEXT,metadata TEXT,started_at TEXT,completed_at TEXT,created_at TEXT NOT NULL);
      INSERT INTO print_jobs SELECT id,printer_id,user_id,job_name,template_name,'{"legacy":true}',copies,status,error_message,metadata,started_at,completed_at,created_at FROM print_jobs_legacy;
      DROP TABLE print_jobs_legacy;`);
    db.pragma('foreign_keys = ON');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_print_jobs_printer ON print_jobs(printer_id, created_at DESC);`);
}

function migrateWindowsPrinterArchitecture(db) {
  const printerColumns = new Set(db.prepare('PRAGMA table_info(printers)').all().map((column) => column.name));
  const printerAdditions = [
    ['queue_name', 'TEXT'],
    ['print_mode', "TEXT NOT NULL DEFAULT 'WINDOWS_QUEUE'"],
    ['is_enabled', 'INTEGER NOT NULL DEFAULT 1'],
    ['is_default', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_seen_at', 'TEXT'],
    ['last_error', 'TEXT'],
  ];
  for (const [name, type] of printerAdditions) {
    if (!printerColumns.has(name)) db.exec(`ALTER TABLE printers ADD COLUMN ${name} ${type}`);
  }

  const printerSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='printers'").pluck().get() || '';
  if (!/CHECK\s*\(\s*print_mode\s+IN\s*\(\s*'WINDOWS_QUEUE'\s*,\s*'RAW_TCP_LEGACY'\s*\)\s*\)/i.test(printerSql)) {
    const printerObjects = db.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name='printers'
      AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`).all();
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');
    db.transaction(() => {
      db.exec(`ALTER TABLE printers RENAME TO printers_pre_print_mode_check;
        CREATE TABLE printers (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),name TEXT NOT NULL,description TEXT,
          ip_address TEXT,port INTEGER DEFAULT 9100,manufacturer TEXT NOT NULL DEFAULT 'Godex',model TEXT,
          command_language TEXT,label_width REAL DEFAULT 4.0,label_height REAL DEFAULT 2.0,dpi INTEGER DEFAULT 203,
          is_active INTEGER NOT NULL DEFAULT 1,
          connection_status TEXT DEFAULT 'unknown' CHECK(connection_status IN ('online','offline','error','printing','unknown','demo')),
          last_connected TEXT,queue_name TEXT,
          print_mode TEXT NOT NULL DEFAULT 'WINDOWS_QUEUE' CHECK(print_mode IN ('WINDOWS_QUEUE','RAW_TCP_LEGACY')),
          is_enabled INTEGER NOT NULL DEFAULT 1,is_default INTEGER NOT NULL DEFAULT 0,last_seen_at TEXT,last_error TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        INSERT INTO printers (id,name,description,ip_address,port,manufacturer,model,command_language,label_width,label_height,dpi,is_active,connection_status,last_connected,queue_name,print_mode,is_enabled,is_default,last_seen_at,last_error,created_at,updated_at)
        SELECT id,name,description,ip_address,port,manufacturer,model,command_language,label_width,label_height,dpi,is_active,connection_status,last_connected,queue_name,print_mode,is_enabled,is_default,last_seen_at,last_error,created_at,updated_at FROM printers_pre_print_mode_check;
        DROP TABLE printers_pre_print_mode_check;`);
      for (const object of printerObjects) db.exec(object.sql);
    })();
    db.pragma('legacy_alter_table = OFF');
    db.pragma('foreign_keys = ON');
  }

  const jobColumns = new Set(db.prepare('PRAGMA table_info(print_jobs)').all().map((column) => column.name));
  if (!jobColumns.has('rendered_at')) {
    db.pragma('foreign_keys = OFF');
    const migrate = db.transaction(() => {
      db.exec(`ALTER TABLE print_jobs RENAME TO print_jobs_pre_windows;
        CREATE TABLE print_jobs (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,
          user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          production_job_id TEXT REFERENCES production_jobs(id) ON DELETE SET NULL,
          job_name TEXT NOT NULL,
          template_name TEXT,
          template_id TEXT REFERENCES label_templates(id) ON DELETE SET NULL,
          queue_name_snapshot TEXT,
          rendered_file TEXT,
          payload_content TEXT NOT NULL DEFAULT '',
          copies INTEGER DEFAULT 1,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending','rendered','submitted','printing','completed','failed','cancelled','unknown')),
          error_message TEXT,
          metadata TEXT,
          started_at TEXT,
          rendered_at TEXT,
          submitted_at TEXT,
          completed_at TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        INSERT INTO print_jobs (id,printer_id,user_id,job_name,template_name,payload_content,copies,status,error_message,metadata,started_at,completed_at,created_at)
        SELECT id,printer_id,user_id,job_name,template_name,payload_content,copies,
          CASE lower(status) WHEN 'pending' THEN 'pending' WHEN 'printing' THEN 'unknown' WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' ELSE 'unknown' END,
          error_message,metadata,started_at,completed_at,created_at FROM print_jobs_pre_windows;
        DROP TABLE print_jobs_pre_windows;`);
    });
    migrate();
    db.pragma('foreign_keys = ON');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_print_jobs_printer ON print_jobs(printer_id, created_at DESC);`);
}

async function initDb() {
  logger.info('Starting database initialization...');
  initializeSchema();

  const db = getDb();
  migratePrinterArchitecture(db);
  migrateWindowsPrinterArchitecture(db);
  migrateLegacyProtocol(db);
  migrateLegacyMoveTag(db);
  migrateProductPlcFields(db);
  migratePhase2Workflow(db);

  const existingAdmin = db.prepare('SELECT id, password FROM users WHERE username = ?').get('admin');
  if (!existingAdmin) {
    const hashedPassword = await bcrypt.hash('Admin@123', 12);
    db.prepare(`
      INSERT INTO users (username, password, full_name, email, role)
      VALUES (?, ?, ?, ?, ?)
    `).run('admin', hashedPassword, 'Administrator', 'admin@system.local', 'admin');
    logger.info('Default admin user created: admin / Admin@123 (bcrypt)');
  } else if (!String(existingAdmin.password).startsWith('$2')) {
    const hashedPassword = await bcrypt.hash('Admin@123', 12);
    db.prepare('UPDATE users SET password = ?, updated_at = ? WHERE username = ?')
      .run(hashedPassword, new Date().toISOString(), 'admin');
    logger.info('Migrated admin password from plaintext to bcrypt');
  }

  const existingPlc = db.prepare('SELECT id FROM plc_devices WHERE name = ?').get('PLC-SIEMENS-S71200');
  let plcId = existingPlc?.id;
  if (!existingPlc) {
    plcId = crypto.randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO plc_devices (id, name, description, ip_address, port, protocol, slot, rack)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(plcId, 'PLC-SIEMENS-S71200', 'Siemens S7-1200 TCP Socket - Line 1', '192.168.0.1', 2000, 's7-tcp', 0, 1);

    const tags = [
      { name: 'MachineState', address: 'PLC.MACHINE_STATE', type: 'INT', desc: 'Trạng thái máy', monitored: 1 },
      { name: 'JobLoaded', address: 'PLC.JOB_LOADED', type: 'BOOL', desc: 'Job đã được PLC nạp', monitored: 1 },
      { name: 'ProductID', address: 'PLC.PRODUCT_ID', type: 'INT', desc: 'Product ID', monitored: 1 },
      { name: 'RecipeID', address: 'PLC.RECIPE_ID', type: 'INT', desc: 'Recipe ID', monitored: 1 },
      { name: 'TargetQty', address: 'PLC.TARGET_QTY', type: 'INT', desc: 'Số lượng mục tiêu', unit: 'pcs', monitored: 1 },
      { name: 'MachineReady', address: 'PLC.MACHINE_READY', type: 'BOOL', desc: 'Máy sẵn sàng', monitored: 1 },
      { name: 'MachineRunning', address: 'PLC.MACHINE_RUNNING', type: 'BOOL', desc: 'Máy đang chạy', monitored: 1 },
      { name: 'MachineFault', address: 'PLC.MACHINE_FAULT', type: 'BOOL', desc: 'Máy báo lỗi', monitored: 1 },
      { name: 'FaultCode', address: 'PLC.FAULT_CODE', type: 'INT', desc: 'Mã lỗi', monitored: 1 },
      { name: 'AxisReady', address: 'PLC.AXIS_READY', type: 'BOOL', desc: 'Trục sẵn sàng', monitored: 1 },
      { name: 'MoveBusy', address: 'PLC.MOVE_BUSY', type: 'BOOL', desc: 'Trục đang di chuyển', monitored: 1 },
      { name: 'HaltBusy', address: 'PLC.HALT_BUSY', type: 'BOOL', desc: 'Trục đang dừng có kiểm soát', monitored: 1 },
      { name: 'AxisPositioning', address: 'PLC.AXIS_POSITIONING', type: 'BOOL', desc: 'Trục đang định vị', monitored: 1 },
      { name: 'HomeBusy', address: 'PLC.HOME_BUSY', type: 'BOOL', desc: 'Trục đang homing', monitored: 1 },
      { name: 'MotionState', address: 'PLC.MOTION_STATE', type: 'INT', desc: 'Trạng thái motion', monitored: 1 },
    ];

    const insertTag = db.prepare(`
      INSERT INTO plc_tags (id, device_id, tag_name, address, data_type, description, unit, alarm_high, alarm_low, is_writable, is_monitored)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (const tag of tags) {
        insertTag.run(plcId, tag.name, tag.address, tag.type, tag.desc, tag.unit || null,
          tag.alarm_high || null, tag.alarm_low || null, tag.writable ? 1 : 0, tag.monitored);
      }
    })();

    logger.info(`Seeded Siemens PLC: ${plcId} (192.168.0.1:2000) with ${tags.length} command-state tags`);
  } else {
    db.prepare(`
      UPDATE plc_devices SET ip_address = '192.168.0.1', port = 2000, protocol = 's7-tcp', updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), plcId);
  }
  migrateDbSocketTags(db);

  let templateId = null;
  const existingTemplate = db.prepare('SELECT id FROM label_templates WHERE name = ?').get('product-label');
  if (!existingTemplate) {
    const definition = JSON.stringify({ width: 4, height: 2, fields: [
      { key: 'productName', type: 'text' }, { key: 'jobId', type: 'text' },
      { key: 'productionDate', type: 'text' }, { key: 'barcode', type: 'barcode' },
      { key: 'quantity', type: 'text' },
    ] });

    templateId = crypto.randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO label_templates (id, name, description, definition, variables)
      VALUES (?, ?, ?, ?, ?)
    `).run(templateId, 'product-label', 'Nhãn sản phẩm tiêu chuẩn', definition,
      JSON.stringify(['productName', 'jobId', 'productionDate', 'barcode', 'quantity']));
    logger.info('Seeded label template: product-label');
  } else {
    templateId = existingTemplate.id;
  }

  const sampleProducts = [
    { barcode: 'PROD-001', name: 'Sản phẩm A - Động cơ điện 1HP', target_revs: 1500, speed_rpm: 600 },
    { barcode: 'PROD-002', name: 'Sản phẩm B - Động cơ điện 2HP', target_revs: 2000, speed_rpm: 800 },
    { barcode: 'LOT-12345', name: 'Sản phẩm C - Trục xoay công nghiệp', target_revs: 3000, speed_rpm: 1000 },
  ];

  const insertProduct = db.prepare(`
    INSERT OR IGNORE INTO products (barcode, name, target_revs, speed_rpm, label_template_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const prod of sampleProducts) {
    insertProduct.run(prod.barcode, prod.name, prod.target_revs, prod.speed_rpm, templateId);
  }
  logger.info(`Seeded ${sampleProducts.length} sample products`);

  const existingPrinter = db.prepare("SELECT id FROM printers WHERE manufacturer = 'Godex' LIMIT 1").get();
  if (!existingPrinter) {
    db.prepare(`
      INSERT INTO printers (name, description, manufacturer, model, ip_address, port, command_language, label_width, label_height, dpi)
      VALUES (?, ?, 'Godex', ?, ?, ?, ?, ?, ?, ?)
    `).run('Godex Printer', 'Godex label printer', config.godex.model || null, config.godex.ip, config.godex.port, config.godex.commandLanguage || null, 4.0, 2.0, 203);
    logger.info('Seeded Godex printer');
  }

  logger.info('Database initialization complete (SQLite + bcrypt users)');
}

if (require.main === module) {
  initDb()
    .then(() => process.exit(0))
    .catch(err => {
      logger.error('Database init failed:', err);
      process.exit(1);
    });
}

module.exports = { initDb, migratePhase2Workflow };
