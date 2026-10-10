import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireRole, requireTenantCapability } from '../middleware/rbac';
import { AppError } from '../middleware/errorHandler';
import { auditService, type AuditListFilter } from '../services/audit.service';
import { toDbId, requireDbId } from '../utils/dbId';

// Audit log (read-only). Mounted on the tenant router (requireAuth +
// requireTenant already applied). It reveals user actions: the current
// tenant's entries take the 'audit.read' tenant capability (held by
// platform admins, tenant admins and roles granting it); the cross-tenant
// view (/all, platform events included) is platform-admin only.
const router = Router();

function optionalId(value: unknown, label: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  return requireDbId(value, label);
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new AppError(400, `Invalid ${label}`);
  const s = value.trim();
  return s === '' ? undefined : s;
}

function parseFilter(query: Request['query']): AuditListFilter {
  const limitRaw = query.limit;
  let limit: number | undefined;
  if (limitRaw !== undefined && limitRaw !== '') {
    const n = toDbId(limitRaw);
    if (n == null) throw new AppError(400, 'Invalid limit');
    limit = Math.min(200, n);
  }
  return {
    before: optionalId(query.before, 'before'),
    limit,
    action: optionalString(query.action, 'action', 100),
    resourceType: optionalString(query.resourceType, 'resourceType', 50),
    userId: optionalId(query.userId, 'userId'),
  };
}

// GET /api/audit?before=&limit=&action=user.&resourceType=probe&userId=
// Entries of the current tenant.
router.get('/', requireTenantCapability('audit.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await auditService.list(req.tenantId, parseFilter(req.query));
    res.json(result); // { items, nextCursor }
  } catch (err) {
    next(err);
  }
});

// GET /api/audit/all?tenantId=  (platform admin) — every tenant, including
// platform events without a tenant (failed logins, SSO sync); tenantId narrows
// to one tenant.
router.get('/all', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = optionalId(req.query.tenantId, 'tenantId') ?? null;
    const result = await auditService.list(tenantId, parseFilter(req.query));
    res.json(result); // { items, nextCursor }
  } catch (err) {
    next(err);
  }
});

export default router;
