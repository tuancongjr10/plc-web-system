const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const action = process.argv[2];
const allowed = new Set(['install', 'uninstall', 'start', 'stop', 'status']);
if (!allowed.has(action)) {
  console.error('Usage: node scripts/windows-service.js <install|uninstall|start|stop|status>');
  process.exit(2);
}

const backendRoot = path.resolve(__dirname, '..');
const wrapper = path.join(backendRoot, 'service', 'PLCWebSystem.exe');
const config = path.join(backendRoot, 'service', 'PLCWebSystem.xml');

for (const required of [wrapper, config, path.join(backendRoot, '.env'), path.resolve(backendRoot, '../frontend/dist/index.html')]) {
  if (!fs.existsSync(required)) {
    console.error(`Required deployment file not found: ${required}`);
    process.exit(1);
  }
}

const result = spawnSync(wrapper, [action], {
  cwd: path.dirname(wrapper),
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
