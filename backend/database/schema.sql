-- ============================================================
-- PLC Web System Database Schema
-- SQLite - plc_system.db
-- Siemens S7-1200 TCP Socket + Godex printer + Scanner workflow
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- ============================================================
-- USERS & AUTHENTICATION
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  username    TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,
  full_name   TEXT NOT NULL,
  email       TEXT UNIQUE,
  role        TEXT NOT NULL DEFAULT 'operator' CHECK(role IN ('admin', 'operator', 'viewer')),
  is_active   INTEGER NOT NULL DEFAULT 1,
  last_login  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT UNIQUE NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- PRINTERS & LABEL TEMPLATES (created before products for FKs)
-- ============================================================
CREATE TABLE IF NOT EXISTS printers (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name        TEXT NOT NULL,
  description TEXT,
  ip_address  TEXT,
  port        INTEGER DEFAULT 9100,
  manufacturer TEXT NOT NULL DEFAULT 'Godex',
  model       TEXT,
  command_language TEXT,
  label_width REAL DEFAULT 4.0,
  label_height REAL DEFAULT 2.0,
  dpi         INTEGER DEFAULT 203,
  is_active   INTEGER NOT NULL DEFAULT 1,
  connection_status TEXT DEFAULT 'unknown' CHECK(connection_status IN ('online', 'offline', 'error', 'printing', 'unknown', 'demo')),
  last_connected TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS label_templates (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name        TEXT UNIQUE NOT NULL,
  description TEXT,
  definition  TEXT NOT NULL,
  variables   TEXT,
  preview_image TEXT,
  is_active   INTEGER DEFAULT 1,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- PRODUCTS & PRODUCTION WORKFLOW
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  barcode             TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  target_revs         INTEGER NOT NULL DEFAULT 1000,
  speed_rpm           INTEGER NOT NULL DEFAULT 500,
  label_template_id   TEXT REFERENCES label_templates(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS production_jobs (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  job_code            TEXT UNIQUE NOT NULL,
  product_id          TEXT REFERENCES products(id) ON DELETE SET NULL,
  target_revs         INTEGER NOT NULL,
  speed_rpm           INTEGER NOT NULL,
  label_template_id   TEXT REFERENCES label_templates(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created', 'running', 'stopped', 'completed', 'failed')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS production_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT REFERENCES production_jobs(id) ON DELETE CASCADE,
  product_id  TEXT REFERENCES products(id) ON DELETE SET NULL,
  action      TEXT NOT NULL CHECK(action IN ('START', 'STOP', 'HOME', 'SCAN', 'PRINT')),
  command_sent TEXT,
  response    TEXT,
  status      TEXT DEFAULT 'success',
  details     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- PLC DEVICES (Siemens S7-1200 TCP Socket)
-- ============================================================
CREATE TABLE IF NOT EXISTS plc_devices (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name            TEXT NOT NULL,
  description     TEXT,
  ip_address      TEXT NOT NULL,
  port            INTEGER NOT NULL DEFAULT 2000,
  protocol        TEXT NOT NULL DEFAULT 's7-tcp' CHECK(protocol IN ('s7-tcp', 's7', 'modbus-tcp', 'opc-ua')),
  slot            INTEGER DEFAULT 0,
  rack            INTEGER DEFAULT 0,
  poll_interval   INTEGER DEFAULT 1000,
  is_active       INTEGER NOT NULL DEFAULT 1,
  connection_status TEXT DEFAULT 'disconnected' CHECK(connection_status IN ('connected', 'disconnected', 'error', 'connecting')),
  last_connected  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS plc_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL CHECK(event_type IN ('CONNECT', 'DISCONNECT', 'COMMAND', 'ERROR', 'STATUS')),
  message      TEXT NOT NULL,
  command_sent TEXT,
  response     TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS plc_tags (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  device_id   TEXT NOT NULL REFERENCES plc_devices(id) ON DELETE CASCADE,
  tag_name    TEXT NOT NULL,
  address     TEXT NOT NULL,
  data_type   TEXT NOT NULL DEFAULT 'BOOL' CHECK(data_type IN ('BOOL','INT','DINT','REAL','STRING','WORD','DWORD','SINT','UINT','UDINT','USINT')),
  description TEXT,
  unit        TEXT,
  scale_factor REAL DEFAULT 1.0,
  offset      REAL DEFAULT 0.0,
  min_value   REAL,
  max_value   REAL,
  alarm_low   REAL,
  alarm_high  REAL,
  is_writable INTEGER NOT NULL DEFAULT 0,
  is_monitored INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(device_id, tag_name)
);

CREATE TABLE IF NOT EXISTS plc_tag_values (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id      TEXT NOT NULL REFERENCES plc_tags(id) ON DELETE CASCADE,
  value       TEXT,
  quality     TEXT DEFAULT 'good' CHECK(quality IN ('good', 'bad', 'uncertain')),
  timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS plc_alarms (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  device_id   TEXT NOT NULL REFERENCES plc_devices(id) ON DELETE CASCADE,
  tag_id      TEXT REFERENCES plc_tags(id) ON DELETE SET NULL,
  alarm_type  TEXT NOT NULL CHECK(alarm_type IN ('high', 'low', 'disconnect', 'error')),
  severity    TEXT NOT NULL DEFAULT 'warning' CHECK(severity IN ('info', 'warning', 'critical')),
  message     TEXT NOT NULL,
  value       TEXT,
  is_acknowledged INTEGER DEFAULT 0,
  acknowledged_by TEXT REFERENCES users(id),
  acknowledged_at TEXT,
  triggered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT
);

-- ============================================================
-- PRINT JOBS
-- ============================================================
CREATE TABLE IF NOT EXISTS print_jobs (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  printer_id    TEXT REFERENCES printers(id) ON DELETE SET NULL,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  job_name      TEXT NOT NULL,
  template_name TEXT,
  payload_content TEXT NOT NULL,
  copies        INTEGER DEFAULT 1,
  status        TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'printing', 'completed', 'failed', 'cancelled')),
  error_message TEXT,
  metadata      TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- SCANNER / QR / BARCODE
-- USB HID / manual now; network|ethernet reserved for future Ethernet scanners
-- ============================================================
CREATE TABLE IF NOT EXISTS scan_records (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  scan_source TEXT DEFAULT 'usb' CHECK(scan_source IN ('camera', 'usb', 'network', 'ethernet', 'manual')),
  barcode_type TEXT,
  barcode_data TEXT,
  raw_image   TEXT,
  metadata    TEXT,
  processed   INTEGER DEFAULT 0,
  process_result TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- SYSTEM SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  type        TEXT DEFAULT 'string' CHECK(type IN ('string','number','boolean','json')),
  description TEXT,
  category    TEXT DEFAULT 'general',
  updated_by  TEXT REFERENCES users(id),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- AUDIT LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  username    TEXT,
  action      TEXT NOT NULL,
  resource    TEXT,
  resource_id TEXT,
  details     TEXT,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_production_jobs_code ON production_jobs(job_code);
CREATE INDEX IF NOT EXISTS idx_production_jobs_status ON production_jobs(status);
CREATE INDEX IF NOT EXISTS idx_production_logs_job ON production_logs(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plc_events_type ON plc_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plc_tag_values_tag_ts ON plc_tag_values(tag_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_plc_tag_values_ts ON plc_tag_values(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_plc_alarms_device ON plc_alarms(device_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_plc_alarms_unacked ON plc_alarms(is_acknowledged, severity);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_jobs_printer ON print_jobs(printer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_records_ts ON scan_records(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_ts ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ============================================================
-- DEFAULT SYSTEM SETTINGS
-- ============================================================
INSERT OR IGNORE INTO system_settings (key, value, type, description, category) VALUES
  ('system.name', 'PLC Web Control System', 'string', 'Tên hệ thống', 'general'),
  ('system.version', '1.0.0', 'string', 'Phiên bản', 'general'),
  ('plc.protocol', 's7-tcp', 'string', 'Siemens S7-1200 TCP Socket', 'plc'),
  ('plc.default_ip', '192.168.0.1', 'string', 'IP PLC Siemens mặc định', 'plc'),
  ('plc.default_port', '2000', 'number', 'Cổng TCP Socket PLC', 'plc'),
  ('plc.auto_reconnect', 'true', 'boolean', 'Tự động kết nối lại PLC', 'plc'),
  ('plc.max_retries', '3', 'number', 'Số lần thử kết nối lại tối đa', 'plc'),
  ('plc.log_retention_days', '30', 'number', 'Số ngày giữ log PLC', 'plc'),
  ('printer.default_copies', '1', 'number', 'Số bản in mặc định', 'printer'),
  ('scanner.auto_process', 'true', 'boolean', 'Tự động xử lý mã sau khi quét', 'scanner'),
  ('auth.session_timeout_hours', '8', 'number', 'Thời gian hết phiên đăng nhập', 'auth');
