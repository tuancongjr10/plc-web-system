require('dotenv').config();

const demoMode = String(process.env.DEMO_MODE || 'true').toLowerCase() !== 'false';

module.exports = {
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
    path: process.env.DB_PATH || './database/plc_system.db',
  },

  // Global DEMO_MODE: simulate devices when hardware is absent.
  // REAL MODE (DEMO_MODE=false): never fake PLC / printer / scanner ONLINE.
  demoMode,

  plc: {
    defaultIp: process.env.PLC_DEFAULT_IP || '192.168.0.1',
    defaultPort: parseInt(process.env.PLC_DEFAULT_PORT) || 2000,
    pollIntervalMs: parseInt(process.env.PLC_POLL_INTERVAL_MS) || 1000,
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

  scanner: {
    timeoutMs: parseInt(process.env.SCANNER_SCAN_TIMEOUT_MS) || 10000,
    filesPath: process.env.SCAN_FILES_PATH || './uploads/scans',
  },

  websocket: {
    heartbeatIntervalMs: parseInt(process.env.WS_HEARTBEAT_INTERVAL_MS) || 30000,
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    filePath: process.env.LOG_FILE_PATH || './logs/app.log',
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  },
};
