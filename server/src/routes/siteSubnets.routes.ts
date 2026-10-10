import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireSiteRead, requireSiteWrite } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { requireAction } from '../middleware/stepUp';
import { AppError } from '../middleware/errorHandler';
import { requireDbId } from '../utils/dbId';
import { auditService } from '../services/audit.service';
import { emitSiteUpdated } from '../services/realtime.service';
import { recordBatch as recordItemEvents } from '../services/itemEvents.service';
import { isIPv4 } from '../validators/probe.schema';
import {
  siteSubnetService,
  parseSubnet,
  formatCidr,
  PROBE_SUBNET_MIN_PREFIX,
  type SiteSubnetRow,
} from '../services/siteSubnet.service';

// Real subnets of a site. Mounted on the tenant router (requireAuth
// + requireTenant) at /sites/:siteId/subnets with mergeParams.
// requireSiteRead / requireSiteWrite('siteId'): the site must belong to the
// current tenant (404), then platform admin, tenant admin or a team
// permission on the site or its group chain (403). Every mutation is audited.

const router = Router({ mergeParams: true });

const nullableText = (max: number) => z.string().max(max).nullable().optional();

const subnetFields = {
  name: nullableText(100),
  vlan: z.number().int().min(1).max(4094).nullable().optional(),
  gateway: z.union([z.literal(''), z.string().max(15).refine(isIPv4, 'Invalid IPv4 address')]).nullable().optional(),
  description: nullableText(1000),
};

const createSubnetSchema = z.object({
  cidr: z.string().max(18),
  ...subnetFields,
}).strict();

const updateSubnetSchema = z.object({
  cidr: z.string().max(18).optional(),
  ...subnetFields,
}).strict().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

function siteIdOf(req: Request): number {
  return requireDbId(req.params.siteId, 'site ID');
}

/** ?cidr= → a normalised IPv4 subnet (400 otherwise). */
function cidrQuery(req: Request) {
  const raw = req.query.cidr;
  const net = typeof raw === 'string' ? parseSubnet(raw) : null;
  if (!net) throw new AppError(400, 'cidr query param required (e.g. 192.168.1.0/24)');
  return net;
}

function auditDetails(row: SiteSubnetRow): Record<string, unknown> {
  return {
    cidr: row.cidr,
    name: row.name,
    vlan: row.vlan,
    gateway: row.gateway,
  };
}

// GET / — manual subnets merged with the prefixes the site's probes scan.
router.get('/', requireSiteRead('siteId'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const subnets = await siteSubnetService.list(req.tenantId, siteIdOf(req));
    res.json({ subnets });
  } catch (err) { next(err); }
});

// GET /next-free?cidr= — first host not used by a device or a reservation.
router.get('/next-free', requireSiteRead('siteId'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const net = cidrQuery(req);
    const ip = await siteSubnetService.nextFree(req.tenantId, siteIdOf(req), net);
    res.json({ cidr: formatCidr(net), ip });
  } catch (err) { next(err); }
});

router.post('/', requireSiteWrite('siteId'), validate(createSubnetSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = siteIdOf(req);
    const row = await siteSubnetService.create(req.tenantId, siteId, req.body, req.session.userId ?? null);
    await auditService.logReq(req, {
      action: 'site_subnet.created',
      resourceType: 'site_subnet',
      resourceId: row.id,
      details: { siteId, ...auditDetails(row) },
    });
    emitSiteUpdated(req.tenantId, siteId);
    const subnet = await siteSubnetService.entry(req.tenantId, siteId, row.cidr);
    res.status(201).json({ subnet });
  } catch (err) { next(err); }
});

// DELETE /items?cidr= — the site's discovered devices inside the CIDR (and
// their flows). Declared before /:subnetId.
router.delete('/items', requireSiteWrite('siteId'), requireAction('site.subnet_delete'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = siteIdOf(req);
    const net = cidrQuery(req);
    // Never wider than the widest subnet the list can show (?cidr=0.0.0.0/0
    // would wipe every discovered device of the site in one call).
    if (net.prefix < PROBE_SUBNET_MIN_PREFIX) {
      throw new AppError(400, `cidr prefix must be /${PROBE_SUBNET_MIN_PREFIX} or narrower`);
    }
    const cidr = formatCidr(net);
    const { deleted, flowsDeleted, removed } = await siteSubnetService.deleteItemsInCidr(req.tenantId, siteId, net);
    await auditService.logReq(req, {
      action: 'site.subnet_deleted',
      resourceType: 'site',
      resourceId: siteId,
      details: { cidr, deleted, flowsDeleted },
    });
    // One 'deleted' event per device, written in one batch (the rows are gone: ids in details).
    if (removed.length > 0) {
      await recordItemEvents(removed.map((r) => ({
        tenantId: req.tenantId,
        siteId,
        actorUserId: req.session.userId ?? null,
        kind: 'deleted' as const,
        itemId: null,
        mac: r.mac,
        ip: r.ip,
        details: { itemId: r.id, name: r.name, subnet: cidr },
      })));
    }
    if (deleted > 0) emitSiteUpdated(req.tenantId, siteId);
    res.json({ deleted, flowsDeleted });
  } catch (err) { next(err); }
});

router.patch('/:subnetId', requireSiteWrite('siteId'), validate(updateSubnetSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = siteIdOf(req);
    const subnetId = requireDbId(req.params.subnetId, 'subnet ID');
    const result = await siteSubnetService.update(req.tenantId, siteId, subnetId, req.body);
    if (!result) throw new AppError(404, 'Subnet not found');
    await auditService.logReq(req, {
      action: 'site_subnet.updated',
      resourceType: 'site_subnet',
      resourceId: subnetId,
      details: { siteId, before: auditDetails(result.before), after: auditDetails(result.after) },
    });
    emitSiteUpdated(req.tenantId, siteId);
    const subnet = await siteSubnetService.entry(req.tenantId, siteId, result.after.cidr);
    res.json({ subnet });
  } catch (err) { next(err); }
});

router.delete('/:subnetId', requireSiteWrite('siteId'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = siteIdOf(req);
    const subnetId = requireDbId(req.params.subnetId, 'subnet ID');
    const row = await siteSubnetService.remove(req.tenantId, siteId, subnetId);
    if (!row) throw new AppError(404, 'Subnet not found');
    await auditService.logReq(req, {
      action: 'site_subnet.deleted',
      resourceType: 'site_subnet',
      resourceId: subnetId,
      details: { siteId, ...auditDetails(row) },
    });
    emitSiteUpdated(req.tenantId, siteId);
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
