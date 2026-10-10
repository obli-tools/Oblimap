import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireRole, requireTenantCapability } from '../middleware/rbac';
import { requireTenant } from '../middleware/tenant';
import { validate } from '../middleware/validate';
import { tenantService, leaveTenantRooms } from '../services/tenant.service';
import { permissionSetService } from '../services/permissionSet.service';
import { invalidateTenantCapabilityCache, permissionService } from '../services/permission.service';
import rateLimit from 'express-rate-limit';
import { emitPermissionsChanged } from '../services/realtime.service';
import { auditService } from '../services/audit.service';
import { AppError } from '../middleware/errorHandler';
import { db } from '../db';
import { requireDbId, toDbId } from '../utils/dbId';
import { userHasTenantAccess, invalidateTenantAccessCache } from '../utils/sessionTenant';
import { userService } from '../services/user.service';
import { killSessionsForUser } from '../services/userSessions.service';
import { invalidateAccountableCache } from '../services/deviceChecks/config.service';
import {
  ACTION_KEYS,
  diffRestrictions,
  restrictionService,
  type ActionKey,
} from '../services/restriction.service';
import { hasFreshStepUp, loadStepUpFactors, stepUpRefusal } from '../middleware/stepUp';
import {
  actorFromReq,
  guardLastTenantAdmin,
  normaliseTenantRole,
  refuse,
  sendScopeError,
  userScope,
} from '../services/userScope.service';

const router = Router();

// All tenant routes require auth
router.use(requireAuth);

// ── Validation ─────────────────────────────────────────────────────────────
const dbIdSchema = z.number().int().positive().max(2_147_483_647);
// Tenant-level role (user_tenants.role): 'admin' (tenant admin,
// every capability), the legacy 'member' (read as the 'viewer' set) or the
// slug of an existing permission set — checked against the database, and
// again by tenantService in the transaction that writes it (a set deleted in
// between answers 400 there).
const memberRoleSchema = z.string().trim().min(1).max(64)
  .refine(
    (role) => permissionSetService.isAssignableTenantRole(role),
    { message: "Unknown role: use 'admin', 'member' or the slug of an existing permission set" },
  );

/** validate() for schemas with async (database) refinements. */
function validateAsync(schema: z.ZodTypeAny) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await schema.safeParseAsync(req.body);
      if (!result.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: result.error.flatten().fieldErrors,
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }
      req.body = result.data;
      next();
    } catch (err) {
      next(err);
    }
  };
}

const switchTenantSchema = z.object({ tenantId: dbIdSchema });
const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(128),
  slug: z.string().trim().min(1).max(64),
});
const updateTenantSchema = createTenantSchema.partial();
const addMemberSchema = z.object({
  userId: dbIdSchema,
  role: memberRoleSchema.optional(),
});
const updateMemberSchema = z.object({ role: memberRoleSchema });
// /tenant/current/members: an existing account by exact username or e-mail.
const addCurrentMemberSchema = z.object({
  usernameOrEmail: z.string().trim().min(1).max(254),
  role: z.string().trim().min(1).max(64).optional(),
});
const updateCurrentMemberSchema = z.object({ role: z.string().trim().min(1).max(64) });

function isPlatformAdmin(req: Request): boolean {
  return req.session.role === 'admin';
}

function requirePlatformAdmin(req: Request): void {
  if (!isPlatformAdmin(req)) throw new AppError(403, 'Admin only');
}

/**
 * A duplicate slug: unique violation on the slug index of migration 003
 * (knex default name tenants_slug_unique). Any other unique violation (a
 * primary key, ...) is not a slug conflict and is rethrown as is.
 */
function isSlugConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && e.constraint === 'tenants_slug_unique';
}

/**
 * The user whose membership is added or changed. An Obligate-provisioned
 * account (og_) is refused, as by PUT /users/:id/tenants: Obligate owns its
 * tenants and tenant roles (the next SSO sign-in would overwrite them).
 */
async function getUserForMembership(userId: number): Promise<{ id: number; username: string; role: string }> {
  const user = await db('users').where({ id: userId }).first('id', 'username', 'role', 'foreign_source') as
    { id: number; username: string; role: string; foreign_source: string | null } | undefined;
  if (!user) throw new AppError(404, 'User not found');
  if (user.foreign_source === 'obligate') {
    throw new AppError(400, 'Cannot modify SSO user tenant access — manage from Obligate');
  }
  return { id: user.id, username: user.username, role: user.role };
}

// ── Locate a site across the user's tenants ───────────────────────────────
// GET /api/tenants/locate-site/:id
//
// Resolves the tenant a site belongs to, for a shared deep link (/sites/123)
// opened while the session works in another tenant. "Unknown site", "not a
// member of its tenant" and "no read permission on it" all answer the same
// 404, so the route never reveals a site the caller cannot read. Misses are
// rate-limited per user (a probe of site ids stops quickly).
const locateMissLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, error: 'Too many requests' },
  keyGenerator: (req: Request) => `locate-site:${req.session.userId ?? 'anonymous'}`,
});

router.get('/locate-site/:id', locateMissLimiter, async (req, res, next) => {
  try {
    const notFound = () => res.status(404).json({ success: false, error: 'Site not found' });
    const siteId = toDbId(req.params.id);
    if (siteId === null) { notFound(); return; }

    const userId = req.session.userId!;
    const platformAdmin = isPlatformAdmin(req);

    const row = await db('sites')
      .join('tenants', 'sites.tenant_id', 'tenants.id')
      .where('sites.id', siteId)
      .first('sites.tenant_id as tenantId', 'tenants.name as tenantName') as
      { tenantId: number; tenantName: string } | undefined;
    if (!row) { notFound(); return; }

    // Same gates as GET /api/sites/:id in that tenant: membership (any tenant
    // for platform admins), then read permission on the site.
    const tenantId = Number(row.tenantId);
    const member = await userHasTenantAccess(userId, tenantId, platformAdmin);
    const allowed = member
      && await permissionService.canReadSite(userId, siteId, tenantId, platformAdmin);
    if (!allowed) { notFound(); return; }

    res.json({
      success: true,
      data: {
        siteId,
        tenantId,
        tenantName: row.tenantName,
        currentTenantId: toDbId(req.session.currentTenantId),
      },
    });
  } catch (err) {
    next(err);
  }
});

/** foreign_source of each user id ('obligate' = SSO account). */
async function foreignSources(userIds: number[]): Promise<Map<number, string | null>> {
  if (userIds.length === 0) return new Map();
  const rows = await db('users').whereIn('id', userIds).select('id', 'foreign_source') as
    Array<{ id: number; foreign_source: string | null }>;
  return new Map(rows.map((r) => [Number(r.id), r.foreign_source ?? null] as const));
}

// ── Members of the current tenant (users.manage) ─────────────────
// /api/tenant/current/members — for holders of the tenant capability
// users.manage (tenant admins hold it; platform admins too). The dominance
// rules of userScope apply: only members the caller dominates, only roles
// whose capabilities the caller holds ('admin' by a tenant admin only),
// never the caller's own row, never the last active tenant admin, never an
// SSO account (Obligate owns its memberships). Refusals: 403
// { error: 'forbidden', reason }. Registered before the /:id routes.

const currentMembers = Router();
currentMembers.use(requireTenant);
currentMembers.use(requireTenantCapability('users.manage'));

// Unknown and unavailable accounts answer the same 404: a burst of misses
// (guessing usernames / e-mail addresses) is cut short per user.
const memberLookupLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, error: 'Too many requests' },
  keyGenerator: (req: Request) => `member-lookup:${req.session.userId ?? 'anonymous'}`,
});

/** Cache drops and the live push after a membership change of `userId`. */
function membershipChanged(userId: number): void {
  invalidateTenantAccessCache(userId);
  invalidateTenantCapabilityCache(userId);
  invalidateAccountableCache(userId);
  emitPermissionsChanged([userId]);
}

// GET /api/tenant/current/members
currentMembers.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await userService.getTenantUsers(req.tenantId) });
  } catch (err) {
    next(err);
  }
});

// POST /api/tenant/current/members  { usernameOrEmail, role? }
// An existing local account, by exact username or e-mail address (no search
// of the global user table). Role default 'viewer'.
currentMembers.post('/', memberLookupLimiter, validate(addCurrentMemberSchema), async (req, res, next) => {
  try {
    const actor = actorFromReq(req);
    const { usernameOrEmail, role: requestedRole } = req.body as z.infer<typeof addCurrentMemberSchema>;
    const role = await userScope.assertGrantableRole(actor, requestedRole ?? 'viewer');

    const needle = usernameOrEmail.trim();
    const candidates = await db('users')
      .where('username', needle)
      .orWhere(db.raw('lower(email) = lower(?)', [needle]))
      .select('id', 'username', 'role', 'foreign_source', 'email') as
      Array<{ id: number; username: string; role: string; foreign_source: string | null; email: string | null }>;
    // An exact username wins over an e-mail match; an ambiguous e-mail,
    // an SSO account (Obligate owns its tenants), a platform admin for a
    // caller that is not one, or a current member: the same 404.
    const byName = candidates.find((c) => c.username === needle);
    const byEmail = candidates.filter((c) => c.username !== needle);
    const user = byName ?? (byEmail.length === 1 ? byEmail[0] : undefined);
    const unavailable = !user
      || user.foreign_source
      || (!actor.isPlatformAdmin && user.role === 'admin')
      || await tenantService.getMembership(actor.tenantId, Number(user.id));
    if (unavailable || !user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    const userId = Number(user.id);
    await tenantService.addUser(actor.tenantId, userId, role);
    membershipChanged(userId);
    await auditService.logReq(req, {
      action: 'tenant.member_added',
      resourceType: 'user',
      resourceId: userId,
      details: { username: user.username, role },
    });
    res.status(201).json({ success: true });
  } catch (err) {
    sendScopeError(err, res, next);
  }
});

/** The member targeted by PUT / DELETE: never oneself, never an SSO account, dominated. */
async function requireManagedMember(req: Request, userId: number) {
  const actor = actorFromReq(req);
  if (userId === actor.userId) refuse('self');
  const target = await userScope.assertManageableTarget(actor, userId, { accountWide: false });
  if (target.tenantRole === null) throw new AppError(404, 'Membership not found');
  if (target.foreign_source) refuse('sso_managed');
  return { actor, target, previousRole: target.tenantRole };
}

// PUT /api/tenant/current/members/:userId  { role }
currentMembers.put('/:userId', validate(updateCurrentMemberSchema), async (req, res, next) => {
  try {
    const userId = requireDbId(req.params.userId, 'user id');
    const { actor, target, previousRole } = await requireManagedMember(req, userId);
    const role = await userScope.assertGrantableRole(actor, (req.body as z.infer<typeof updateCurrentMemberSchema>).role);
    await userScope.assertNotLastTenantAdmin(actor.tenantId, userId, role);

    if (role !== previousRole || (await tenantService.getMembership(actor.tenantId, userId))?.role !== role) {
      // Guard and write in one transaction, under the tenant lock: two
      // admins demoting each other cannot leave the tenant without one.
      const updated = await db.transaction(async (trx) => {
        await guardLastTenantAdmin(trx, actor.tenantId, userId, role);
        if (!(await permissionSetService.lockAssignableTenantRole(trx, role))) {
          throw new AppError(400, 'Unknown tenant role');
        }
        return Number(await trx('user_tenants')
          .where({ tenant_id: actor.tenantId, user_id: userId })
          .update({ role })) || 0;
      });
      if (updated === 0) throw new AppError(404, 'Membership not found');
      membershipChanged(userId);
    }
    if (role !== previousRole) {
      await auditService.logReq(req, {
        action: 'tenant.member_role_changed',
        resourceType: 'user',
        resourceId: userId,
        details: { username: target.username, from: previousRole, to: role },
      });
    }
    res.json({ success: true });
  } catch (err) {
    sendScopeError(err, res, next);
  }
});

// DELETE /api/tenant/current/members/:userId — the membership only (the
// account is kept). The member's sessions end (their open clients may be
// working in this tenant).
currentMembers.delete('/:userId', async (req, res, next) => {
  try {
    const userId = requireDbId(req.params.userId, 'user id');
    const { actor, target, previousRole } = await requireManagedMember(req, userId);
    await userScope.assertNotLastTenantAdmin(actor.tenantId, userId, null);

    // Guard and delete in one transaction, under the tenant lock.
    const removed = await db.transaction(async (trx) => {
      await guardLastTenantAdmin(trx, actor.tenantId, userId, null);
      return Number(await trx('user_tenants').where({ tenant_id: actor.tenantId, user_id: userId }).delete()) || 0;
    });
    if (removed === 0) throw new AppError(404, 'Membership not found');
    membershipChanged(userId);
    if (target.role !== 'admin') {
      leaveTenantRooms(req.app.get('io') as SocketIOServer | undefined, actor.tenantId, userId);
      await killSessionsForUser(userId, 'tenant_access_removed');
    }
    await auditService.logReq(req, {
      action: 'tenant.member_removed',
      resourceType: 'user',
      resourceId: userId,
      details: { username: target.username, role: previousRole },
    });
    res.json({ success: true });
  } catch (err) {
    sendScopeError(err, res, next);
  }
});

router.use('/current/members', currentMembers);

// ── Action restrictions of the current tenant ──────────
// GET / PUT /api/tenant/restrictions — tenant admins and platform admins
// only. Each action of restriction.service ACTION_KEYS is 'none' (default)
// or 'sensitive' (a fresh 2FA step-up, middleware/stepUp.ts). PUT replaces
// the whole map: keys left out become 'none'; keys this server does not know
// (a newer client) are dropped instead of failing the save. Relaxing an
// action (sensitive → none) needs a fresh step-up from a caller who has a
// factor (a stolen admin session must not switch the protection off in one
// request); a caller without any factor (e.g. an SSO-only admin) can still
// relax it. Registered before the /:id routes.
const restrictionsBodySchema = z.object({
  restrictions: z.object(
    Object.fromEntries(ACTION_KEYS.map((key) => [key, z.enum(['none', 'sensitive']).optional()])) as
      Record<ActionKey, z.ZodOptional<z.ZodEnum<['none', 'sensitive']>>>,
  ).strip(),
}).strict();

async function requireTenantFullAccess(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!(await permissionService.isFullAccess(req.session.userId!, req.tenantId, isPlatformAdmin(req)))) {
      throw new AppError(403, 'Tenant admin only');
    }
    next();
  } catch (err) {
    next(err);
  }
}

const restrictions = Router();
restrictions.use(requireTenant);
restrictions.use(requireTenantFullAccess);

restrictions.get('/', async (req, res, next) => {
  try {
    const map = await restrictionService.getRestrictions(req.tenantId);
    res.json({
      success: true,
      data: { actions: ACTION_KEYS.map((key) => ({ key, level: map[key] })) },
    });
  } catch (err) {
    next(err);
  }
});

restrictions.put('/', validate(restrictionsBodySchema), async (req, res, next) => {
  try {
    const { restrictions: levels } = req.body as z.infer<typeof restrictionsBodySchema>;
    const userId = req.session.userId!;
    const current = await restrictionService.getRestrictions(req.tenantId);
    const loosens = ACTION_KEYS.some((key) => current[key] === 'sensitive' && levels[key] !== 'sensitive');
    if (loosens && !hasFreshStepUp(req, userId)) {
      const factors = await loadStepUpFactors(userId);
      if (factors.methods.length > 0) {
        res.status(403).json(stepUpRefusal('tenant.restrictions_loosen', factors));
        return;
      }
    }
    const result = await restrictionService.setRestrictions(req.tenantId, levels);
    if (!result) throw new AppError(404, 'Tenant not found');
    const changes = diffRestrictions(result.before, result.after);
    if (Object.keys(changes).length > 0) {
      await auditService.logReq(req, {
        action: 'tenant.restrictions_updated',
        resourceType: 'tenant',
        resourceId: req.tenantId,
        details: { changes },
      });
    }
    res.json({
      success: true,
      data: { actions: ACTION_KEYS.map((key) => ({ key, level: result.after[key] })) },
    });
  } catch (err) {
    next(err);
  }
});

router.use('/restrictions', restrictions);

// ── Tenant switch ──────────────────────────────────────────────────────────
// POST /api/tenant/switch  { tenantId: number }
router.post('/switch', validate(switchTenantSchema), async (req, res, next) => {
  try {
    const { tenantId } = req.body as z.infer<typeof switchTenantSchema>;
    const userId = req.session.userId!;

    // Platform admins can switch to any existing tenant; others only to their own
    const hasAccess = await userHasTenantAccess(userId, tenantId, isPlatformAdmin(req));
    if (!hasAccess) throw new AppError(403, 'Access denied to this tenant');

    const fromTenantId = toDbId(req.session.currentTenantId);
    req.session.currentTenantId = tenantId;
    if (fromTenantId !== tenantId) {
      await auditService.logReq(req, {
        tenantId,
        action: 'tenant.switched',
        resourceType: 'tenant',
        resourceId: tenantId,
        details: { fromTenantId },
      });
    }
    res.json({ success: true, data: { currentTenantId: tenantId } });
  } catch (err) {
    next(err);
  }
});

// ── List tenants ───────────────────────────────────────────────────────────
// GET /api/tenants  (admin: all, user: their tenants with role)
router.get('/', async (req, res, next) => {
  try {
    const userId = req.session.userId!;

    if (isPlatformAdmin(req)) {
      const tenants = await tenantService.getAll();
      // Platform admins get all tenants with role='admin' so the switcher works
      res.json({ success: true, data: tenants.map(t => ({ ...t, role: 'admin' })) });
    } else {
      const tenants = await tenantService.getTenantsForUser(userId);
      res.json({ success: true, data: tenants });
    }
  } catch (err) {
    next(err);
  }
});

// ── Create tenant (platform admin only) ───────────────────────────────────
router.post('/', validate(createTenantSchema), async (req, res, next) => {
  try {
    requirePlatformAdmin(req);
    const { name, slug } = req.body as z.infer<typeof createTenantSchema>;
    let tenant;
    try {
      tenant = await tenantService.create({ name, slug });
    } catch (err) {
      if (isSlugConflict(err)) throw new AppError(409, 'A tenant with this slug already exists');
      throw err;
    }
    await auditService.logReq(req, {
      tenantId: null,
      action: 'tenant.created',
      resourceType: 'tenant',
      resourceId: tenant.id,
      details: { name: tenant.name, slug: tenant.slug },
    });
    res.status(201).json({ success: true, data: tenant });
  } catch (err) {
    next(err);
  }
});

// ── Get one tenant ─────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const id = requireDbId(req.params.id);

    // Non-admins can only see their own tenants
    if (!isPlatformAdmin(req)) {
      const hasAccess = await userHasTenantAccess(req.session.userId!, id, false);
      if (!hasAccess) throw new AppError(403, 'Access denied');
    }

    const tenant = await tenantService.getById(id);
    if (!tenant) throw new AppError(404, 'Tenant not found');
    res.json({ success: true, data: tenant });
  } catch (err) {
    next(err);
  }
});

// ── Update tenant (platform admin only) ───────────────────────────────────
router.put('/:id', validate(updateTenantSchema), async (req, res, next) => {
  try {
    requirePlatformAdmin(req);
    const id = requireDbId(req.params.id);
    const { name, slug } = req.body as z.infer<typeof updateTenantSchema>;
    const before = await tenantService.getById(id);
    if (!before) throw new AppError(404, 'Tenant not found');
    let tenant;
    try {
      tenant = await tenantService.update(id, { name, slug });
    } catch (err) {
      if (isSlugConflict(err)) throw new AppError(409, 'A tenant with this slug already exists');
      throw err;
    }
    if (!tenant) throw new AppError(404, 'Tenant not found');
    const changes: Record<string, { from: string; to: string }> = {};
    if (before.name !== tenant.name) changes.name = { from: before.name, to: tenant.name };
    if (before.slug !== tenant.slug) changes.slug = { from: before.slug, to: tenant.slug };
    if (Object.keys(changes).length > 0) {
      await auditService.logReq(req, {
        tenantId: null,
        action: 'tenant.updated',
        resourceType: 'tenant',
        resourceId: id,
        details: { changes },
      });
    }
    res.json({ success: true, data: tenant });
  } catch (err) {
    next(err);
  }
});

// ── Delete tenant (platform admin only, cannot delete tenant 1) ───────────
router.delete('/:id', async (req, res, next) => {
  try {
    requirePlatformAdmin(req);
    const id = requireDbId(req.params.id);
    if (id === 1) throw new AppError(400, 'Cannot delete the default tenant');
    const tenant = await tenantService.getById(id);
    if (!tenant) throw new AppError(404, 'Tenant not found');
    await tenantService.delete(id);

    // Sessions working in it answer 403 no_tenant_access from now on.
    invalidateTenantAccessCache();
    invalidateTenantCapabilityCache();
    leaveTenantRooms(req.app.get('io') as SocketIOServer | undefined, id, null);

    // Platform event (tenant_id null): the tenant's own audit rows go with it.
    await auditService.logReq(req, {
      tenantId: null,
      action: 'tenant.deleted',
      resourceType: 'tenant',
      resourceId: id,
      details: { name: tenant.name, slug: tenant.slug },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Tenant members ─────────────────────────────────────────────────────────
// GET /api/tenants/:id/members
router.get('/:id/members', async (req, res, next) => {
  try {
    requirePlatformAdmin(req);
    const tenantId = requireDbId(req.params.id);
    const members = await tenantService.getMembers(tenantId);
    // SSO accounts: Obligate resets their role and teams at each sign-in.
    const sources = await foreignSources(members.map((m) => Number((m as { id: number }).id)));
    res.json({
      success: true,
      data: members.map((m) => ({ ...m, foreignSource: sources.get(Number((m as { id: number }).id)) ?? null })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/tenants/:id/members  { userId, role }
// Platform admin checked before the role is looked up in the database.
router.post('/:id/members', requireRole('admin'), validateAsync(addMemberSchema), async (req, res, next) => {
  try {
    requirePlatformAdmin(req);
    const tenantId = requireDbId(req.params.id);
    const { userId, role: requestedRole } = req.body as z.infer<typeof addMemberSchema>;
    // New memberships are 'viewer' by default, never the legacy 'member'.
    const role = normaliseTenantRole(requestedRole ?? 'viewer');
    if (!(await tenantService.getById(tenantId))) throw new AppError(404, 'Tenant not found');
    const user = await getUserForMembership(userId);

    const previous = await tenantService.getMembership(tenantId, userId);
    await tenantService.addUser(tenantId, userId, role);
    invalidateTenantAccessCache(userId);
    invalidateTenantCapabilityCache(userId);
    if (!previous || previous.role !== role) emitPermissionsChanged([userId]);

    if (!previous) {
      await auditService.logReq(req, {
        tenantId,
        action: 'tenant.member_added',
        resourceType: 'user',
        resourceId: userId,
        details: { username: user.username, role },
      });
    } else if (previous.role !== role) {
      await auditService.logReq(req, {
        tenantId,
        action: 'tenant.member_role_changed',
        resourceType: 'user',
        resourceId: userId,
        details: { username: user.username, from: previous.role, to: role },
      });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/tenants/:id/members/:uid  { role }
router.put('/:id/members/:uid', requireRole('admin'), validateAsync(updateMemberSchema), async (req, res, next) => {
  try {
    requirePlatformAdmin(req);
    const tenantId = requireDbId(req.params.id);
    const userId = requireDbId(req.params.uid, 'user id');
    const role = normaliseTenantRole((req.body as z.infer<typeof updateMemberSchema>).role);

    const previous = await tenantService.getMembership(tenantId, userId);
    if (!previous) throw new AppError(404, 'Membership not found');
    await getUserForMembership(userId);
    await tenantService.updateUserRole(tenantId, userId, role);
    invalidateTenantAccessCache(userId);
    invalidateTenantCapabilityCache(userId);
    if (previous.role !== role) emitPermissionsChanged([userId]);

    if (previous.role !== role) {
      await auditService.logReq(req, {
        tenantId,
        action: 'tenant.member_role_changed',
        resourceType: 'user',
        resourceId: userId,
        details: { from: previous.role, to: role },
      });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tenants/:id/members/:uid
router.delete('/:id/members/:uid', async (req, res, next) => {
  try {
    requirePlatformAdmin(req);
    const tenantId = requireDbId(req.params.id);
    const userId = requireDbId(req.params.uid, 'user id');

    const previous = await tenantService.getMembership(tenantId, userId);
    const removed = await tenantService.removeUser(tenantId, userId);
    if (removed === 0) throw new AppError(404, 'Membership not found');
    invalidateTenantAccessCache(userId);
    invalidateTenantCapabilityCache(userId);
    emitPermissionsChanged([userId]);

    // The member's open sockets stop receiving this tenant's events at once
    // (platform admins keep access to every tenant: left alone).
    const target = await db('users').where({ id: userId }).first('role') as { role: string } | undefined;
    if (target && target.role !== 'admin') {
      leaveTenantRooms(req.app.get('io') as SocketIOServer | undefined, tenantId, userId);
    }

    await auditService.logReq(req, {
      tenantId,
      action: 'tenant.member_removed',
      resourceType: 'user',
      resourceId: userId,
      details: { role: previous?.role ?? null },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
