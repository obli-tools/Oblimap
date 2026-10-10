import type { Request, Response, NextFunction } from 'express';
import { authenticateProbe, type ProbeRow, type ProbeApiKeyRef } from '../services/probeAuth.service';
import { clientIp } from '../utils/clientIp';
import { tagGate } from './rbac';

// Express guard for probe-called HTTP routes (API key + UUID [+ identity
// token]); see services/probeAuth.service.ts for the rules.

declare global {
  namespace Express {
    interface Request {
      /** The authenticated probe (set by requireProbeAuth). */
      probe?: ProbeRow & { apiKeyId: number };
      /** The API key that authenticated the request (set by requireProbeAuth). */
      probeApiKey?: ProbeApiKeyRef;
      /** The probe advertises the identity-token feature but holds no token yet: issue one in the response. */
      probeShouldIssueToken?: boolean;
    }
  }
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

export function requireProbeAuth(opts: { requireApproved: boolean; requireSite?: boolean; allowUnknownProbe?: boolean }) {
  return tagGate(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await authenticateProbe({
        apiKey: header(req, 'x-api-key'),
        probeUuid: header(req, 'x-probe-uuid'),
        probeToken: header(req, 'x-probe-token'),
        features: header(req, 'x-probe-features'),
        requireApproved: opts.requireApproved,
        allowUnknownProbe: opts.allowUnknownProbe === true,
        // Identity v2: requests in flight while the probe switches to the
        // shared device ID still resolve (never used by the push).
        aliasFallback: true,
        ip: clientIp(req) || null,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.code });
        return;
      }
      req.probeApiKey = result.apiKey;
      req.probeShouldIssueToken = result.shouldIssueToken;
      if (!result.probe) {
        // Only reachable with allowUnknownProbe: the route registers the probe.
        next();
        return;
      }
      if (opts.requireSite && !result.probe.site_id) {
        res.status(409).json({ error: 'probe_no_site' });
        return;
      }
      req.probe = { ...result.probe, apiKeyId: result.apiKey.id };
      next();
    } catch (err) {
      next(err);
    }
  }, { kind: 'probeAuth', requireApproved: opts.requireApproved, requireSite: opts.requireSite === true });
}
