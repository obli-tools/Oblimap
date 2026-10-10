import type { Request, Response, NextFunction } from 'express';
import {
  liveAlertService,
  alertRequiredCapability,
  holdsAlertCapability,
  viewerAlertCapabilities,
  type AlertCapabilities,
  type AlertSiteVisibility,
} from '../services/liveAlert.service';
import { auditService } from '../services/audit.service';
import { permissionService } from '../services/permission.service';
import { toDbId, validDbIds } from '../utils/dbId';
import { userHasTenantAccess } from '../utils/sessionTenant';
import { db } from '../db';

// Alerts about a site (site_id) are listed only for the users who may read
// that site (permissionService.getVisibleSiteIds: platform and tenant admins,
// members with a team permission on it) — like the socket delivery in
// liveAlert.service. Alerts about an admin page (navigate_to '/manage/…', or legacy '/admin/…') are
// listed only for the users holding that page's tenant capability
// (liveAlert.service alertRequiredCapability). Other alerts without a site
// are listed for every member. Resolved alerts are left out unless
// ?includeResolved=1 (or true).
//
// Platform admins may work in every tenant without a user_tenants row
// (utils/sessionTenant.ts): the cross-tenant list covers, like the socket
// delivery (socket.ts notificationTenantIds), the tenants the user is a member
// of plus the session's current tenant, and acting on one alert by id only
// needs access to its tenant.

function includeResolved(req: Request): boolean {
  const v = req.query.includeResolved;
  return v === '1' || v === 'true';
}

function isPlatformAdmin(req: Request): boolean {
  return req.session.role === 'admin';
}

/** Sites of `tenantId` the requesting user may read. */
async function siteVisibility(req: Request, tenantId: number): Promise<AlertSiteVisibility> {
  const userId = toDbId(req.session.userId);
  if (userId === null) return [];
  return permissionService.getVisibleSiteIds(userId, tenantId, isPlatformAdmin(req));
}

/** Tenant capabilities of the requesting user in `tenantId` (admin-page alerts). */
async function capabilityVisibility(req: Request, tenantId: number): Promise<AlertCapabilities> {
  const userId = toDbId(req.session.userId);
  if (userId === null) return [];
  return viewerAlertCapabilities(userId, tenantId, isPlatformAdmin(req));
}

/** GET /api/live-alerts — current tenant */
export async function getAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const [sites, capabilities] = await Promise.all([
      siteVisibility(req, req.tenantId),
      capabilityVisibility(req, req.tenantId),
    ]);
    const alerts = await liveAlertService.getForTenant(req.tenantId, 100, {
      includeResolved: includeResolved(req),
      sites,
      capabilities,
    });
    res.json(alerts);
  } catch (err) { next(err); }
}

/**
 * Tenants whose alerts the user lists: their memberships, plus the session's
 * current tenant when they may still work in it (platform admins: any tenant).
 */
async function alertTenants(req: Request): Promise<{ id: number; name: string }[]> {
  const userId = toDbId(req.session.userId);
  if (userId === null) return [];
  const memberOf = await db('user_tenants').where('user_id', userId).pluck('tenant_id') as unknown[];
  const ids = new Set(validDbIds(memberOf));
  const current = toDbId(req.session.currentTenantId);
  if (current !== null && !ids.has(current) && await userHasTenantAccess(userId, current, isPlatformAdmin(req))) {
    ids.add(current);
  }
  if (ids.size === 0) return [];
  const tenants = await db('tenants')
    .whereIn('id', [...ids])
    .select('id', 'name') as { id: number; name: string }[];
  return tenants;
}

/**
 * GET /api/live-alerts/all — all tenants accessible by this user.
 * Returns { alerts, tenants } where alerts are enriched with tenantName.
 */
export async function getAllTenantAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenants = await alertTenants(req);

    const tenantIds = tenants.map((t) => t.id);
    const [visibility, capabilities] = await Promise.all([
      Promise.all(tenantIds.map((tid) => siteVisibility(req, tid))),
      Promise.all(tenantIds.map((tid) => capabilityVisibility(req, tid))),
    ]);
    const sitesByTenant = new Map<number, AlertSiteVisibility>(tenantIds.map((tid, i) => [tid, visibility[i]]));
    const capabilitiesByTenant = new Map<number, AlertCapabilities>(tenantIds.map((tid, i) => [tid, capabilities[i]]));
    const alerts = await liveAlertService.getForTenants(tenantIds, 200, {
      includeResolved: includeResolved(req),
      sitesByTenant,
      capabilitiesByTenant,
    });
    res.json({ alerts, tenants });
  } catch (err) { next(err); }
}

/**
 * The alert `id` if it belongs to a tenant the user may access (a membership;
 * platform admins: any tenant) and the user may see it: its site when it is
 * about one, the capability of its admin page when it links to one.
 */
async function findAccessibleAlert(req: Request, id: number): Promise<{ id: number; tenant_id: number } | undefined> {
  const userId = toDbId(req.session.userId);
  if (userId === null) return undefined;

  const q = db('live_alerts').where({ id });
  if (!isPlatformAdmin(req)) {
    const userTenantIds = await db('user_tenants')
      .where('user_id', userId)
      .pluck('tenant_id') as number[];
    q.whereIn('tenant_id', userTenantIds);
  }
  const alert = await q.first('id', 'tenant_id', 'site_id', 'navigate_to') as
    { id: number; tenant_id: number; site_id: number | null; navigate_to: string | null } | undefined;
  if (!alert) return undefined;
  const required = alertRequiredCapability(alert.navigate_to);
  if (required !== null && !holdsAlertCapability(await capabilityVisibility(req, alert.tenant_id), required)) {
    return undefined;
  }
  if (alert.site_id != null) {
    const sites = await siteVisibility(req, alert.tenant_id);
    if (sites !== 'all' && !sites.includes(Number(alert.site_id))) return undefined;
  }
  return { id: alert.id, tenant_id: alert.tenant_id };
}

/** PATCH /api/live-alerts/:id/read — mark one alert as read (cross-tenant) */
export async function markRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = toDbId(req.params.id);
    if (id === null) { res.status(400).json({ error: 'Invalid alert id' }); return; }
    // Verify the alert belongs to a tenant the user can access
    const alert = await findAccessibleAlert(req, id);
    if (!alert) { res.status(404).json({ error: 'Alert not found' }); return; }

    await liveAlertService.markRead(id, alert.tenant_id);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** POST /api/live-alerts/read-all — mark all as read for current tenant (admin) */
export async function markAllRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await liveAlertService.markAllRead(req.tenantId);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** DELETE /api/live-alerts/:id — delete one alert (cross-tenant, admin) */
export async function deleteAlert(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = toDbId(req.params.id);
    if (id === null) { res.status(400).json({ error: 'Invalid alert id' }); return; }
    const alert = await findAccessibleAlert(req, id);
    if (!alert) { res.status(404).json({ error: 'Alert not found' }); return; }

    await liveAlertService.deleteAlert(id, alert.tenant_id);
    void auditService.logReq(req, {
      tenantId: alert.tenant_id,
      action: 'live_alert.deleted',
      resourceType: 'live_alert',
      resourceId: id,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** DELETE /api/live-alerts — clear all for current tenant (admin) */
export async function clearAll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await liveAlertService.clearAll(req.tenantId);
    void auditService.logReq(req, { action: 'live_alert.cleared', resourceType: 'live_alert' });
    res.json({ ok: true });
  } catch (err) { next(err); }
}
