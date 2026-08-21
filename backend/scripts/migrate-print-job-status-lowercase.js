const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');

const dbPath = path.resolve(config.database.path);
const allowedSourceStatuses = new Set([
  'CREATED', 'RENDERED', 'SUBMITTED', 'PRINTING', 'COMPLETED', 'ERROR', 'CANCELLED', 'UNKNOWN',
  'pending', 'rendered', 'submitted', 'printing', 'completed', 'failed', 'cancelled', 'unknown',
]);

const db = new Database(dbPath, { fileMustExist: true });

function statusCounts(tableName) {
  return db.prepare(`SELECT status, COUNT(*) AS count FROM ${tableName} GROUP BY status ORDER BY status`).all();
}

try {
  const beforeStatuses = statusCounts('print_jobs');
  const unexpected = beforeStatuses.filter((row) => !allowedSourceStatuses.has(row.status));
  if (unexpected.length) {
    throw new Error(`unexpected_print_job_status:${unexpected.map((row) => row.status).join(',')}`);
  }

  const beforeCount = db.prepare('SELECT COUNT(*) FROM print_jobs').pluck().get();
  const existingSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='print_jobs'").pluck().get();
  if (!existingSchema) throw new Error('print_jobs_table_not_found');

  const indexes = db.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type='index' AND tbl_name='print_jobs' AND sql IS NOT NULL
    ORDER BY name
  `).all();

  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');

  const migrate = db.transaction(() => {
    db.exec(`
      ALTER TABLE print_jobs RENAME TO print_jobs_before_status_lowercase;

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
        status TEXT DEFAULT 'pending' CHECK(status IN (
          'pending', 'rendered', 'submitted', 'printing',
          'completed', 'failed', 'cancelled', 'unknown'
        )),
        error_message TEXT,
        metadata TEXT,
        started_at TEXT,
        rendered_at TEXT,
        submitted_at TEXT,
        completed_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      INSERT INTO print_jobs (
        id, printer_id, user_id, production_job_id, job_name,
        template_name, template_id, queue_name_snapshot, rendered_file,
        payload_content, copies, status, error_message, metadata,
        started_at, rendered_at, submitted_at, completed_at,
        retry_count, created_at
      )
      SELECT
        id, printer_id, user_id, production_job_id, job_name,
        template_name, template_id, queue_name_snapshot, rendered_file,
        payload_content, copies,
        CASE status
          WHEN 'CREATED' THEN 'pending'
          WHEN 'RENDERED' THEN 'rendered'
          WHEN 'SUBMITTED' THEN 'submitted'
          WHEN 'PRINTING' THEN 'printing'
          WHEN 'COMPLETED' THEN 'completed'
          WHEN 'ERROR' THEN 'failed'
          WHEN 'CANCELLED' THEN 'cancelled'
          WHEN 'UNKNOWN' THEN 'unknown'
          WHEN 'pending' THEN 'pending'
          WHEN 'rendered' THEN 'rendered'
          WHEN 'submitted' THEN 'submitted'
          WHEN 'printing' THEN 'printing'
          WHEN 'completed' THEN 'completed'
          WHEN 'failed' THEN 'failed'
          WHEN 'cancelled' THEN 'cancelled'
          WHEN 'unknown' THEN 'unknown'
          ELSE NULL
        END,
        error_message, metadata, started_at, rendered_at, submitted_at,
        completed_at, retry_count, created_at
      FROM print_jobs_before_status_lowercase;
    `);

    const copiedCount = db.prepare('SELECT COUNT(*) FROM print_jobs').pluck().get();
    const missingIds = db.prepare(`
      SELECT COUNT(*) FROM (
        SELECT id FROM print_jobs_before_status_lowercase
        EXCEPT
        SELECT id FROM print_jobs
      )
    `).pluck().get();
    const extraIds = db.prepare(`
      SELECT COUNT(*) FROM (
        SELECT id FROM print_jobs
        EXCEPT
        SELECT id FROM print_jobs_before_status_lowercase
      )
    `).pluck().get();
    if (copiedCount !== beforeCount || missingIds !== 0 || extraIds !== 0) {
      throw new Error(`print_jobs_copy_verification_failed:before=${beforeCount},after=${copiedCount},missing=${missingIds},extra=${extraIds}`);
    }

    const nullStatuses = db.prepare('SELECT COUNT(*) FROM print_jobs WHERE status IS NULL').pluck().get();
    if (nullStatuses !== 0) throw new Error(`print_jobs_null_status_after_mapping:${nullStatuses}`);

    db.exec('DROP TABLE print_jobs_before_status_lowercase');
    for (const index of indexes) db.exec(index.sql);

    const foreignKeyErrors = db.pragma('foreign_key_check');
    const integrity = db.pragma('integrity_check', { simple: true });
    if (foreignKeyErrors.length) throw new Error(`foreign_key_check_failed:${JSON.stringify(foreignKeyErrors)}`);
    if (integrity !== 'ok') throw new Error(`integrity_check_failed:${integrity}`);
  });

  migrate();
  db.pragma('legacy_alter_table = OFF');
  db.pragma('foreign_keys = ON');

  const afterCount = db.prepare('SELECT COUNT(*) FROM print_jobs').pluck().get();
  const afterStatuses = statusCounts('print_jobs');
  const finalSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='print_jobs'").pluck().get();
  const finalIndexes = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type='index' AND tbl_name='print_jobs'
    ORDER BY name
  `).all();
  const integrityCheck = db.pragma('integrity_check', { simple: true });
  const foreignKeyCheck = db.pragma('foreign_key_check');

  console.log(JSON.stringify({
    dbPath,
    beforeStatuses,
    beforeCount,
    afterStatuses,
    afterCount,
    finalSchema,
    finalIndexes,
    integrityCheck,
    foreignKeyCheck,
  }, null, 2));
} finally {
  db.close();
}
