import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { DEVICE_TYPES } from '@oblimap/shared';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { requireDbId, toDbId } from '../utils/dbId';
import { itemsController } from '../controllers/items.controller';
import { ITEM_BULK_MAX_IDS, itemService } from '../services/item.service';
import { permissionService } from '../services/permission.service';
import {
  ITEM_EVENTS_ITEM_DEFAULT_WINDOW_MS,
  parseItemEventsQuery,
  query as queryItemEvents,
} from '../services/itemEvents.service';

const router = Router();

// Mounted on the tenant router (requireAuth + requireTenant). Every handler
// limits itself to the sites the user may read (items.controller.ts); the
// bulk route checks write permission on its site.

/** A database id given as a number or a digit string (toDbId, strict). */
const dbId = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const id = toDbId(v);
  if (id === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid id' });
    return z.NEVER;
  }
  return id;
});

const bulkBase = {
  siteId: dbId,
  ids: z.array(dbId).min(1).max(ITEM_BULK_MAX_IDS),
};

export const itemBulkSchema = z.discriminatedUnion('action', [
  z.object({
    ...bulkBase,
    action: z.literal('delete'),
    params: z.object({}).strict().optional(),
  }).strict(),
  z.object({
    ...bulkBase,
    action: z.literal('setType'),
    params: z.object({ deviceType: z.enum(DEVICE_TYPES) }).strict(),
  }).strict(),
  z.object({
    ...bulkBase,
    action: z.literal('reserve'),
    params: z.object({
      description: z.string().trim().max(2000).nullable().optional()
        .transform((v) => (v === undefined ? undefined : v || null)),
    }).strict().optional(),
  }).strict(),
]);

export type ItemBulkInput = z.infer<typeof itemBulkSchema>;

// ── Device event history (site_item_events) ─────────────────────────
// Same visibility as the other item routes: only the sites the user may read
// ('all' for full access). A siteId the user cannot read lists nothing; an
// item of such a site (or of another tenant) answers 404.

function visibleSites(req: Request): Promise<number[] | 'all'> {
  return permissionService.getVisibleSiteIds(req.session.userId!, req.tenantId, req.session.role === 'admin');
}

/**
 * GET /api/items/events?siteId&groupId&kinds&from&to&limit → ItemEventsResult
 * (newest first; window cut to 30 days, default the last 24 h; limit ≤ 500).
 */
async function listEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = parseItemEventsQuery(req.query as Record<string, unknown>);
    if (!parsed.ok) throw new AppError(400, parsed.error);
    const visible = await visibleSites(req);
    res.json(await queryItemEvents({ tenantId: req.tenantId, visibleSiteIds: visible, ...parsed.value }));
  } catch (err) { next(err); }
}

/**
 * GET /api/items/:id/events?kinds&from&to&limit → ItemEventsResult of one
 * device (default window: the last 30 days).
 */
async function itemEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const itemId = requireDbId(req.params.id, 'item ID');
    const [item, visible] = await Promise.all([itemService.getRow(req.tenantId, itemId), visibleSites(req)]);
    if (!item || (visible !== 'all' && !visible.includes(item.siteId))) throw new AppError(404, 'Item not found');
    const parsed = parseItemEventsQuery(req.query as Record<string, unknown>, new Date(), ITEM_EVENTS_ITEM_DEFAULT_WINDOW_MS);
    if (!parsed.ok) throw new AppError(400, parsed.error);
    const { kinds, from, to, limit } = parsed.value;
    res.json(await queryItemEvents({
      tenantId: req.tenantId,
      visibleSiteIds: visible,
      siteId: item.siteId,
      itemId,
      kinds,
      from,
      to,
      limit,
    }));
  } catch (err) { next(err); }
}

router.get('/', itemsController.list);
router.post('/bulk', validate(itemBulkSchema), itemsController.bulk);
// Before '/:id' (not an item id).
router.get('/events', listEvents);
router.get('/:id', itemsController.get);
router.get('/:id/ip-history', itemsController.ipHistory);
router.get('/:id/flows', itemsController.flows);
router.get('/:id/events', itemEvents);

export default router;
