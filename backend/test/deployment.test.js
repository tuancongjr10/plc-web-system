const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const config = require('../src/config');

const backendRoot = path.resolve(__dirname, '..');

test('production runtime paths are absolute and anchored to the project', () => {
  assert.equal(config.paths.backendRoot, backendRoot);
  assert.equal(config.paths.envFile, path.join(backendRoot, '.env'));
  assert.equal(config.paths.frontendDist, path.resolve(backendRoot, '../frontend/dist'));
  assert.equal(config.paths.uploads, path.join(backendRoot, 'uploads'));
  assert.equal(config.database.path, path.join(backendRoot, 'database/plc_system.db'));
  assert.equal(config.logging.filePath, path.join(backendRoot, 'logs/app.log'));
  assert.equal(config.scanner.filesPath, path.join(backendRoot, 'uploads/scans'));
});

test('production start and service commands are explicit and do not use dev servers', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.start, 'node scripts/start-production.js');
  assert.equal(packageJson.scripts['build:frontend'], 'npm --prefix ../frontend run build');
  for (const action of ['install', 'uninstall', 'start', 'stop', 'status']) {
    assert.equal(packageJson.scripts[`service:${action}`], `node scripts/windows-service.js ${action}`);
  }
  const entrypoint = fs.readFileSync(path.join(backendRoot, 'scripts/start-production.js'), 'utf8');
  assert.match(entrypoint, /process\.env\.NODE_ENV = 'production'/);
  assert.match(entrypoint, /process\.env\.PORT \|\|= '80'/);
  assert.doesNotMatch(entrypoint, /nodemon|vite/i);
});

test('SPA fallback excludes API and WebSocket paths', () => {
  const app = fs.readFileSync(path.join(backendRoot, 'src/app.js'), 'utf8');
  assert.match(app, /req\.path\.startsWith\('\/api\/'\)/);
  assert.match(app, /req\.path\.startsWith\('\/ws\/'\)/);
  assert.match(app, /uptimeSeconds/);
  assert.match(app, /database: \{ status: databaseStatus \}/);
});

test('WinSW service uses production Node, LocalService, delayed auto-start, and restart recovery', () => {
  const xml = fs.readFileSync(path.join(backendRoot, 'service/PLCWebSystem.xml'), 'utf8');
  assert.match(xml, /<name>PLC Web System<\/name>/);
  assert.match(xml, /<executable>C:\\Program Files\\nodejs\\node\.exe<\/executable>/);
  assert.match(xml, /<workingdirectory>%BASE%\\\.\.<\/workingdirectory>/);
  assert.match(xml, /<env name="PORT" value="80"\s*\/>/);
  assert.match(xml, /<domain>NT AUTHORITY<\/domain>[\s\S]*<user>LocalService<\/user>/);
  assert.match(xml, /<startmode>Automatic<\/startmode>[\s\S]*<delayedAutoStart\s*\/>/);
  assert.match(xml, /<onfailure action="restart" delay="10 sec"\s*\/>/);
  assert.doesNotMatch(xml, /interactive|reboot/i);
});

test('friendly hostname preparation never reboots Windows automatically', () => {
  const script = fs.readFileSync(path.join(backendRoot, 'scripts/prepare-friendly-hostname.ps1'), 'utf8');
  assert.match(script, /robolinks-tcjr/i);
  assert.match(script, /Rename-Computer/);
  assert.doesNotMatch(script, /Restart-Computer|-Restart\b/i);
});
