import { Router } from 'express';
import { appConfigController } from '../controllers/appConfig.controller';
import { deviceChecksController } from '../controllers/deviceChecks.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { deviceChecksPolicySchema } from '../validators/deviceCheck.schema';

const router = Router();

// GET is available to all authenticated users (needed for profile page to check allow_2fa)
router.get('/', requireAuth, appConfigController.getAll);

// Specific named routes MUST come before /:key (otherwise /:key captures them first)

// Obligate SSO gateway config — admin only
router.get('/obligate', requireAuth, requireRole('admin'), appConfigController.getObligateConfig);
router.put('/obligate', requireAuth, requireRole('admin'), appConfigController.setObligateConfig);

// Device Checks platform policy (ports, caps, intervals, retention) — admin only, audited
router.get('/device-checks-policy', requireAuth, requireRole('admin'), deviceChecksController.getPolicy);
router.put('/device-checks-policy', requireAuth, requireRole('admin'), validate(deviceChecksPolicySchema), deviceChecksController.setPolicy);

// Generic key setter — must be LAST among PUT routes
router.put('/:key', requireAuth, requireRole('admin'), appConfigController.set);

export default router;
