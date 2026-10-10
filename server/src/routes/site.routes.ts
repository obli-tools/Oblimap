import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireTenantCapability, requireSiteRead, requireSiteWrite } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { requireAction } from '../middleware/stepUp';
import { AppError } from '../middleware/errorHandler';
import { siteController } from '../controllers/site.controller';
import { permissionService } from '../services/permission.service';
import {
  createSiteSchema,
  updateSiteSchema,
  createSiteItemSchema,
  updateSiteItemSchema,
  createReservationSchema,
  updateReservationSchema,
  type CreateSiteInput,
} from '../validators/site.schema';

const router = Router();

// Mounted on the tenant router (requireAuth + requireTenant).
// requireSiteRead / requireSiteWrite: the site must belong to the current
// tenant (404), then platform admin, tenant admin or a team permission on the
// site or its group chain (403 otherwise). The list is filtered by the same
// permissions in the controller.
// Creating and deleting sites also needs the 'sites.manage' tenant capability.

/**
 * POST /sites: where the new site goes. Platform and tenant admins may create
 * it anywhere in the tenant. Other holders of sites.manage need write
 * permission on its group — a site outside any group would be visible to
 * admins only. The group must be in the tenant (400, as siteService answers).
 * Runs after validate(createSiteSchema).
 */
async function requireSiteCreateTarget(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.session.userId!;
    const isPlatformAdmin = req.session.role === 'admin';
    if (await permissionService.isFullAccess(userId, req.tenantId, isPlatformAdmin)) return next();
    const { groupId } = req.body as CreateSiteInput;
    if (groupId == null) return next(new AppError(403, 'Choose a group you can write to for the new site'));
    if (!(await permissionService.findGroup(groupId, req.tenantId))) return next(new AppError(400, 'Group not found'));
    if (!(await permissionService.canWriteGroup(userId, groupId, req.tenantId, isPlatformAdmin))) {
      return next(new AppError(403, 'No write permission on the target group'));
    }
    next();
  } catch (err) {
    next(err);
  }
}

// ── Sites ─────────────────────────────────────────────────────────────────────
router.get('/', siteController.list);
router.post('/', requireTenantCapability('sites.manage'), validate(createSiteSchema), requireSiteCreateTarget, siteController.create);
router.get('/:id', requireSiteRead(), siteController.get);
router.patch('/:id', requireSiteWrite(), validate(updateSiteSchema), siteController.update);
router.delete('/:id', requireTenantCapability('sites.manage'), requireSiteWrite(), requireAction('site.delete'), siteController.remove);

// ── Probes of the site ────────────────────────────────────────────────────────
// Site readers see which probes scan the site (no probes.manage needed); a
// site writer may ask them to rescan (rate-limited per site in the
// controller). Tunnels pick their probe among the site's probes.
router.get('/:id/probes', requireSiteRead(), siteController.listProbes);
router.post('/:id/rescan', requireSiteWrite(), siteController.rescan);
router.get('/:id/tunnel-probes', requireTenantCapability('tunnels.use'), requireSiteWrite(), siteController.listTunnelProbes);

// ── Items ─────────────────────────────────────────────────────────────────────
router.get('/:id/items', requireSiteRead(), siteController.listItems);
router.post('/:id/items', requireSiteWrite(), validate(createSiteItemSchema), siteController.createItem);
router.patch('/:id/items/:itemId', requireSiteWrite(), validate(updateSiteItemSchema), siteController.updateItem);
router.delete('/:id/items-by-subnet', requireSiteWrite(), requireAction('site.subnet_delete'), siteController.removeSubnet);
router.delete('/:id/items/:itemId', requireSiteWrite(), siteController.removeItem);

// ── Flows ────────────────────────────────────────────────────────────────────
router.get('/:id/flows', requireSiteRead(), siteController.listFlows);
router.delete('/:id/flows', requireSiteWrite(), siteController.clearFlows);

// ── IP Reservations ───────────────────────────────────────────────────────────
router.get('/:id/reservations', requireSiteRead(), siteController.listReservations);
router.post('/:id/reservations', requireSiteWrite(), validate(createReservationSchema), siteController.createReservation);
router.patch('/:id/reservations/:resId', requireSiteWrite(), validate(updateReservationSchema), siteController.updateReservation);
router.delete('/:id/reservations/:resId', requireSiteWrite(), siteController.removeReservation);

export default router;
