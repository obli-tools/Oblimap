import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireTenantCapability } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { probeService } from '../services/probe.service';
import { auditService } from '../services/audit.service';

// Probe fleet versions and the paced "Update outdated probes" action
// (ported from Obliance's AgentVersionsCard / update-all-agents).
// Mounted at /api/probe/fleet before the /probe router: session + tenant +
// probes.manage (the capability of every probe command). Every query is
// filtered on req.tenantId.

const router = Router();
router.use(requireAuth);
router.use(requireTenant);
router.use(requireTenantCapability('probes.manage'));

/** Default pace of "Update outdated probes" (commands per minute). */
export const FLEET_UPDATE_DEFAULT_PER_MINUTE = 10;

export const fleetUpdateSchema = z.object({
  dryRun: z.boolean().optional(),
  perMinute: z.number().int().min(1).max(60).optional(),
}).strict();

// GET /api/probe/fleet/versions — {latestVersion, total, outdated, versions: [{version, count, outdated}], rollout}
router.get('/versions', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json({ data: await probeService.getVersionDistribution(req.tenantId) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/probe/fleet/update-outdated {dryRun?, perMinute? (1-60, default 10)}
 * dryRun: the probes it would update (approved, outdated, idle; scopes whose
 * probeUpdatePolicy is 'frozen' skipped and counted). Otherwise queues an
 * 'update' command for each of them, paced per tenant (perMinute), audited
 * 'probe.fleet_update'; answers {queued, ...}.
 */
router.post('/update-outdated', validate(fleetUpdateSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as z.infer<typeof fleetUpdateSchema>;
    const perMinute = body.perMinute ?? FLEET_UPDATE_DEFAULT_PER_MINUTE;
    const preview = await probeService.outdatedProbes(req.tenantId);
    if (!preview.latestVersion) {
      res.status(409).json({ error: 'latest_version_unknown' });
      return;
    }
    if (body.dryRun) {
      res.json({ data: { ...preview, perMinute } });
      return;
    }
    const queued = preview.probes.length > 0
      ? probeService.startFleetUpdate(req.tenantId, preview.probes.map((p) => p.id), perMinute)
      : 0;
    void auditService.logReq(req, {
      action: 'probe.fleet_update',
      resourceType: 'probe',
      details: {
        targetVersion: preview.latestVersion,
        targets: preview.probes.length,
        queued,
        frozen: preview.frozen,
        perMinute,
      },
    });
    res.json({ data: { queued, targets: preview.probes.length, frozen: preview.frozen, perMinute, latestVersion: preview.latestVersion } });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/probe/fleet/update-outdated — stops the paced rollout (commands already sent stay sent).
router.delete('/update-outdated', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const cancelled = probeService.cancelFleetUpdate(req.tenantId);
    if (cancelled > 0) {
      void auditService.logReq(req, {
        action: 'probe.fleet_update_cancelled',
        resourceType: 'probe',
        details: { cancelled },
      });
    }
    res.json({ data: { cancelled } });
  } catch (err) {
    next(err);
  }
});

export default router;
