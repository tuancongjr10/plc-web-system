const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

router.use(authenticate);

router.get('/', productController.getProducts);
router.get('/barcode/:barcode', productController.getProductByBarcode);
router.post('/', authorize('admin', 'operator'), productController.createProduct);
router.put('/:id', authorize('admin', 'operator'), productController.updateProduct);
router.delete('/:id', authorize('admin'), productController.deleteProduct);

module.exports = router;
