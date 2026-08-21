const path = require('path');

const backendRoot = path.resolve(__dirname, '../..');
const envFile = path.join(backendRoot, '.env');
require('dotenv').config({ path: envFile });

function backendPath(value, fallback) {
  const configured = value || fallback;
  return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(backendRoot, configured);
}

const demoMode = String(process.env.DEMO_MODE || 'true').toLowerCase() !== 'false';

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  paths: {
    backendRoot,
    envFile,
    frontendDist: path.resolve(backendRoot, '../frontend/dist'),
    uploads: path.join(backendRoot, 'uploads'),
  },
  server: {
    port: parseInt(process.env.PORT) || 3000,
    host: process.env.HOST || '0.0.0.0',
    env: process.env.NODE_ENV || 'development',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'default_secret_change_in_production',
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  database: {
    path: backendPath(process.env.DB_PATH, 'database/plc_system.db'),
  },

  // Global DEMO_MODE: simulate devices when hardware is absent.
  // REAL MODE (DEMO_MODE=false): never fake PLC / printer / scanner ONLINE.
  demoMode,

  plc: {
    defaultIp: process.env.PLC_DEFAULT_IP || '192.168.0.1',
    defaultPort: parseInt(process.env.PLC_DEFAULT_PORT) || 2000,
    pollIntervalMs: parseInt(process.env.PLC_POLL_INTERVAL_MS) || 1000,
    statusPollMs: parseInt(process.env.PLC_STATUS_POLL_MS, 10) || 1000,
    telemetryFreshMs: parseInt(process.env.PLC_TELEMETRY_FRESH_MS, 10) || 5000,
    responseTimeoutMs: parseInt(process.env.PLC_RESPONSE_TIMEOUT_MS, 10) || 1000,
    connectionTimeoutMs: parseInt(process.env.PLC_CONNECTION_TIMEOUT_MS) || 3000,
    protocol: 's7-tcp',
    demoMode,
  },

  godex: {
    ip: process.env.GODEX_PRINTER_IP || '192.168.1.20',
    port: parseInt(process.env.GODEX_PRINTER_PORT, 10) || 9100,
    model: process.env.GODEX_PRINTER_MODEL || '',
    commandLanguage: process.env.GODEX_COMMAND_LANGUAGE || '',
    connectTimeoutMs: parseInt(process.env.GODEX_CONNECT_TIMEOUT_MS, 10) || 3000,
    labelWidth: parseFloat(process.env.GODEX_PRINTER_DEFAULT_LABEL_WIDTH) || 4,
    labelHeight: parseFloat(process.env.GODEX_PRINTER_DEFAULT_LABEL_HEIGHT) || 2,
  },

  printer: {
    labelTempRetentionHours: positiveNumber(process.env.PRINT_LABEL_TEMP_RETENTION_HOURS, 48),
    spoolerReconcileMaxHours: positiveNumber(process.env.PRINT_SPOOLER_RECONCILE_MAX_HOURS, 12),
  },

  scanner: {
    timeoutMs: parseInt(process.env.SCANNER_SCAN_TIMEOUT_MS) || 10000,
    filesPath: backendPath(process.env.SCAN_FILES_PATH, 'uploads/scans'),
  },

  websocket: {
    heartbeatIntervalMs: parseInt(process.env.WS_HEARTBEAT_INTERVAL_MS) || 30000,
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    filePath: backendPath(process.env.LOG_FILE_PATH, 'logs/app.log'),
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
    readMax: parseInt(process.env.RATE_LIMIT_READ_MAX_REQUESTS) || 3000,
    writeMax: parseInt(process.env.RATE_LIMIT_WRITE_MAX_REQUESTS) || 120,
    authMax: parseInt(process.env.RATE_LIMIT_AUTH_MAX_REQUESTS) || 10,
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  },
};
