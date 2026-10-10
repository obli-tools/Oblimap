import { Router } from 'express';
import { requireTenantCapability, requireSiteRead } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { requireAction } from '../middleware/stepUp';
import { deviceCheckMutationLimiter, deviceCheckTestLimiter } from '../middleware/rateLimiter';
import { deviceChecksController as c } from '../controllers/deviceChecks.controller';
import {
  createRuleSchema,
  updateRuleSchema,
  credentialsSchema,
  previewSchema,
  testSchema,
} from '../validators/deviceCheck.schema';

// Device Checks. Mounted on the tenant router at /device-checks
// (requireAuth + requireTenant already applied): every query is filtered on
// req.tenantId.
//
// Authoring, credentials, test and run-now make probes contact devices on
// the tenant's LANs: behind this one guard, the 'deviceChecks.manage' tenant
// capability — platform admins, tenant admins and roles
// granting it. Full access (platform / tenant admins) authors anywhere in the
// tenant, tenant-wide rules included. Other holders are bounded by their team
// scope (rule.service assertAuthoringScope): preview needs a group
// or site they can read and only shows the sites they may read, test and
// run-now need the device's site readable, and every rule mutation needs a
// group or site scope they can write (never tenant-wide). Probes, settings
// and notification bindings stay tenant-level objects: their capabilities
// are not bounded by team scopes.
// The accountable-user gate of config.service must accept the same people.
// Reads of states, events and summaries are open to the tenant's members
// with the same site permissions as the rest of the IPAM: requireSiteRead on
// a site route, the state's site checked by the controller, the summary
// limited to the visible sites. Mutations are rate-limited per user and
// audited. The platform policy (/admin/config/device-checks-policy) stays
// platform-admin only.
const canManageDeviceChecks = requireTenantCapability('deviceChecks.manage');

const router = Router();

// ── Tenant members (site read permission) ───────────────────────────────────
router.get('/presets', c.presets);
router.get('/summary', c.summary);
router.get('/sites/:siteId/states', requireSiteRead('siteId'), c.siteStates);
router.get('/states/:stateId/events', c.stateEvents);

// ── Admin: rules ────────────────────────────────────────────────────────────
router.get('/rules', canManageDeviceChecks, c.listRules);
router.get('/rules/:id', canManageDeviceChecks, c.getRule);
// Live form validation (debounced by the editor): not a mutation, no mutation limiter.
router.post('/validate', canManageDeviceChecks, c.validateSpec);
router.post('/rules', canManageDeviceChecks, deviceCheckMutationLimiter, validate(createRuleSchema), c.createRule);
router.patch('/rules/:id', canManageDeviceChecks, deviceCheckMutationLimiter, validate(updateRuleSchema), c.updateRule);
router.post('/rules/:id/enable', canManageDeviceChecks, deviceCheckMutationLimiter, requireAction('device_check.rule_enable'), c.enableRule);
router.post('/rules/:id/disable', canManageDeviceChecks, deviceCheckMutationLimiter, c.disableRule);
router.delete('/rules/:id', canManageDeviceChecks, deviceCheckMutationLimiter, c.deleteRule);

// ── Admin: credentials (write-only) ─────────────────────────────────────────
router.put('/rules/:id/credentials', canManageDeviceChecks, deviceCheckMutationLimiter, validate(credentialsSchema), requireAction('device_check.credentials_set'), c.setCredentials);
router.delete('/rules/:id/credentials', canManageDeviceChecks, deviceCheckMutationLimiter, c.clearCredentials);

// ── Admin: preview, test, run now ───────────────────────────────────────────
router.post('/preview-matches', canManageDeviceChecks, validate(previewSchema), c.previewMatches);
router.post('/test', canManageDeviceChecks, deviceCheckTestLimiter, validate(testSchema), c.test);
router.post('/states/:stateId/run-now', canManageDeviceChecks, deviceCheckMutationLimiter, c.runNow);

export default router;
