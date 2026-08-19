const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('../config/logger');

let db = null;

/**
 * Initialize and return the SQLite database instance (singleton)
 */
function getDb() {
  if (db) return db;

  const dbPath = path.resolve(config.database.path);
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    logger.info(`Created database directory: ${dbDir}`);
  }

  db = new Database(dbPath, {
    verbose: config.server.env === 'development' ? (sql) => logger.debug(`SQL: ${sql}`) : null,
  });

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -32000'); // 32MB cache
  db.pragma('temp_store = MEMORY');

  logger.info(`REAL SQLite database connected: ${dbPath}`);
  return db;
}

/**
 * Initialize schema from SQL file
 */
function initializeSchema() {
  const db = getDb();
  const schemaPath = path.resolve(__dirname, '../../database/schema.sql');

  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found: ${schemaPath}`);
  }

  const schema = fs.readFileSync(schemaPath, 'utf8');

  // Execute schema via exec() or statement execution
  try {
    db.exec(schema);
    logger.info('Database schema initialized successfully');
  } catch (err) {
    logger.error('Error initializing schema:', err);
    throw err;
  }
}

/**
 * Close the database connection gracefully
 */
function closeDb() {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

module.exports = { getDb, initializeSchema, closeDb };

