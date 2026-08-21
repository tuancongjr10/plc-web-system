const assert = require('node:assert/strict');
const fs = require('fs');
const test = require('node:test');
const renderer = require('../src/services/printer/labelRenderer');

test('renders legacy 4x2 template as a real PDF using inch compatibility', async () => {
  const template = {
    name: 'legacy-label',
    definition: JSON.stringify({
      width: 4,
      height: 2,
      fields: [
        { type: 'text', key: 'productName', x: 0.15, y: 0.12, fontSize: 12 },
        { type: 'text', key: 'jobId', x: 0.15, y: 0.32, fontSize: 9 },
        { type: 'text', key: 'productionDate', x: 2.2, y: 0.32, fontSize: 9 },
        { type: 'barcode', key: 'barcode', barcodeType: 'code128', x: 0.15, y: 0.55, width: 3.7, height: 1.05 },
        { type: 'text', key: 'quantity', x: 0.15, y: 1.72, fontSize: 9 },
      ],
    }),
  };
  const result = await renderer.renderLabelPdf(template, {
    productName: 'Product 002',
    jobId: 'Label-1787282853922',
    productionDate: '2026-08-21',
    barcode: 'PROD-002',
    quantity: '10',
  });
  try {
    assert.equal(result.label.unit, 'inch');
    assert.equal(result.label.width, 4);
    assert.equal(result.label.height, 2);
    const pdf = fs.readFileSync(result.pdfPath);
    assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.ok(pdf.length > 1000, 'rendered PDF must contain more than an empty page shell');
    assert.match(pdf.toString('latin1'), /\/Subtype\s*\/Image/, 'Code128 must be embedded as an image');
    assert.equal(result.label.fields.find((field) => field.key === 'barcode').value, 'PROD-002');
    for (const key of ['productName', 'jobId', 'productionDate', 'quantity']) {
      assert.ok(result.label.fields.find((field) => field.key === key).value, `${key} must be resolved`);
    }
  } finally {
    await renderer.cleanup(result.pdfPath);
  }
  assert.equal(fs.existsSync(result.pdfPath), false);
});

test('supports explicit mm and rejects unknown units', () => {
  const normalized = renderer.normalizeTemplate({ name: 'mm', definition: { unit: 'mm', width: 100, height: 50, fields: [] } });
  assert.equal(normalized.unit, 'mm');
  assert.throws(() => renderer.normalizeTemplate({ name: 'bad', definition: { unit: 'px', width: 100, height: 50 } }), /invalid_label_unit/);
  assert.throws(() => renderer.normalizeTemplate({ name: 'bad', definition: null }), /invalid_label_template/);
});
