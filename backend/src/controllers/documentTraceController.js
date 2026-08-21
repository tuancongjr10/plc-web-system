const documentTraceService = require('../services/traceability/documentTraceService');
const logger = require('../config/logger');
const { createAuditLog } = require('../middleware/auditMiddleware');

async function generate(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'pdf_file_required' });
    const result = await documentTraceService.generateTraceQr({
      buffer: req.file.buffer,
      originalFileName: req.file.originalname,
      mimeType: req.file.mimetype,
      productId: req.body.productId || null,
      productionJobId: req.body.productionJobId || null,
      description: req.body.description || null,
      userId: req.user?.id || null,
    });
    createAuditLog({
      userId: req.user?.id,
      username: req.user?.username,
      action: 'GENERATE_DOCUMENT_TRACE_QR',
      resource: 'document_traces',
      resourceId: result.traceCode,
      details: { originalFileName: result.originalFileName, sha256: result.sha256 },
      req,
    });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${result.downloadFileName}"`,
      'Content-Length': String(result.pdfBuffer.length),
      'X-Trace-Code': result.traceCode,
      'X-Document-SHA256': result.sha256,
    });
    return res.send(result.pdfBuffer);
  } catch (error) {
    logger.error(`Document Trace QR generation failed: ${error.message}`);
    return res.status(error.status || 500).json({ success: false, error: error.message });
  }
}

function lookup(req, res) {
  try {
    return res.json({ success: true, data: documentTraceService.lookup(req.params.traceCode) });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: error.message });
  }
}

module.exports = { generate, lookup };
