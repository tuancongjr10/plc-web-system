const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../database/plc_system.db');
const db = new Database(dbPath, { fileMustExist: true });

const columns = [
  'id', 'name', 'description', 'ip_address', 'port', 'manufacturer', 'model',
  'command_language', 'label_width', 'label_height', 'dpi', 'is_active',
  'connection_status', 'last_connected', 'queue_name', 'print_mode', 'is_enabled',
  'is_default', 'last_seen_at', 'last_error', 'created_at', 'updated_at',
];

try {
  const modes = db.prepare('SELECT print_mode, COUNT(*) count FROM printers GROUP BY print_mode ORDER BY print_mode').all();
  const invalid = modes.filter(({ print_mode: mode }) => !['WINDOWS_QUEUE', 'RAW_TCP_LEGACY'].includes(mode));
  if (invalid.length) throw new Error(`invalid_print_mode_values:${JSON.stringify(invalid)}`);

  const rowCountBefore = db.prepare('SELECT COUNT(*) FROM printers').pluck().get();
  const objects = db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE tbl_name='printers' AND type IN ('index','trigger') AND sql IS NOT NULL
    ORDER BY type,name`).all();

  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  db.transaction(() => {
    db.exec(`
      ALTER TABLE printers RENAME TO printers_pre_schema_sync;
      CREATE TABLE printers (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL,
        description TEXT,
        ip_address TEXT,
        port INTEGER DEFAULT 9100,
        manufacturer TEXT NOT NULL DEFAULT 'Godex',
        model TEXT,
        command_language TEXT,
        label_width REAL DEFAULT 4.0,
        label_height REAL DEFAULT 2.0,
        dpi INTEGER DEFAULT 203,
        is_active INTEGER NOT NULL DEFAULT 1,
        connection_status TEXT DEFAULT 'unknown' CHECK(connection_status IN ('online', 'offline', 'error', 'printing', 'unknown', 'demo')),
        last_connected TEXT,
        queue_name TEXT,
        print_mode TEXT NOT NULL DEFAULT 'WINDOWS_QUEUE' CHECK(print_mode IN ('WINDOWS_QUEUE', 'RAW_TCP_LEGACY')),
        is_enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO printers (${columns.join(',')})
      SELECT ${columns.join(',')} FROM printers_pre_schema_sync;
    `);

    const rowCountAfter = db.prepare('SELECT COUNT(*) FROM printers').pluck().get();
    const missingIds = db.prepare('SELECT id FROM printers_pre_schema_sync EXCEPT SELECT id FROM printers').all();
    const extraIds = db.prepare('SELECT id FROM printers EXCEPT SELECT id FROM printers_pre_schema_sync').all();
    if (rowCountAfter !== rowCountBefore || missingIds.length || extraIds.length) {
      throw new Error(`printer_copy_verification_failed:${rowCountBefore}:${rowCountAfter}`);
    }

    db.exec('DROP TABLE printers_pre_schema_sync');
    for (const object of objects) db.exec(object.sql);
  })();
  db.pragma('legacy_alter_table = OFF');
  db.pragma('foreign_keys = ON');

  const foreignKeyViolations = db.pragma('foreign_key_check');
  if (foreignKeyViolations.length) throw new Error(`foreign_key_check_failed:${JSON.stringify(foreignKeyViolations)}`);
  console.log(JSON.stringify({ dbPath, modes, rowCountBefore, objects, integrity: db.pragma('integrity_check', { simple: true }) }, null, 2));
} finally {
  db.close();
}
