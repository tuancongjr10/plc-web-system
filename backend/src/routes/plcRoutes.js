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
router.post('/devices/:id/home', authorize('admin', 'operator'), plcController.sendHome);
router.get('/events', plcController.getPlcEvents);
router.get('/logs', plcController.getLogs);
router.get('/alarms', plcController.getAlarms);
router.post('/alarms/:id/acknowledge', authorize('admin', 'operator'), plcController.acknowledgeAlarm);

module.exports = router;
