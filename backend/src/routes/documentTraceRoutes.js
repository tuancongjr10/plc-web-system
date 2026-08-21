const express = require('express');
const multer = require('multer');
const documentTraceController = require('../controllers/documentTraceController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

function acceptPdf(req, res, next) {
  upload.single('pdf')(req, res, (error) => {
    if (error) return res.status(400).json({ success: false, error: error.code || error.message });
    return next();
  });
}

router.use(authenticate);
router.post('/generate', authorize('admin', 'operator'), acceptPdf, documentTraceController.generate);
router.get('/:traceCode', documentTraceController.lookup);

module.exports = router;
