import { Router, type NextFunction, type Request, type Response } from 'express';
import { probeLimiter } from '../middleware/rateLimiter';
import { requireProbeAuth } from '../middleware/probeAuth';
import { probeService } from '../services/probe.service';
import { clientIp } from '../utils/clientIp';

// Probe-called extras mounted at /api/probe/agent (before the /probe router).
// Same authentication chain and limiters as POST /api/probe/push: probeLimiter
// (per probe identity, and per address for rejected credentials) then
// requireProbeAuth (API key + UUID + identity token, key binding: see
// services/probeAuth.service.ts). No session, no cookie: the CSRF origin check
// does not apply.

const router = Router();

/**
 * POST /api/probe/agent/update-aborted {reason, version, targetVersion}
 * Sent by probes advertising 'update_abort_http:1' when an update was not
 * applied and no control WebSocket is open (the WS path sends update_aborted).
 * Recorded like the WS message: updating_since cleared, the reason stored on
 * the probe, audited 'probe.update_aborted' (throttled per probe and reason).
 */
router.post(
  '/update-aborted',
  probeLimiter,
  requireProbeAuth({ requireApproved: false }),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const probe = req.probe;
      if (!probe) {
        res.status(404).json({ error: 'probe_not_registered' });
        return;
      }
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      await probeService.recordUpdateAborted(probe.tenant_id, probe.id, {
        reason: body.reason,
        version: body.version,
        targetVersion: body.targetVersion,
        ip: clientIp(req) || null,
        via: 'http',
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
