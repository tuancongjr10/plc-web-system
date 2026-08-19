const express = require('express');
const router = express.Router();
const scannerController = require('../controllers/scannerController');
const { authenticate } = require('../middleware/authMiddleware');

router.use(authenticate);

router.post('/scan', scannerController.processScan);
router.post('/ethernet', scannerController.ingestEthernetScan);
router.get('/records', scannerController.getScanHistory);
router.get('/stats', scannerController.getScanStats);

module.exports = router;
