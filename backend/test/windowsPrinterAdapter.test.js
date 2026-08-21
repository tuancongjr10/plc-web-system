const assert = require('node:assert/strict');
const test = require('node:test');
const { WindowsPrinterAdapter, resolvePaperSize } = require('../src/services/printer/windowsPrinterAdapter');

test('uses an equivalent paper size name reported by the driver', () => {
  assert.equal(resolvePaperSize(['Letter', 'Custom 4 x 2'], { unit: 'inch', width: 4, height: 2 }), 'Custom 4 x 2');
  assert.equal(resolvePaperSize(['101.6 x 50.8 mm'], { unit: 'inch', width: 4, height: 2 }), '101.6 x 50.8 mm');
});

test('omits unverified paperSize and returns a warning', async () => {
  let submitted;
  const adapter = new WindowsPrinterAdapter({
    getPrinters: async () => [{ name: 'Microsoft Print to PDF', paperSizes: ['Letter'] }],
    print: async (pdfPath, options) => { submitted = { pdfPath, options }; },
  });
  assert.equal(resolvePaperSize(['Letter'], { unit: 'inch', width: 4, height: 2 }), null);
  const result = await adapter.printFile('label.pdf', 'Microsoft Print to PDF', { label: { unit: 'inch', width: 4, height: 2 } });
  assert.deepEqual(await result.completion, { success: true });
  assert.deepEqual(submitted.options, { printer: 'Microsoft Print to PDF', copies: 1, scale: 'noscale', silent: true });
  assert.equal(Object.hasOwn(submitted.options, 'paperSize'), false);
  assert.match(result.warning, /^paper_size_unverified:.*4x2inch/);
  assert.equal(result.paperSize, null);
  const failing = new WindowsPrinterAdapter({
    getPrinters: async () => [{ name: 'Any Queue', paperSizes: [] }],
    print: async () => { throw new Error('driver_failed'); },
  });
  const failedSubmission = await failing.printFile('label.pdf', 'Any Queue', { label: { unit: 'mm', width: 80, height: 30 } });
  const failedOutcome = await failedSubmission.completion;
  assert.equal(failedOutcome.success, false);
  assert.equal(failedOutcome.error.message, 'driver_failed');
  assert.match(failedOutcome.error.paperSizeWarning, /^paper_size_unverified:.*80x30mm/);
});

test('printFile sends dynamic paperSize and noscale without orientation', async () => {
  let submitted;
  const adapter = new WindowsPrinterAdapter({
    getPrinters: async () => [{ name: 'Label Queue', deviceId: 'Label Queue', paperSizes: ['Stock 4x2in'] }],
    print: async (pdfPath, options) => { submitted = { pdfPath, options }; },
  });
  const result = await adapter.printFile('label.pdf', 'Label Queue', {
    copies: 2,
    label: { unit: 'inch', width: 4, height: 2 },
  });
  assert.deepEqual(await result.completion, { success: true });
  assert.deepEqual(submitted, {
    pdfPath: 'label.pdf',
    options: { printer: 'Label Queue', copies: 2, paperSize: 'Stock 4x2in', scale: 'noscale', silent: true },
  });
  assert.equal(Object.hasOwn(submitted.options, 'orientation'), false);
  assert.equal(result.paperSize, 'Stock 4x2in');
});
