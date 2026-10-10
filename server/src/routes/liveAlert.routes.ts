import { Router } from 'express';
import type { Request } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireTenantCapability, requireCapabilityInResourceTenant } from '../middleware/rbac';
import { toDbId } from '../utils/dbId';
import { db } from '../db';
import * as ctrl from '../controllers/liveAlert.controller';

export const liveAlertRouter = Router();

/**
 * Tenant of alert :id among the user's memberships (null: no such alert for
 * this user — the controller answers 400 / 404).
 */
async function alertTenantOf(req: Request, userId: number): Promise<number | null> {
  const id = toDbId(req.params.id);
  if (id === null) return null;
  const row = await db('live_alerts as a')
    .join('user_tenants as ut', 'ut.tenant_id', 'a.tenant_id')
    .where({ 'a.id': id, 'ut.user_id': userId })
    .first('a.tenant_id') as { tenant_id: number } | undefined;
  return row ? Number(row.tenant_id) : null;
}

// All tenants accessible by this user (no requireTenant — cross-tenant)
liveAlertRouter.get('/all', requireAuth, ctrl.getAllTenantAlerts);

// Current-tenant endpoints. Reading is open to members; the read state is
// shared by the whole tenant and alerts are evidence (IP takeover...), so
// marking everything read and deleting take the 'settings' tenant capability
// (platform admins, tenant admins and roles granting it).
liveAlertRouter.get('/', requireAuth, requireTenant, ctrl.getAlerts);
liveAlertRouter.post('/read-all', requireAuth, requireTenant, requireTenantCapability('settings'), ctrl.markAllRead);
liveAlertRouter.delete('/', requireAuth, requireTenant, requireTenantCapability('settings'), ctrl.clearAll);

// Cross-tenant by alert id (ownership verified inside controller); deleting
// needs 'settings' in the alert's own tenant.
liveAlertRouter.patch('/:id/read', requireAuth, ctrl.markRead);
liveAlertRouter.delete('/:id', requireAuth, requireCapabilityInResourceTenant('settings', alertTenantOf), ctrl.deleteAlert);
