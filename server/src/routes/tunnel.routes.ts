import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireTenantCapability } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import type { Tunnel } from '@oblimap/shared';
import { TUNNEL_SCHEMES } from '@oblimap/shared';
import {
  tunnelService,
  isTunnelId,
  canViewTunnel,
  parseTunnelListQuery,
  tunnelRequesterFilter,
} from '../services/tunnel.service';
import {
  changeTunnelScheme,
  createProxyAccess,
  getTunnelScheme,
  proxyHandler,
} from '../services/tunnelProxy.service';
import { permissionService } from '../services/permission.service';
import { auditService } from '../services/audit.service';
import { AppError } from '../middleware/errorHandler';
import { openTunnelSchema } from '../validators/tunnel.schema';
import { requireAction } from '../middleware/stepUp';

// ─── Web proxy (token-authenticated) ────────────────────────────────────────
//
// ALL /api/tunnel/p/<token>/... — the device's web UI through the tunnel's
// probe (services/tunnelProxy.service.ts). Every request, sub-resources
// included, is authorized by the per-tunnel proxy token in its path, never by
// the Oblimap session: this router is mounted OUTSIDE the session-
// authenticated tenant router (routes/index.ts: router.use('/tunnel/p',
// tunnelProxyRouter), before the tenant router).
export const tunnelProxyRouter = Router();
tunnelProxyRouter.all('/:token', proxyHandler);
tunnelProxyRouter.all('/:token/*', proxyHandler);

const router = Router();

// All tunnel routes require auth + tenant + the 'tunnels.use' tenant
// capability: platform admins, tenant admins and roles granting
// it. Opening a tunnel also needs write permission on the site (its team
// permissions: a tunnel reaches the site's LAN). Without full access to the
// tenant (platform / tenant admin), a user sees and closes only the tunnels
// they opened; web proxy links are issued to the tunnel's opener while they
// keep write permission on the site (and to platform admins).
router.use(requireAuth);
router.use(requireTenant);
router.use(requireTenantCapability('tunnels.use'));

const schemeField = z.enum(TUNNEL_SCHEMES as [string, ...string[]]).optional();

const openTunnelWithSchemeSchema = openTunnelSchema.extend({ scheme: schemeField });
type OpenTunnelWithSchemeInput = z.infer<typeof openTunnelWithSchemeSchema>;

const proxyAccessSchema = z.object({ scheme: schemeField }).strict();

/** Platform admin or tenant admin: every tunnel of the tenant. */
async function hasFullTunnelAccess(req: Request): Promise<boolean> {
  return permissionService.isFullAccess(req.session.userId!, req.tenantId, req.session.role === 'admin');
}

/** The tunnel when the requester may see it (theirs, or full access), else null. */
async function visibleTunnel(req: Request, tunnelId: string): Promise<Tunnel | null> {
  const tunnel = await tunnelService.getTunnel(tunnelId, req.tenantId);
  if (!tunnel) return null;
  // Own tunnel first: no permission lookup for the common case.
  const userId = req.session.userId!;
  if (canViewTunnel(tunnel, { userId, fullAccess: false })) return tunnel;
  if (canViewTunnel(tunnel, { userId, fullAccess: await hasFullTunnelAccess(req) })) return tunnel;
  return null;
}

/**
 * The active tunnel whose web proxy the requester may use: opened by them
 * (or a platform admin asking), site still writable. null otherwise.
 */
async function proxyableTunnel(req: Request, tunnelId: string): Promise<Tunnel | null> {
  const tunnel = isTunnelId(tunnelId) ? await tunnelService.getTunnel(tunnelId, req.tenantId) : null;
  if (!tunnel || tunnel.status !== 'active') return null;
  const isPlatformAdmin = req.session.role === 'admin';
  if (tunnel.requestedBy !== req.session.userId && !isPlatformAdmin) return null;
  const perm = await permissionService.getSitePermission(req.session.userId!, tunnel.siteId, req.tenantId, isPlatformAdmin);
  return perm === 'rw' ? tunnel : null;
}

// POST /api/tunnel — open a new tunnel. Answers the tunnel and a web proxy
// link for the opener (`proxy`, see TunnelProxyAccess). A tenant may require a
// fresh 2FA step-up for it ('tunnel.open', after the site write check).
async function requireTunnelSiteWrite(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const { siteId } = req.body as OpenTunnelWithSchemeInput;
    // The site must be in the tenant (404, as the service would answer) and
    // writable by the requester.
    if (!(await permissionService.findSite(siteId, req.tenantId))) throw new AppError(404, 'Site not found');
    const sitePermission = await permissionService.getSitePermission(
      req.session.userId!, siteId, req.tenantId, req.session.role === 'admin',
    );
    if (sitePermission !== 'rw') throw new AppError(403, 'Write permission on the site is required to open a tunnel');
    next();
  } catch (err) {
    next(err);
  }
}

router.post('/', validate(openTunnelWithSchemeSchema), requireTunnelSiteWrite, requireAction('tunnel.open'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { siteId, targetIp, targetPort, probeId, scheme } = req.body as OpenTunnelWithSchemeInput;

    const tunnel = await tunnelService.openTunnel(
      req.tenantId,
      req.session.userId!,
      siteId,
      targetIp,
      targetPort,
      probeId ?? null,
      (scheme as 'auto' | 'http' | 'https' | undefined) ?? 'auto',
    );

    void auditService.logReq(req, {
      action: 'tunnel.opened',
      probeId: tunnel.probeId,
      resourceType: 'tunnel',
      resourceId: tunnel.id,
      details: { siteId, probeId: tunnel.probeId, target: `${targetIp}:${targetPort}`, scheme: scheme ?? 'auto' },
    });

    const proxy = tunnel.status === 'active' ? await createProxyAccess(tunnel, req.session.userId!) : null;
    res.json({ tunnel, proxy });
  } catch (err) {
    next(err);
  }
});

// POST /api/tunnel/:id/proxy-access {scheme?} — a new web proxy link for the
// tunnel's opener (dialog reopened, scheme changed). The link expires with
// the tunnel.
router.post('/:id/proxy-access', validate(proxyAccessSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tunnel = await proxyableTunnel(req, req.params.id);
    if (!tunnel) throw new AppError(404, 'Tunnel not found');
    const { scheme } = req.body as z.infer<typeof proxyAccessSchema>;
    if (scheme && scheme !== getTunnelScheme(tunnel.id)) {
      changeTunnelScheme(tunnel.id, scheme as 'auto' | 'http' | 'https');
      void auditService.logReq(req, {
        action: 'tunnel.scheme_changed',
        probeId: tunnel.probeId,
        resourceType: 'tunnel',
        resourceId: tunnel.id,
        details: { siteId: tunnel.siteId, target: `${tunnel.targetIp}:${tunnel.targetPort}`, scheme },
      });
    }
    res.json({ proxy: await createProxyAccess(tunnel, req.session.userId!) });
  } catch (err) {
    next(err);
  }
});

// Former session-authenticated proxy (/api/tunnel/:id/proxy/...): links that
// still point there are moved to a token link of the same tunnel.
async function legacyProxyRedirect(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const method = req.method.toUpperCase();
    const tunnel = await proxyableTunnel(req, req.params.id);
    if (!tunnel) throw new AppError(404, 'Tunnel not found');
    if (method !== 'GET' && method !== 'HEAD') throw new AppError(410, 'Open the device through its tunnel link');
    const access = await createProxyAccess(tunnel, req.session.userId!);
    const marker = `/${tunnel.id}/proxy`;
    const at = req.originalUrl.indexOf(marker);
    const rest = at >= 0 ? req.originalUrl.slice(at + marker.length).replace(/^\//, '') : '';
    const safeRest = /^[\x21-\x7e]{0,8192}$/.test(rest) && !rest.startsWith('/') ? rest : '';
    res.redirect(302, `${access.url}${safeRest}`);
  } catch (err) {
    next(err);
  }
}
router.all('/:id/proxy', legacyProxyRedirect);
router.all('/:id/proxy/*', legacyProxyRedirect);

// GET /api/tunnel?status=active|closed&limit= — supervision list (full access:
// every tunnel of the tenant; else the requester's). Active (default): the
// open tunnels, newest first. Closed: the finished ones (closed / error),
// newest closed first, 50 by default, 200 at most. Rows carry the opener's
// username, the probe and site names (raw: the client anonymizes).
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = parseTunnelListQuery(req.query as Record<string, unknown>);
    if (!query) throw new AppError(400, 'Invalid status or limit');
    const requestedBy = tunnelRequesterFilter({
      userId: req.session.userId!,
      fullAccess: await hasFullTunnelAccess(req),
    });
    const tunnels = await tunnelService.listTunnelEntries(req.tenantId, query, requestedBy);
    res.json({ tunnels });
  } catch (err) {
    next(err);
  }
});

// GET /api/tunnel/:id — get tunnel status
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tunnel = await visibleTunnel(req, req.params.id);
    if (!tunnel) throw new AppError(404, 'Tunnel not found');
    res.json({ tunnel });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tunnel/:id — close a tunnel
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!(await visibleTunnel(req, req.params.id))) throw new AppError(404, 'Tunnel not found');
    const result = await tunnelService.closeTunnel(req.params.id, req.tenantId);
    if (!result) throw new AppError(404, 'Tunnel not found');
    if (result.closed) {
      const { tunnel } = result;
      void auditService.logReq(req, {
        action: 'tunnel.closed',
        probeId: tunnel.probeId,
        resourceType: 'tunnel',
        resourceId: tunnel.id,
        details: { siteId: tunnel.siteId, probeId: tunnel.probeId, target: `${tunnel.targetIp}:${tunnel.targetPort}` },
      });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
