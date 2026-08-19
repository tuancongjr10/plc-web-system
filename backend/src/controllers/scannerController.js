const scannerService = require('../services/scanner/scannerService');
const logger = require('../config/logger');

/**
 * POST /api/scanner/scan
 * Process a barcode/QR scan result from camera or USB
 */
async function processScan(req, res) {
  try {
    const { barcodeData, barcodeType, rawImage, scanSource } = req.body;

    if (!barcodeData) {
      return res.status(400).json({ success: false, error: 'barcodeData is required' });
    }

    const result = await scannerService.processScanResult({
      barcodeData,
      barcodeType: barcodeType || 'unknown',
      rawImage: rawImage || null,
      scanSource: scanSource || 'usb',
      userId: req.user?.id || null,
    });

    if (result.processResult?.status === 'failed') {
      return res.status(404).json({
        success: false,
        error: result.processResult.error || result.processResult.data?.message || 'Product not found',
        data: result,
      });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Scan error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/scanner/records
 */
function getScanHistory(req, res) {
  const { userId, barcodeType, limit = 50, offset = 0, dateFrom, dateTo } = req.query;

  const records = scannerService.getScanHistory({
    userId,
    barcodeType,
    limit: parseInt(limit),
    offset: parseInt(offset),
    dateFrom,
    dateTo,
  });

  res.json({ success: true, data: records });
}

/**
 * GET /api/scanner/stats
 */
function getScanStats(req, res) {
  const { hours = 24 } = req.query;
  const stats = scannerService.getScanStats(parseInt(hours));
  res.json({ success: true, data: stats });
}

/**
 * POST /api/scanner/ethernet
 * Future Ethernet scanner ingest (same workflow as USB/manual scan)
 */
async function ingestEthernetScan(req, res) {
  try {
    const { barcodeData, barcodeType, rawImage } = req.body;
    if (!barcodeData) {
      return res.status(400).json({ success: false, error: 'barcodeData is required' });
    }
    const result = await scannerService.ingestEthernetScan({
      barcodeData,
      barcodeType: barcodeType || 'unknown',
      rawImage: rawImage || null,
    }, req.user?.id || null);

    if (result.processResult?.status === 'failed') {
      return res.status(404).json({
        success: false,
        error: result.processResult.error || 'Product not found',
        data: result,
      });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Ethernet scan error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { processScan, getScanHistory, getScanStats, ingestEthernetScan };
