import type { Request, Response, NextFunction } from 'express';
import type { FlowPeriod } from '@oblimap/shared';
import { AppError } from '../middleware/errorHandler';
import { requireDbId } from '../utils/dbId';
import { permissionService } from '../services/permission.service';
import { auditService } from '../services/audit.service';
import { flowService } from '../services/flow.service';
import { emitSiteUpdated } from '../services/realtime.service';
import { itemService, parseItemListQuery, type ItemListEntry } from '../services/item.service';
import { FLOW_PERIODS } from '../validators/site.schema';
import type { ItemBulkInput } from '../routes/items.routes';

// Tenant-wide device routes (/api/items, tenant router: requireAuth +
// requireTenant). No route-level gate: every handler limits itself to the
// sites the user may read (permissionService.getVisibleSiteIds, 'all' for
// platform / tenant admins). A list filtered on a site or group the user
// cannot read is empty; an item of such a site answers 404, as an item of
// another tenant. Bulk actions need write permission on their site.

function visibleSites(req: Request): Promise<number[] | 'all'> {
  return permissionService.getVisibleSiteIds(req.session.userId!, req.tenantId, req.session.role === 'admin');
}

function canSee(visible: number[] | 'all', siteId: number): boolean {
  return visible === 'all' || visible.includes(siteId);
}

/** The item of req.params.id when the user may read its site, else 404. */
async function readableItem(req: Request): Promise<{ item: ItemListEntry; visible: number[] | 'all' }> {
  const itemId = requireDbId(req.params.id, 'item ID');
  const [item, visible] = await Promise.all([itemService.getRow(req.tenantId, itemId), visibleSites(req)]);
  if (!item || !canSee(visible, item.siteId)) throw new AppError(404, 'Item not found');
  return { item, visible };
}

export const itemsController = {
  /**
   * GET /api/items: q, status, type, vendor, siteId, groupId, new, conflict,
   * checks=failing, undocumented, stale, sort, dir, page, pageSize.
   * → { items, total, page, pageSize, facets: { status, type } }.
   */
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = parseItemListQuery(req.query as Record<string, unknown>);
      if (!parsed.ok) throw new AppError(400, parsed.error);
      const visible = await visibleSites(req);
      res.json(await itemService.list(req.tenantId, visible, parsed.value));
    } catch (err) { next(err); }
  },

  /** GET /api/items/:id → { item, site, probe, reservation, otherSites }. */
  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { item, visible } = await readableItem(req);
      res.json(await itemService.getDetail(req.tenantId, item, visible));
    } catch (err) { next(err); }
  },

  /** GET /api/items/:id/ip-history → { history } (newest first; [] without a MAC). */
  async ipHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { item } = await readableItem(req);
      res.json({ history: await itemService.ipHistory(req.tenantId, item) });
    } catch (err) { next(err); }
  },

  /** GET /api/items/:id/flows?period=24h → { flows } involving the item's IP on its site. */
  async flows(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const period = typeof req.query.period === 'string' && req.query.period ? req.query.period : '24h';
      if (!(FLOW_PERIODS as readonly string[]).includes(period)) {
        throw new AppError(400, 'Invalid period. Use: 1h, 24h, 30d, 1y');
      }
      const { item } = await readableItem(req);
      const flows = await flowService.getFlowsForIp(req.tenantId, item.siteId, item.ip, period as FlowPeriod);
      res.json({ flows });
    } catch (err) { next(err); }
  },

  /**
   * POST /api/items/bulk {siteId, ids, action, params} (validated by
   * itemBulkSchema). Site write required, as for the single-item routes
   * (which need no tenant capability beyond it). → { affected, ignored }
   * (+ skipped for reserve, flowsDeleted for delete).
   */
  async bulk(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as ItemBulkInput;
      const perm = await permissionService.getSitePermission(
        req.session.userId!, body.siteId, req.tenantId, req.session.role === 'admin',
      );
      // Not in the tenant, or not readable: the site does not exist for the caller.
      if (perm === null) throw new AppError(404, 'Site not found');
      if (perm !== 'rw') throw new AppError(403, 'No write permission on this site');

      const params = body.action === 'setType'
        ? { deviceType: body.params.deviceType }
        : body.action === 'reserve'
          ? { description: body.params?.description ?? null }
          : {};
      const result = await itemService.bulk(
        req.tenantId, body.siteId, body.ids, body.action, params, req.session.userId!,
      );

      await auditService.logReq(req, {
        action: `site_item.bulk_${body.action}`,
        resourceType: 'site',
        resourceId: body.siteId,
        details: {
          requested: body.ids.length,
          ...result,
          ...(body.action === 'setType' ? { deviceType: body.params.deviceType } : {}),
        },
      });
      if (result.affected > 0) emitSiteUpdated(req.tenantId, body.siteId);
      res.json(result);
    } catch (err) { next(err); }
  },
};
