/**
 * Read-only smoke test. It intentionally never scans, starts/stops/resets a job,
 * writes a tag, prints, or calls any PLC command endpoint.
 */
const BASE = process.env.API_BASE_URL || 'http://127.0.0.1:3000';
let passed = 0;
let failed = 0;

function ok(name, detail = '') { passed++; console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
function fail(name, detail) { failed++; console.error(`FAIL  ${name} — ${detail}`); }

async function request(path, token) {
  const response = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const json = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${json.error || path}`);
  return json;
}

(async () => {
  try {
    const health = await request('/api/health');
    ok('backend health', `demoMode=${health.demoMode}`);
  } catch (error) { fail('backend health', error.message); }

  let token;
  try {
    const response = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Admin@123' }),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || String(response.status));
    token = json.data.accessToken;
    ok('login');
  } catch (error) { fail('login', error.message); }

  if (token) {
    for (const [name, path] of [
      ['products read', '/api/products'],
      ['PLC device status read', '/api/plc/devices'],
      ['active job read', '/api/jobs/active'],
      ['printer status read', '/api/printers'],
    ]) {
      try { await request(path, token); ok(name); }
      catch (error) { fail(name, error.message); }
    }
  }

  console.log(`\npassed: ${passed}  failed: ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
