const express = require('express');
const router = express.Router();
const jobController = require('../controllers/jobController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

router.use(authenticate);

router.get('/', jobController.getJobs);
router.get('/active', jobController.getActiveJob);
router.get('/logs', jobController.getProductionLogs);
router.post('/:id/start', authorize('admin', 'operator'), jobController.startJob);
router.post('/:id/stop', authorize('admin', 'operator'), jobController.stopJob);
router.post('/:id/home', authorize('admin', 'operator'), jobController.homeJob);
router.post('/:id/reset', authorize('admin', 'operator'), jobController.resetJob);
router.post('/:id/print', authorize('admin', 'operator'), jobController.printJob);

module.exports = router;
