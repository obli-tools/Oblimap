import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler';
import { toDbId } from '../utils/dbId';
import {
  dashboardService,
  parseTimeseriesDays,
  type DashboardViewer,
} from '../services/dashboard.service';

// Dashboard. Mounted on the tenant router at
// /dashboard (requireAuth + requireTenant already applied). Open to every
// member of the tenant: each aggregate is limited to the sites the user may
// read (a member without any team permission gets zeros, not a 403), and
// the probe KPIs are filled only for 'probes.manage' holders.
const router = Router();

function viewerOf(req: Request): DashboardViewer {
  const userId = toDbId(req.session?.userId);
  if (userId === null) throw new AppError(401, 'Authentication required');
  const tenantId = toDbId(req.tenantId);
  if (tenantId === null) throw new AppError(403, 'no_tenant_access');
  return { userId, tenantId, isPlatformAdmin: req.session.role === 'admin' };
}

// GET /api/dashboard/summary
router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await dashboardService.getSummary(viewerOf(req));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/timeseries?days=14 (1..90)
router.get('/timeseries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewer = viewerOf(req);
    const days = parseTimeseriesDays(req.query.days);
    if (days === null) throw new AppError(400, 'Invalid days (1..90)');
    const data = await dashboardService.getTimeseries(viewer, days);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export default router;
