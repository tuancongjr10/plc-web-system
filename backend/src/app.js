require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const logger = require('./config/logger');
const { initDb } = require('./models/initDb');
const { initWebSocket } = require('./websocket/wsHandler');
const plcService = require('./services/plc/plcService');
const printerService = require('./services/printer/printerService');

// Routes
const authRoutes = require('./routes/authRoutes');
const plcRoutes = require('./routes/plcRoutes');
const printerRoutes = require('./routes/printerRoutes');
const scannerRoutes = require('./routes/scannerRoutes');
const productRoutes = require('./routes/productRoutes');
const jobRoutes = require('./routes/jobRoutes');

// ============================================================
// Express App Setup
// ============================================================
const app = express();
const server = http.createServer(app);

// Security
app.use(helmet({
  contentSecurityPolicy: false, // Disabled to allow Vue SPA
  crossOriginEmbedderPolicy: false,
}));

// CORS
app.use(cors({
  origin: config.cors.origin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Compression
app.use(compression());

// Request parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// HTTP request logging
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: (req) => req.url === '/api/health',
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: { success: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Static files (scanned images, uploads)
const uploadsPath = path.resolve('./uploads');
if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });
app.use('/uploads', express.static(uploadsPath));

// ============================================================
// API Routes
// ============================================================
app.use('/api/auth', authRoutes);
app.use('/api/plc', plcRoutes);
app.use('/api/printers', printerRoutes);
app.use('/api/scanner', scannerRoutes);
app.use('/api/products', productRoutes);
app.use('/api/jobs', jobRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  const plcStatuses = plcService.getAllStatuses();
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    demoMode: config.demoMode,
    plc: {
      protocol: 's7-tcp',
      ip: config.plc.defaultIp,
      port: config.plc.defaultPort,
    },
    services: {
      plc: {
        devices: plcStatuses.length,
        connected: plcStatuses.filter(s => s.connected).length,
        demoSessions: plcStatuses.filter(s => s.isDemo).length,
      },
    },
  });
});

// Serve Vue SPA in production
if (config.server.env === 'production') {
  const frontendDist = path.resolve('../frontend/dist');
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get('*', (req, res) => {
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
    logger.info('Serving Vue SPA from dist/');
  }
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.path} not found` });
});

// Global error handler
app.use((err, req, res, _next) => {
  logger.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: config.server.env === 'production' ? 'Internal server error' : err.message,
  });
});

// ============================================================
// Startup
// ============================================================
async function start() {
  try {
    logger.info('='.repeat(50));
    logger.info('  PLC Web Control System v1.0.0');
    logger.info('='.repeat(50));

    // Initialize database
    logger.info('Initializing database...');
    await initDb();

    // Initialize WebSocket
    initWebSocket(server);

    // Start PLC service
    logger.info('Starting PLC service...');
    await plcService.startAll();

    // Start the configured printer service
    logger.info('Starting printer service...');
    printerService.start();

    // Start HTTP server
    server.listen(config.server.port, config.server.host, () => {
      logger.info(`Server running at http://${config.server.host}:${config.server.port}`);
      logger.info(`WebSocket available at ws://${config.server.host}:${config.server.port}/ws`);
      logger.info(`Environment: ${config.server.env}`);
      logger.info('System ready!');
    });

  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

// ============================================================
// Graceful Shutdown
// ============================================================
async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  server.close(async () => {
    try {
      await plcService.shutdown();
      printerService.stop();
      const { closeDb } = require('./models/database');
      closeDb();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Shutdown error:', err);
      process.exit(1);
    }
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

start();

module.exports = { app, server };
