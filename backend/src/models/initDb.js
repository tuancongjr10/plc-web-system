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

// One-time compatibility migration from the former vendor-specific schema.
function migratePrinterArchitecture(db) {
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  // Keep dependent foreign-key declarations pointed at the final table names
  // while each legacy table is renamed for data copying.
  db.pragma('legacy_alter_table = ON');
  if (columns('printers').includes('printer_type')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`ALTER TABLE printers RENAME TO printers_legacy;
      CREATE TABLE printers (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT,manufacturer TEXT NOT NULL DEFAULT 'Godex',model TEXT,ip_address TEXT,port INTEGER DEFAULT 9100,command_language TEXT,dpi INTEGER DEFAULT 203,label_width REAL DEFAULT 4.0,label_height REAL DEFAULT 2.0,is_active INTEGER NOT NULL DEFAULT 1,connection_status TEXT DEFAULT 'unknown',last_connected TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
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
      CREATE TABLE print_jobs (id TEXT PRIMARY KEY,printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,user_id TEXT REFERENCES users(id) ON DELETE SET NULL,job_name TEXT NOT NULL,template_name TEXT,payload_content TEXT NOT NULL,copies INTEGER DEFAULT 1,status TEXT DEFAULT 'pending',error_message TEXT,metadata TEXT,started_at TEXT,completed_at TEXT,created_at TEXT NOT NULL);
      INSERT INTO print_jobs SELECT id,printer_id,user_id,job_name,template_name,'{"legacy":true}',copies,status,error_message,metadata,started_at,completed_at,created_at FROM print_jobs_legacy;
      DROP TABLE print_jobs_legacy;`);
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
  migrateLegacyProtocol(db);

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
      { name: 'ProductionCount', address: 'CMD.COUNT', type: 'INT', desc: 'Đếm sản phẩm', unit: 'pcs', monitored: 1 },
      { name: 'MotorSpeed', address: 'CMD.SPEED', type: 'REAL', desc: 'Tốc độ động cơ (RPM)', unit: 'rpm', monitored: 1 },
      { name: 'TargetRevs', address: 'CMD.MOVE', type: 'INT', desc: 'Số vòng quay mục tiêu (MOVE=xxxx)', unit: 'rev', writable: 1, monitored: 1 },
      { name: 'EmergencyStop', address: 'CMD.ESTOP', type: 'BOOL', desc: 'Dừng khẩn cấp', monitored: 1 },
      { name: 'MachineRunning', address: 'CMD.RUN', type: 'BOOL', desc: 'Trạng thái chạy máy (START/STOP)', writable: 1, monitored: 1 },
      { name: 'PrintTrigger', address: 'CMD.PRINT', type: 'BOOL', desc: 'Kích hoạt in nhãn', writable: 1, monitored: 1 },
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

module.exports = { initDb };
