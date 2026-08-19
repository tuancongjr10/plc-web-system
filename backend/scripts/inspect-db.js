const Database = require('better-sqlite3');
const db = new Database('./database/plc_system.db', { readonly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(t => t.name);
console.log('tables:', tables.join(', '));
console.log('users', db.prepare('SELECT username, substr(password,1,7) as hash FROM users').all());
console.log('products', db.prepare('SELECT barcode, target_revs, speed_rpm FROM products').all());
console.log('jobs', db.prepare('SELECT job_code, status, target_revs FROM production_jobs ORDER BY created_at DESC LIMIT 3').all());
console.log('prod_logs', db.prepare('SELECT action, command_sent, status FROM production_logs ORDER BY id DESC LIMIT 8').all());
console.log('plc_events', db.prepare('SELECT event_type, substr(message,1,80) as message FROM plc_events ORDER BY id DESC LIMIT 6').all());
console.log('printers', db.prepare('SELECT name, manufacturer, model, command_language, connection_status FROM printers').all());
console.log('print_jobs', db.prepare('SELECT status, template_name, copies FROM print_jobs ORDER BY created_at DESC LIMIT 2').all());
console.log('scans', db.prepare('SELECT barcode_data, scan_source FROM scan_records ORDER BY created_at DESC LIMIT 3').all());
console.log('plc_devices', db.prepare('SELECT name, ip_address, port, protocol, connection_status FROM plc_devices').all());
db.close();
