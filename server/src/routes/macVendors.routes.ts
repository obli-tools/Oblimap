import { Router } from 'express';
import { macVendorsController } from '../controllers/macVendors.controller';
import { requireRole } from '../middleware/rbac';

const router = Router();

// All MAC vendor endpoints are admin-only
router.use(requireRole('admin'));

router.get('/stats',               macVendorsController.stats);
router.post('/seed',               macVendorsController.seed);
router.get('/',                    macVendorsController.list);
router.patch('/:prefix',           macVendorsController.updateCustomName);
router.delete('/:prefix/override', macVendorsController.clearOverride);

export default router;
