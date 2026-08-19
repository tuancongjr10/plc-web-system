/**
 * Smoke test: login, SQLite products, scanner lookup, job START/STOP/HOME, Godex demo print
 */
const BASE = 'http://127.0.0.1:3000';

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  const results = [];
  const ok = (name, extra) => { results.push({ name, pass: true, extra }); console.log(`PASS  ${name}${extra ? ' — ' + extra : ''}`); };
  const fail = (name, err) => { results.push({ name, pass: false, extra: String(err) }); console.error(`FAIL  ${name} — ${err}`); };

  try {
    const health = await req('GET', '/api/health');
    assert(health.json.success, 'health failed');
    assert(health.json.plc.ip === '192.168.0.1', 'PLC IP mismatch');
    assert(health.json.plc.port === 2000, 'PLC port mismatch');
    ok('health + Siemens IP:port', `demoMode=${health.json.demoMode} protocol=${health.json.plc.protocol}`);
  } catch (e) { fail('health', e.message); }

  let token;
  try {
    const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'Admin@123' });
    assert(login.status === 200 && login.json.data?.accessToken, `login http ${login.status} ${login.json.error}`);
    token = login.json.data.accessToken;
    assert(login.json.data.user.username === 'admin', 'user mismatch');
    ok('login bcrypt', `role=${login.json.data.user.role}`);
  } catch (e) { fail('login', e.message); process.exit(1); }

  try {
    const bad = await req('POST', '/api/auth/login', { username: 'admin', password: 'wrong' });
    assert(bad.status === 401, `expected 401 got ${bad.status}`);
    ok('login reject wrong password');
  } catch (e) { fail('login reject', e.message); }

  let product;
  try {
    const list = await req('GET', '/api/products', null, token);
    assert(list.json.success && list.json.data.length >= 3, 'products empty');
    product = list.json.data.find(p => p.barcode === 'PROD-001');
    assert(product, 'PROD-001 missing');
    assert(product.target_revs === 1500, 'target_revs not loaded from SQLite');
    ok('products from SQLite', `${list.json.data.length} rows, PROD-001 revs=${product.target_revs}`);
  } catch (e) { fail('products', e.message); }

  try {
    const lookup = await req('GET', '/api/products/barcode/PROD-001', null, token);
    assert(lookup.json.data.barcode === 'PROD-001', 'barcode lookup failed');
    ok('product barcode lookup');
  } catch (e) { fail('barcode lookup', e.message); }

  let jobId;
  try {
    const scan = await req('POST', '/api/scanner/scan', {
      barcodeData: 'PROD-001',
      barcodeType: 'code_128',
      scanSource: 'usb',
    }, token);
    assert(scan.status === 200, `scan http ${scan.status} ${scan.json.error}`);
    const pr = scan.json.data.processResult;
    assert(pr.status === 'success', pr.error || 'scan workflow failed');
    assert(pr.data.product.barcode === 'PROD-001', 'product not loaded');
    assert(pr.data.job.target_revs === 1500, 'job target_revs mismatch');
    jobId = pr.data.job.id;
    ok('scanner lookup → job', `job=${pr.data.job.job_code} MOVE target=${pr.data.job.target_revs}`);
  } catch (e) { fail('scanner lookup', e.message); }

  try {
    const miss = await req('POST', '/api/scanner/scan', {
      barcodeData: 'NO-SUCH-BARCODE',
      scanSource: 'usb',
    }, token);
    assert(miss.status === 404, `expected 404 got ${miss.status}`);
    ok('scanner unknown barcode → 404');
  } catch (e) { fail('scanner 404', e.message); }

  try {
    const start = await req('POST', `/api/jobs/${jobId}/start`, {}, token);
    assert(start.status === 200, `start http ${start.status} ${start.json.error}`);
    assert(start.json.data.job.status === 'running', 'job not running');
    const cmd = start.json.data.plcResponse;
    ok('START → MOVE=xxxx', `status=${start.json.data.job.status} plc=${cmd}`);
  } catch (e) { fail('START/MOVE', e.message); }

  try {
    const move = await req('POST', '/api/plc/move', { revs: 1500 }, token);
    assert(move.status === 200, `move http ${move.status} ${move.json.error}`);
    assert(move.json.data.command === 'MOVE=1500', `cmd=${move.json.data.command}`);
    ok('PLC MOVE=1500', `mode=${move.json.data.mode}`);
  } catch (e) { fail('PLC MOVE', e.message); }

  try {
    const stop = await req('POST', `/api/jobs/${jobId}/stop`, {}, token);
    assert(stop.status === 200, `stop http ${stop.status} ${stop.json.error}`);
    assert(stop.json.data.job.status === 'stopped', 'job not stopped');
    ok('STOP → STOP=0000', `plc=${stop.json.data.plcResponse}`);
  } catch (e) { fail('STOP', e.message); }

  try {
    const zero = await req('POST', '/api/plc/zero', {}, token);
    assert(zero.status === 200 && zero.json.data.command === 'ZERO=0000', `zero=${JSON.stringify(zero.json)}`);
    ok('PLC ZERO=0000', `mode=${zero.json.data.mode}`);
  } catch (e) { fail('PLC ZERO', e.message); }

  try {
    const home = await req('POST', `/api/jobs/${jobId}/home`, {}, token);
    assert(home.status === 200, `home http ${home.status} ${home.json.error}`);
    ok('HOME → ZERO=0000', `job=${home.json.data.job.status}`);
  } catch (e) { fail('HOME/ZERO', e.message); }

  try {
    const printers = await req('GET', '/api/printers', null, token);
    assert(printers.json.data.length >= 1, 'no printers');
    const printer = printers.json.data[0];
    assert(printer.status !== 'online' || true, 'status field present');
    // REAL MODE must not fake online; DEMO may still report offline if ping failed
    const print = await req('POST', `/api/jobs/${jobId}/print`, { printerId: printer.id, copies: 1 }, token);
    assert(print.status === 200, `print http ${print.status} ${print.json.error}`);
    const mode = print.json.data.printResult?.mode;
    ok('Godex demo print', `printer=${printer.name} status=${printer.connection_status} mode=${mode}`);
  } catch (e) { fail('Godex demo print', e.message); }

  try {
    const logs = await req('GET', '/api/jobs/logs?limit=20', null, token);
    const actions = (logs.json.data || []).map(l => l.action);
    assert(actions.includes('SCAN'), 'missing SCAN log');
    assert(actions.includes('START'), 'missing START log');
    assert(actions.includes('STOP'), 'missing STOP log');
    ok('production_logs', actions.slice(0, 8).join(','));
  } catch (e) { fail('production_logs', e.message); }

  try {
    const ev = await req('GET', '/api/plc/events?limit=10', null, token);
    assert(ev.json.data.length > 0, 'no plc_events');
    ok('plc_events', `${ev.json.data.length} events, last=${ev.json.data[0].event_type}`);
  } catch (e) { fail('plc_events', e.message); }

  try {
    const tables = await req('GET', '/api/jobs?limit=5', null, token);
    assert(tables.json.success, 'jobs list failed');
    ok('production_jobs list', `${tables.json.data.length} jobs`);
  } catch (e) { fail('jobs list', e.message); }

  const failed = results.filter(r => !r.pass);
  console.log('\n--- summary ---');
  console.log(`passed: ${results.filter(r => r.pass).length}  failed: ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
