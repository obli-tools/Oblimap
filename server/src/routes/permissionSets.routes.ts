import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import {
  permissionSetService,
  LEGACY_MEMBER_ROLE,
  PERMISSION_SET_SLUG_RE,
  TENANT_CAPABILITIES,
} from '../services/permissionSet.service';
import { invalidateTenantCapabilityCache } from '../services/permission.service';
import { auditService } from '../services/audit.service';
import { emitPermissionsChanged } from '../services/realtime.service';
import { db } from '../db';
import { requireDbId } from '../utils/dbId';

// Permission sets = the tenant roles (user_tenants.role). They
// are platform-wide: any signed-in user may list them (role pickers), only
// platform admins change them. Changes apply to every membership using the
// set (capability cache dropped at once) and are audited as platform events.
// Errors never carry the database's message: a duplicate slug is
// a 409, anything unexpected goes to the error handler (logged, generic 500).

const router = Router();
router.use(requireAuth);

// ── Validation ─────────────────────────────────────────────────────────────
const nameSchema = z.string().trim().min(1).max(64);
const capabilitiesSchema = z.array(z.enum(TENANT_CAPABILITIES))
  .max(TENANT_CAPABILITIES.length * 2)
  .transform((caps) => [...new Set(caps)]);

const createPermissionSetSchema = z.object({
  name: nameSchema,
  slug: z.string().trim().toLowerCase()
    .regex(PERMISSION_SET_SLUG_RE, 'Lowercase letters, digits and dashes (at most 64)')
    .refine((slug) => slug !== LEGACY_MEMBER_ROLE, `The slug "${LEGACY_MEMBER_ROLE}" is reserved`),
  capabilities: capabilitiesSchema.default([]),
});

const updatePermissionSetSchema = z.object({
  name: nameSchema.optional(),
  // Accepted only unchanged: the slug is what memberships store.
  slug: z.string().max(64).optional(),
  capabilities: capabilitiesSchema.optional(),
}).refine((b) => b.name !== undefined || b.capabilities !== undefined, {
  message: 'Nothing to update (name or capabilities)',
});

/**
 * Tells the open clients of every user whose tenant role is this set (any
 * tenant; the legacy 'member' role reads as 'viewer') to refetch their
 * permissions. Never throws: the change itself is already saved.
 */
async function notifySetHolders(slug: string): Promise<void> {
  try {
    const roles = slug === 'viewer' ? [slug, LEGACY_MEMBER_ROLE] : [slug];
    const rows = await db('user_tenants').whereIn('role', roles).distinct('user_id') as Array<{ user_id: number }>;
    emitPermissionsChanged(rows.map((r) => Number(r.user_id)));
  } catch {
    // Best effort: without the push the clients catch up on their next refresh.
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/**
 * GET /api/permission-sets
 * Returns all permission sets. Requires authentication. Platform admins (the
 * only ones who edit the sets) also get memberCount per set: the tenant
 * memberships of every tenant using it (the legacy 'member' role counts for
 * 'viewer') — a platform-wide figure, not sent to tenant members.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sets = await permissionSetService.getAll();
    if (req.session.role !== 'admin') {
      res.json({ success: true, data: sets });
      return;
    }
    const counts = await Promise.all(sets.map((s) => permissionSetService.countMemberships(s.slug)));
    res.json({ success: true, data: sets.map((s, i) => ({ ...s, memberCount: counts[i] })) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/permission-sets/capabilities
 * Returns the tenant capabilities of this app. Requires authentication.
 */
router.get('/capabilities', (_req: Request, res: Response) => {
  res.json({ success: true, data: permissionSetService.getAvailableCapabilities() });
});

/**
 * POST /api/permission-sets
 * Creates a new permission set. Platform admin only.
 */
router.post('/', requireRole('admin'), validate(createPermissionSetSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, slug, capabilities } = req.body as z.infer<typeof createPermissionSetSchema>;
    let set;
    try {
      set = await permissionSetService.create({ name, slug, capabilities });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'A permission set with this slug already exists');
      throw err;
    }
    await auditService.logReq(req, {
      tenantId: null,
      action: 'permission_set.created',
      resourceType: 'permission_set',
      resourceId: set.id,
      details: { name: set.name, slug: set.slug, capabilities: set.capabilities },
    });
    res.status(201).json({ success: true, data: set });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/permission-sets/:id
 * Renames a permission set and / or replaces its capabilities. Platform admin only.
 */
router.put('/:id', requireRole('admin'), validate(updatePermissionSetSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = requireDbId(req.params.id, 'permission set id');
    const { name, slug, capabilities } = req.body as z.infer<typeof updatePermissionSetSchema>;

    const existing = await permissionSetService.getById(id);
    if (!existing) throw new AppError(404, 'Permission set not found');
    if (slug !== undefined && slug.trim().toLowerCase() !== existing.slug) {
      throw new AppError(400, 'The slug of a permission set cannot be changed');
    }

    const result = await permissionSetService.update(id, { name, capabilities });
    if (!result) throw new AppError(404, 'Permission set not found');
    invalidateTenantCapabilityCache();

    const { before, after } = result;
    const added = after.capabilities.filter((c) => !before.capabilities.includes(c));
    const removed = before.capabilities.filter((c) => !after.capabilities.includes(c));
    if (added.length > 0 || removed.length > 0) await notifySetHolders(after.slug);
    if (before.name !== after.name || added.length > 0 || removed.length > 0) {
      await auditService.logReq(req, {
        tenantId: null,
        action: 'permission_set.updated',
        resourceType: 'permission_set',
        resourceId: id,
        details: {
          slug: after.slug,
          ...(before.name !== after.name ? { name: { from: before.name, to: after.name } } : {}),
          ...(added.length > 0 ? { added } : {}),
          ...(removed.length > 0 ? { removed } : {}),
        },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/permission-sets/:id
 * Deletes a custom permission set no membership uses. Platform admin only.
 */
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = requireDbId(req.params.id, 'permission set id');
    const deleted = await permissionSetService.delete(id);
    if (!deleted) throw new AppError(404, 'Permission set not found');
    invalidateTenantCapabilityCache();
    await notifySetHolders(deleted.slug);
    await auditService.logReq(req, {
      tenantId: null,
      action: 'permission_set.deleted',
      resourceType: 'permission_set',
      resourceId: id,
      details: { name: deleted.name, slug: deleted.slug },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
