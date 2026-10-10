import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireTenantCapability } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { requireDbId, toDbId } from '../utils/dbId';
import { auditService } from '../services/audit.service';
import { permissionService } from '../services/permission.service';
import { BUSINESS_DAYS, type BusinessDay } from '../utils/businessHours';
import {
  maintenanceService,
  MAINTENANCE_KINDS,
  MAINTENANCE_SCOPES,
  type MaintenanceScope,
  type MaintenanceWindow,
  type MaintenanceWindowInput,
} from '../services/maintenance.service';

// Maintenance windows (port of Obliance routes/maintenance.routes).
// Mounted on the tenant router (requireAuth + requireTenant) at /maintenance.
//  - GET /active?siteId= — the windows active now for a site: site readers.
//  - Everything else needs the tenant capability 'settings'. A window on a
//    group / site also needs write access to that group / site for users
//    without full access; a tenant-wide window needs full access (platform
//    or tenant admin). The list shows tenant windows and the windows on
//    groups / sites the user holds a read permission on, each with a
//    `canEdit` flag (the client hides the actions otherwise).
// Every mutation is audited (maintenance.created / updated / deleted).

const router = Router();

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const windowSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(MAINTENANCE_SCOPES),
  scopeId: z.number().int().positive().nullable().optional(),
  kind: z.enum(MAINTENANCE_KINDS),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  recurrence: z.object({
    days: z.array(z.enum(BUSINESS_DAYS as unknown as [BusinessDay, ...BusinessDay[]])).min(1).max(7),
    start: z.string().regex(HHMM, 'start must be HH:MM'),
    end: z.string().refine((v) => v === '24:00' || HHMM.test(v), 'end must be HH:MM'),
  }).strict().nullable().optional(),
  timezone: z.string().trim().min(1).max(64).default('UTC'),
  enabled: z.boolean().default(true),
}).strict().superRefine((v, ctx) => {
  if (v.scope !== 'tenant' && (v.scopeId === null || v.scopeId === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeId'], message: 'scopeId is required for a group or site window' });
  }
  if (v.kind === 'one_time') {
    if (!v.startsAt) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['startsAt'], message: 'startsAt is required' });
    if (!v.endsAt) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'endsAt is required' });
    if (v.startsAt && v.endsAt && new Date(v.endsAt).getTime() <= new Date(v.startsAt).getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'endsAt must be after startsAt' });
    }
  } else if (!v.recurrence) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recurrence'], message: 'recurrence is required' });
  } else if (v.recurrence.start === v.recurrence.end) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recurrence', 'end'], message: 'end must differ from start (a whole day is 00:00–24:00)' });
  }
});

type WindowBody = z.infer<typeof windowSchema>;

function inputOf(body: WindowBody): MaintenanceWindowInput {
  return {
    name: body.name,
    scope: body.scope,
    scopeId: body.scope === 'tenant' ? null : body.scopeId ?? null,
    kind: body.kind,
    startsAt: body.startsAt ?? null,
    endsAt: body.endsAt ?? null,
    recurrence: body.recurrence
      ? { days: body.recurrence.days, start: body.recurrence.start, end: body.recurrence.end }
      : null,
    timezone: body.timezone,
    enabled: body.enabled,
  };
}

interface Caller {
  userId: number;
  tenantId: number;
  isPlatformAdmin: boolean;
}

function callerOf(req: Request): Caller {
  const userId = toDbId(req.session?.userId);
  if (userId === null) throw new AppError(401, 'Authentication required');
  return { userId, tenantId: req.tenantId, isPlatformAdmin: req.session.role === 'admin' };
}

/**
 * The caller may create / change / delete a window on this scope: tenant
 * scope = full access; group / site = it belongs to the tenant (404) and the
 * caller may write it (403).
 */
async function assertScopeWritable(
  c: Caller,
  scope: MaintenanceScope,
  scopeId: number | null,
  existing = false,
): Promise<void> {
  const full = await permissionService.isFullAccess(c.userId, c.tenantId, c.isPlatformAdmin);
  if (scope === 'tenant') {
    if (!full) throw new AppError(403, 'A tenant-wide maintenance window requires full access');
    return;
  }
  if (scopeId === null) throw new AppError(400, 'scopeId is required');
  // The group / site of an existing window was deleted (no foreign key): the
  // window covers nothing; full-access users may still edit or delete it.
  const missing = (msg: string): void => {
    if (existing && full) return;
    throw new AppError(404, msg);
  };
  if (scope === 'group') {
    if (!(await permissionService.findGroup(scopeId, c.tenantId))) return missing('Group not found');
    if (!full && !(await permissionService.canWriteGroup(c.userId, scopeId, c.tenantId, false))) {
      throw new AppError(403, 'Insufficient permissions');
    }
    return;
  }
  if (!(await permissionService.findSite(scopeId, c.tenantId))) return missing('Site not found');
  if (!full && !(await permissionService.canWriteSite(c.userId, scopeId, c.tenantId, false))) {
    throw new AppError(403, 'Insufficient permissions');
  }
}

/** An existing window of the tenant (404 when absent); callers check its scope themselves. */
async function managedWindow(req: Request, c: Caller): Promise<MaintenanceWindow> {
  const id = requireDbId(req.params.id, 'maintenance window ID');
  const existing = await maintenanceService.get(c.tenantId, id);
  if (!existing) throw new AppError(404, 'Maintenance window not found');
  return existing;
}

/**
 * Whether the window shows in the caller's list (tenant windows, and windows
 * on groups / sites they hold a real read permission on: ancestors shown only
 * for tree navigation do not count) and whether they may edit it.
 */
async function accessTo(c: Caller, w: MaintenanceWindow, full: boolean): Promise<{ visible: boolean; canEdit: boolean }> {
  if (full) return { visible: true, canEdit: true };
  if (w.scope === 'tenant') return { visible: true, canEdit: false };
  if (w.scopeId === null) return { visible: false, canEdit: false };
  if (w.scope === 'group') {
    const perm = await permissionService.getGroupPermission(c.userId, w.scopeId, c.tenantId, false);
    return { visible: perm !== null, canEdit: perm === 'rw' };
  }
  const perm = await permissionService.getSitePermission(c.userId, w.scopeId, c.tenantId, false);
  return { visible: perm !== null, canEdit: perm === 'rw' };
}

function auditDetails(w: MaintenanceWindow | MaintenanceWindowInput): Record<string, unknown> {
  return {
    name: w.name,
    scope: w.scope,
    scopeId: w.scopeId,
    kind: w.kind,
    startsAt: w.startsAt,
    endsAt: w.endsAt,
    recurrence: w.recurrence,
    timezone: w.timezone,
    enabled: w.enabled,
  };
}

// GET /active?siteId= — declared before the 'settings' gate: site readers.
router.get('/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const c = callerOf(req);
    const siteId = requireDbId(req.query.siteId, 'site ID');
    if (!(await permissionService.findSite(siteId, c.tenantId))) throw new AppError(404, 'Site not found');
    if (!c.isPlatformAdmin && !(await permissionService.canReadSite(c.userId, siteId, c.tenantId, false))) {
      throw new AppError(403, 'Insufficient permissions');
    }
    const windows = await maintenanceService.activeForSite(c.tenantId, siteId);
    res.json({ windows });
  } catch (err) { next(err); }
});

router.use(requireTenantCapability('settings'));

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const c = callerOf(req);
    const all = await maintenanceService.list(c.tenantId);
    const full = await permissionService.isFullAccess(c.userId, c.tenantId, c.isPlatformAdmin);
    const windows: Array<MaintenanceWindow & { canEdit: boolean }> = [];
    for (const w of all) {
      const access = await accessTo(c, w, full);
      if (access.visible) windows.push({ ...w, canEdit: access.canEdit });
    }
    res.json({ windows });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const c = callerOf(req);
    const window = await managedWindow(req, c);
    const full = await permissionService.isFullAccess(c.userId, c.tenantId, c.isPlatformAdmin);
    const access = await accessTo(c, window, full);
    if (!access.visible) throw new AppError(404, 'Maintenance window not found');
    res.json({ window: { ...window, canEdit: access.canEdit } });
  } catch (err) { next(err); }
});

router.post('/', validate(windowSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const c = callerOf(req);
    const input = inputOf(req.body as WindowBody);
    await assertScopeWritable(c, input.scope, input.scopeId);
    const window = await maintenanceService.create(c.tenantId, input, c.userId);
    await auditService.logReq(req, {
      action: 'maintenance.created',
      resourceType: 'maintenance_window',
      resourceId: window.id,
      details: auditDetails(window),
    });
    res.status(201).json({ window });
  } catch (err) { next(err); }
});

router.put('/:id', validate(windowSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const c = callerOf(req);
    const before = await managedWindow(req, c);
    // Both the current scope and the new one must be writable.
    await assertScopeWritable(c, before.scope, before.scopeId, true);
    const input = inputOf(req.body as WindowBody);
    // An unchanged scope keeps the "existing window" tolerance (orphan group / site).
    await assertScopeWritable(
      c,
      input.scope,
      input.scopeId,
      input.scope === before.scope && input.scopeId === before.scopeId,
    );
    const window = await maintenanceService.update(c.tenantId, before.id, input);
    if (!window) throw new AppError(404, 'Maintenance window not found');
    await auditService.logReq(req, {
      action: 'maintenance.updated',
      resourceType: 'maintenance_window',
      resourceId: window.id,
      details: { before: auditDetails(before), after: auditDetails(window) },
    });
    res.json({ window });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const c = callerOf(req);
    const before = await managedWindow(req, c);
    await assertScopeWritable(c, before.scope, before.scopeId, true);
    const deleted = await maintenanceService.delete(c.tenantId, before.id);
    if (!deleted) throw new AppError(404, 'Maintenance window not found');
    await auditService.logReq(req, {
      action: 'maintenance.deleted',
      resourceType: 'maintenance_window',
      resourceId: before.id,
      details: auditDetails(before),
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
