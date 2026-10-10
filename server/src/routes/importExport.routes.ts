import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireAllTenantCapabilities } from '../middleware/rbac';
import { AppError } from '../middleware/errorHandler';
import { permissionService } from '../services/permission.service';
import { importExportController } from '../controllers/importExport.controller';
import { toDbId } from '../utils/dbId';

const router = Router();

// Mounted on the tenant router at /admin — next to /admin/smtp-servers, so the
// gates are per route (a router.use here would also run for those paths).
//
// Import / export carries the tenant's settings plus its groups, sites,
// notification channels (their secrets with includeSecrets) and teams with
// their permissions. Beyond the 'settings' tenant capability it
// requires the capability that manages each of those: otherwise a role
// holding only 'settings' could read every site, or grant its own team 'rw'
// everywhere through an import. Tenant and platform admins hold them all.
// The controller adds per-section gates: MAC-vendor overrides and permission
// sets are platform data (platform admins only), the vendor-rule import also
// needs deviceChecks.manage (as the vendor-rule routes).
const canImportExport = requireAllTenantCapabilities([
  'settings',
  'groups.manage',
  'sites.manage',
  'notifications.manage',
  'users.manage',
]);

/**
 * CSV import of reservations / devices: write permission on the target site
 * (body.siteId, a site of req.tenantId — 404 otherwise), not the import gate
 * above. Same checks as requireSiteWrite, which reads a route param.
 */
async function requireBodySiteWrite(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = toDbId(req.session?.userId);
    if (userId === null) return next(new AppError(401, 'Authentication required'));
    const tenantId = toDbId(req.tenantId);
    if (tenantId === null) return next(new AppError(403, 'no_tenant_access'));
    const siteId = toDbId((req.body as { siteId?: unknown } | undefined)?.siteId);
    if (siteId === null) return next(new AppError(400, 'Invalid site ID'));
    if (!(await permissionService.findSite(siteId, tenantId))) return next(new AppError(404, 'Site not found'));
    const isPlatformAdmin = req.session.role === 'admin';
    if (!isPlatformAdmin && !(await permissionService.canWriteSite(userId, siteId, tenantId, false))) {
      return next(new AppError(403, 'Insufficient permissions'));
    }
    next();
  } catch (err) {
    next(err);
  }
}

router.get('/export', requireAuth, canImportExport, importExportController.exportData);
router.post('/import', requireAuth, canImportExport, importExportController.importData);
router.post('/import/csv/preview', requireAuth, requireBodySiteWrite, importExportController.csvPreview);
router.post('/import/csv/commit', requireAuth, requireBodySiteWrite, importExportController.csvCommit);

export default router;
