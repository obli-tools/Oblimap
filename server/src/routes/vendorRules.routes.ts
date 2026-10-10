import { Router } from 'express';
import { vendorRulesController, reapplyVendorRulesSchema } from '../controllers/vendorRules.controller';
import { requireAllTenantCapabilities } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { createVendorRuleSchema, updateVendorRuleSchema, bulkCreateVendorRulesSchema } from '../validators/vendorRule.schema';

// Mounted on the tenant router (requireAuth + requireTenant). Any member may
// read the rules. They decide the device type of every newly discovered
// device of the tenant — which Device Checks rules match on (deviceTypes), so
// they steer where probes send check credentials. Changing
// them takes the 'sites.manage' AND 'deviceChecks.manage' tenant capabilities
// Platform admins, tenant admins and roles granting both —
// never a plain member. Re-applying them (re-typing existing devices) is
// gated the same way, plus write access on the target (full access for the
// whole tenant), checked by the controller.
const router = Router();

const canManageVendorRules = requireAllTenantCapabilities(['sites.manage', 'deviceChecks.manage']);

router.get('/',     vendorRulesController.list);
// Vendor names seen on the devices of the sites the caller may read.
router.get('/observed-vendors', vendorRulesController.observedVendors);
router.post('/',    canManageVendorRules, validate(createVendorRuleSchema), vendorRulesController.create);
router.post('/bulk', canManageVendorRules, validate(bulkCreateVendorRulesSchema), vendorRulesController.bulkCreate);
router.post('/reapply', canManageVendorRules, validate(reapplyVendorRulesSchema), vendorRulesController.reapply);
router.patch('/:id', canManageVendorRules, validate(updateVendorRuleSchema), vendorRulesController.update);
router.delete('/:id', canManageVendorRules, vendorRulesController.remove);

export default router;
