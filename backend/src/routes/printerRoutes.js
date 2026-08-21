const express = require('express');
const router = express.Router();
const printerController = require('../controllers/printerController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

router.use(authenticate);

router.get('/', printerController.getPrinters);
router.get('/available-queues', printerController.getAvailableQueues);
router.get('/jobs', printerController.getJobs);
router.get('/templates', printerController.getTemplates);
router.post('/templates', authorize('admin'), printerController.createTemplate);
router.patch('/:id', authorize('admin'), printerController.updatePrinter);
router.post('/:id/print', authorize('admin', 'operator'), printerController.printLabel);
router.post('/:id/test', authorize('admin', 'operator'), printerController.printTest);
router.get('/:id/status', printerController.getPrinterStatus);

module.exports = router;
