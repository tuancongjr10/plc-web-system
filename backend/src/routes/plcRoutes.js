const express = require('express');
const router = express.Router();
const plcController = require('../controllers/plcController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

// All PLC routes require authentication
router.use(authenticate);

router.get('/dashboard', plcController.getDashboard);
router.get('/devices', plcController.getDevices);
router.post('/devices', authorize('admin'), plcController.createDevice);
router.get('/devices/:id/tags', plcController.getDeviceTags);
router.post('/tags/write', authorize('admin', 'operator'), plcController.writeTag);
router.post('/command', authorize('admin', 'operator'), plcController.sendCommand);
router.post('/move', authorize('admin', 'operator'), plcController.sendMove);
router.post('/stop', authorize('admin', 'operator'), plcController.sendStop);
router.post('/zero', authorize('admin', 'operator'), plcController.sendZero);
router.get('/events', plcController.getPlcEvents);
router.get('/logs', plcController.getLogs);
router.get('/alarms', plcController.getAlarms);
router.post('/alarms/:id/acknowledge', authorize('admin', 'operator'), plcController.acknowledgeAlarm);

module.exports = router;
