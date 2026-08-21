const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');

const DEFAULT_TEMP_DIR = path.join(os.tmpdir(), 'plc-web-system', 'labels');
const LABEL_FILE_PATTERN = /^(?:label-|PLCWEB-)[a-f0-9]{32}\.pdf$/i;
const LEGACY_UNIT = 'inch';
const POINTS_PER_UNIT = { pt: 1, inch: 72, mm: 72 / 25.4 };

function parseDefinition(template) {
  let definition;
  try { definition = typeof template.definition === 'string' ? JSON.parse(template.definition) : template.definition; }
  catch { throw new Error('invalid_label_template'); }
  if (!definition || typeof definition !== 'object') throw new Error('invalid_label_template');
  const unit = definition.unit || LEGACY_UNIT;
  if (!POINTS_PER_UNIT[unit]) throw new Error(`invalid_label_unit:${unit}`);
  if (!(Number(definition.width) > 0) || !(Number(definition.height) > 0)) throw new Error('invalid_label_dimensions');
  return { ...definition, unit };
}

function resolveValue(field, variables) {
  const raw = Object.prototype.hasOwnProperty.call(variables, field.key) ? variables[field.key] : (field.value ?? '');
  return String(raw).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => String(variables[key] ?? ''));
}

function barcodeBuffer(options) {
  return new Promise((resolve, reject) => bwipjs.toBuffer(options, (error, buffer) => error ? reject(error) : resolve(buffer)));
}

class LabelRenderer {
  constructor(tempDir = DEFAULT_TEMP_DIR) {
    this.tempDir = path.resolve(tempDir);
  }

  getTempDir() { return this.tempDir; }

  isManagedPath(filePath) {
    if (!filePath) return false;
    const resolved = path.resolve(filePath);
    return path.dirname(resolved) === this.tempDir && LABEL_FILE_PATTERN.test(path.basename(resolved));
  }

  normalizeTemplate(template, variables = {}) {
    const definition = parseDefinition(template);
    return {
      name: template.name,
      unit: definition.unit,
      width: Number(definition.width),
      height: Number(definition.height),
      fields: (definition.fields || []).map((field) => ({ ...field, value: resolveValue(field, variables) })),
    };
  }

  async renderLabelPdf(template, variables = {}, options = {}) {
    const label = this.normalizeTemplate(template, variables);
    const factor = POINTS_PER_UNIT[label.unit];
    const pageWidth = label.width * factor;
    const pageHeight = label.height * factor;
    fs.mkdirSync(this.tempDir, { recursive: true });
    const correlationId = /^[a-f0-9]{32}$/i.test(options.correlationId || '') ? options.correlationId.toLowerCase() : null;
    const filename = correlationId ? `PLCWEB-${correlationId}.pdf` : `label-${crypto.randomBytes(16).toString('hex')}.pdf`;
    const pdfPath = path.join(this.tempDir, filename);
    const doc = new PDFDocument({ size: [pageWidth, pageHeight], margin: 0, autoFirstPage: true });
    const output = fs.createWriteStream(pdfPath, { flags: 'wx' });
    const completed = new Promise((resolve, reject) => {
      output.once('finish', resolve);
      output.once('error', reject);
      doc.once('error', reject);
    });
    // A field/barcode may fail before this promise is awaited; attach a handler
    // immediately while preserving the rejection for the later await.
    completed.catch(() => {});
    doc.pipe(output);

    try {
      let fallbackY = 6;
      for (const field of label.fields) {
        const x = Number.isFinite(Number(field.x)) ? Number(field.x) * factor : 6;
        const y = Number.isFinite(Number(field.y)) ? Number(field.y) * factor : fallbackY;
        const width = Number.isFinite(Number(field.width)) ? Number(field.width) * factor : Math.max(1, pageWidth - x - 6);
        const height = Number.isFinite(Number(field.height)) ? Number(field.height) * factor : undefined;
        if (field.type === 'barcode' || field.type === 'qr' || field.type === 'qrcode') {
          const image = await barcodeBuffer({
            bcid: field.type === 'barcode' ? (field.format || 'code128') : 'qrcode',
            text: field.value,
            scale: Number(field.scale) || 3,
            includetext: field.type === 'barcode' && field.includeText !== false,
          });
          doc.image(image, x, y, { fit: [width, height || Math.min(54, pageHeight - y - 4)], align: field.alignment || 'left' });
          fallbackY = y + (height || 54) + 4;
        } else {
          doc.fontSize(Number(field.fontSize) || 10).fillColor(field.color || '#000000');
          doc.text(field.value, x, y, { width, height, align: field.alignment || 'left', lineBreak: field.lineBreak !== false });
          fallbackY = y + (height || (Number(field.fontSize) || 10) * 1.4);
        }
      }
      doc.end();
      await completed;
      return { pdfPath, label };
    } catch (error) {
      doc.destroy();
      output.destroy();
      await fs.promises.rm(pdfPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async cleanup(pdfPath) {
    if (!this.isManagedPath(pdfPath)) return false;
    await fs.promises.rm(path.resolve(pdfPath), { force: true });
    return true;
  }

  async cleanupExpired(ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('invalid_label_retention');
    if (!fs.existsSync(this.tempDir)) return [];
    const now = Date.now();
    const deleted = [];
    for (const name of await fs.promises.readdir(this.tempDir)) {
      if (!LABEL_FILE_PATTERN.test(name)) continue;
      const filePath = path.join(this.tempDir, name);
      if (!this.isManagedPath(filePath)) continue;
      const stat = await fs.promises.lstat(filePath).catch(() => null);
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || now - stat.mtimeMs <= ttlMs) continue;
      await fs.promises.rm(filePath, { force: true });
      deleted.push(path.resolve(filePath));
    }
    return deleted;
  }
}

module.exports = new LabelRenderer();
module.exports.LabelRenderer = LabelRenderer;
module.exports.LABEL_FILE_PATTERN = LABEL_FILE_PATTERN;
