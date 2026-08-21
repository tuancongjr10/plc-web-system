const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontendRoot = path.resolve(__dirname, '../../frontend/src');

test('interactive print requests explicitly disable the general Axios timeout', () => {
  const api = fs.readFileSync(path.join(frontendRoot, 'composables/useApi.js'), 'utf8');
  const printerView = fs.readFileSync(path.join(frontendRoot, 'views/PrinterView.vue'), 'utf8');
  const scannerView = fs.readFileSync(path.join(frontendRoot, 'views/ScannerView.vue'), 'utf8');

  assert.match(api, /interactivePrintRequestConfig\s*=\s*Object\.freeze\(\{\s*timeout:\s*0\s*\}\)/);
  assert.match(printerView, /\/printers\/\$\{selectedPrinterId\.value\}\/test[\s\S]*interactivePrintRequestConfig/);
  assert.match(scannerView, /\/jobs\/\$\{activeJob\.value\.id\}\/print[\s\S]*interactivePrintRequestConfig/);
});

test('Print Queue omits the manual label printing panel and template action', () => {
  const printerView = fs.readFileSync(path.join(frontendRoot, 'views/PrinterView.vue'), 'utf8');
  assert.doesNotMatch(printerView, /Label Printing|Select Label Template|Print Label/);
  assert.doesNotMatch(printerView, /selectedTemplateName|templateVariables|printVariables|submitPrint/);
  assert.doesNotMatch(printerView, /api\.get\('\/printers\/templates'\)/);
  assert.doesNotMatch(printerView, /\/printers\/\$\{selectedPrinterId\.value\}\/print/);
  assert.match(printerView, /<h3 class="card-title">Printers<\/h3>[\s\S]*PDF[^<]*Trace QR[\s\S]*<h3 class="card-title">Print jobs<\/h3>/);
});

test('PDF Trace QR uses multipart upload and browser download without a print dialog timeout', () => {
  const printerView = fs.readFileSync(path.join(frontendRoot, 'views/PrinterView.vue'), 'utf8');
  assert.match(printerView, /PDF → Trace QR/);
  assert.match(printerView, /accept="\.pdf,application\/pdf"/);
  assert.match(printerView, /form\.append\('pdf',selectedTracePdf\.value\)/);
  assert.match(printerView, /api\.post\('\/document-traces\/generate',form,\{timeout:0,responseType:'blob'/);
  assert.match(printerView, /URL\.createObjectURL\(response\.data\)/);
  assert.match(printerView, /link\.download=/);
  assert.doesNotMatch(printerView, /Save Print Output As/);
});
