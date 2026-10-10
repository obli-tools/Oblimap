import { Router } from 'express';
import { settingsController } from '../controllers/settings.controller';
import { requireAuth } from '../middleware/auth';
import { requireTenantCapability } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { setSettingSchema, setSettingsBulkSchema } from '../validators/settings.schema';

const router = Router();

router.use(requireAuth);

// Mounted on the tenant router. Tenant settings (global / group / site /
// probe scopes of the current tenant, checked by settingsService) are read
// and written with the 'settings' tenant capability: platform
// admins, tenant admins and roles granting it.
const canManageSettings = requireTenantCapability('settings');

// Read resolved settings
router.get('/global/resolved', canManageSettings, settingsController.getGlobalResolved);
router.get('/group/:scopeId/resolved', canManageSettings, settingsController.getGroupResolved);
router.get('/site/:scopeId/resolved', canManageSettings, settingsController.getSiteResolved);
// Probe-level resolved settings: GET /api/probe/devices/:id/effective-config (probe.controller)

// Write settings
router.put('/:scope/:scopeId', canManageSettings, validate(setSettingSchema), settingsController.set);
router.put('/:scope/:scopeId/bulk', canManageSettings, validate(setSettingsBulkSchema), settingsController.setBulk);
router.delete('/:scope/:scopeId/:key', canManageSettings, settingsController.remove);

export default router;
