import type { Request, Response, NextFunction } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { db } from '../db';
import { userService } from '../services/user.service';
import { teamService } from '../services/team.service';
import { auditService } from '../services/audit.service';
import { killSessionsForUser } from '../services/userSessions.service';
import { leaveTenantRooms } from '../services/tenant.service';
import { invalidateSessionUserCache } from '../middleware/sessionUserGuard';
import { invalidateAccountPolicyCache } from '../middleware/accountPolicy';
import { invalidateTenantAccessCache } from '../utils/sessionTenant';
import { invalidateAccountableCache } from '../services/deviceChecks/config.service';
import { invalidateTenantCapabilityCache, permissionService } from '../services/permission.service';
import { emitPermissionsChanged } from '../services/realtime.service';
import { twoFactorService } from '../services/twoFactor.service';
import {
  actorFromReq,
  computeAccessTree,
  guardLastTenantAdmin,
  normaliseTenantRole,
  refuse,
  sendScopeError,
  userScope,
} from '../services/userScope.service';
import { TENANT_ADMIN_ROLE } from '../services/permissionSet.service';
import { requireDbId, toDbId } from '../utils/dbId';
import { assertPasswordNotUsername } from '../validators/password';
import { AppError } from '../middleware/errorHandler';
import type { ChangePasswordInput, SetUserTenantsInput } from '../validators/user.schema';
import type { CreateUserScopedInput, UpdateUserScopedInput } from '../routes/users.routes';

// Account administration (users.routes.ts, tenant capability users.manage).
//  - Platform admins: every account, every tenant (unchanged behaviour).
//  - Other users.manage holders (tenant admins, custom roles): the members of
//    the current tenant they dominate only (userScope). Account-wide
//    changes (edit, deactivate, delete, password, 2FA) also need a local
//    account that belongs to no other tenant; the platform role stays
//    platform-only. Refusals: 403 { error: 'forbidden', reason }.
// Every change that takes access away ends the user's sessions at once
// (killSessionsForUser: session rows deleted, live sockets disconnected) —
// requireAuth alone would let them run until they expire.

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof AppError) return false;
  const e = err as { code?: string; message?: string } | null;
  return e?.code === '23505' || (typeof e?.message === 'string' && e.message.includes('unique'));
}

/** 409 for a duplicate username / e-mail, the scope refusal shape, else the error handler. */
function fail(err: unknown, res: Response, next: NextFunction): void {
  if (isUniqueViolation(err)) {
    next(new AppError(409, 'Username or e-mail already exists'));
    return;
  }
  sendScopeError(err, res, next);
}

async function lastActivePlatformAdmin(id: number): Promise<boolean> {
  const allUsers = await userService.getAll();
  return allUsers.filter((u) => u.role === 'admin' && u.isActive && u.id !== id).length === 0;
}

export const usersController = {
  // GET /api/users
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = actorFromReq(req);
      const users = actor.isPlatformAdmin
        ? await userService.getAll()
        : await userService.getTenantUsers(actor.tenantId);
      res.json({ success: true, data: users });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/users/:id
  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id);
      const actor = actorFromReq(req);
      if (actor.isPlatformAdmin) {
        const user = await userService.getById(id);
        if (!user) throw new AppError(404, 'User not found');
        res.json({ success: true, data: user });
        return;
      }
      await userScope.assertReadableTarget(actor, id);
      const user = (await userService.getTenantUsers(actor.tenantId)).find((u) => u.id === id);
      if (!user) throw new AppError(404, 'User not found');
      res.json({ success: true, data: user });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/users
  // Platform admins: body tenantIds (absent → the current tenant, so no
  // account is left without a tenant). Other managers: the current tenant
  // only, platform role 'user'. tenantRole: the role of the new memberships
  // (default 'viewer'), one the caller dominates.
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = actorFromReq(req);
      const data = req.body as CreateUserScopedInput;
      assertPasswordNotUsername(data.password, data.username);

      let tenantIds: number[];
      if (actor.isPlatformAdmin) {
        tenantIds = data.tenantIds ?? [actor.tenantId];
      } else {
        if (data.role === 'admin') refuse('platform_role');
        if (data.tenantIds && data.tenantIds.some((t) => t !== actor.tenantId)) refuse('other_tenant');
        tenantIds = [actor.tenantId];
      }
      const tenantRole = await userScope.assertGrantableRole(actor, data.tenantRole ?? 'viewer');

      const user = await userService.create(
        {
          username: data.username,
          password: data.password,
          displayName: data.displayName,
          role: actor.isPlatformAdmin ? data.role : 'user',
          email: data.email ?? null,
        },
        tenantIds,
        tenantRole,
      );
      await auditService.logReq(req, {
        action: 'user.created',
        resourceType: 'user',
        resourceId: user.id,
        details: { username: user.username, role: user.role, tenantRole, tenantIds: [...new Set(tenantIds)] },
      });
      res.status(201).json({ success: true, data: user });
    } catch (err: unknown) {
      fail(err, res, next);
    }
  },

  // PUT / PATCH /api/users/:id
  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id);
      const actor = actorFromReq(req);
      const data = req.body as UpdateUserScopedInput;

      let changes: { displayName?: string | null; role?: 'admin' | 'user'; isActive?: boolean; email?: string | null };
      let guard: ((trx: Parameters<typeof guardLastTenantAdmin>[0]) => Promise<void>) | undefined;
      if (actor.isPlatformAdmin) {
        // Block modifications for SSO users
        const target = await userService.getById(id);
        if (!target) throw new AppError(404, 'User not found');
        if (target.foreignSource === 'obligate') {
          throw new AppError(400, 'Cannot modify SSO user — manage from Obligate');
        }
        // Prevent demoting the last admin
        if ((data.role === 'user' || data.isActive === false) && target.role === 'admin'
          && await lastActivePlatformAdmin(id)) {
          throw new AppError(400, 'Cannot remove the last active admin');
        }
        changes = { displayName: data.displayName, role: data.role, isActive: data.isActive, email: data.email };
      } else {
        const target = await userScope.assertManageableTarget(actor, id, { accountWide: true });
        if (data.role !== undefined && data.role !== target.role) refuse('platform_role');
        if (data.isActive === false) {
          await userScope.assertNotLastTenantAdmin(actor.tenantId, id, null);
          // Re-checked under the tenant lock in the writing transaction.
          guard = (trx) => guardLastTenantAdmin(trx, actor.tenantId, id, null);
        }
        changes = { displayName: data.displayName, isActive: data.isActive, email: data.email };
      }

      const targetUser = await userService.getById(id);
      if (!targetUser) throw new AppError(404, 'User not found');
      const user = await userService.update(id, changes, { guard });
      if (!user) throw new AppError(404, 'User not found');

      // The session guard caches is_active / role a few seconds: drop it so a
      // role change applies on the user's next request.
      invalidateSessionUserCache(id);
      // Device-check rules saved by this user are suspended when the account
      // is no longer an active admin: apply it at the next config build.
      if (targetUser.role !== user.role || targetUser.isActive !== user.isActive) {
        invalidateAccountableCache(id);
      }
      const demoted = targetUser.role === 'admin' && user.role !== 'admin';
      if (data.isActive === false || demoted) {
        await killSessionsForUser(id, data.isActive === false ? 'deactivated' : 'demoted');
      }

      const diff: Record<string, { from: unknown; to: unknown }> = {};
      if (targetUser.displayName !== user.displayName) diff.displayName = { from: targetUser.displayName, to: user.displayName };
      if (targetUser.role !== user.role) diff.role = { from: targetUser.role, to: user.role };
      if (targetUser.isActive !== user.isActive) diff.isActive = { from: targetUser.isActive, to: user.isActive };
      // The address itself is not written to the audit log.
      if ((targetUser.email ?? null) !== (user.email ?? null)) diff.email = { from: !!targetUser.email, to: !!user.email };
      if (Object.keys(diff).length > 0) {
        await auditService.logReq(req, {
          action: 'user.updated',
          resourceType: 'user',
          resourceId: id,
          details: { username: user.username, changes: diff },
        });
      }
      res.json({ success: true, data: user });
    } catch (err: unknown) {
      fail(err, res, next);
    }
  },

  // PUT /api/users/:id/password — password reset by an administrator.
  // The user must choose a new password at the next sign-in, and every
  // session of the account ends.
  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id);
      // One's own password changes through the profile (current password).
      if (id === req.session.userId) {
        throw new AppError(400, 'Use your profile to change your own password');
      }
      const actor = actorFromReq(req);
      if (!actor.isPlatformAdmin) await userScope.assertManageableTarget(actor, id, { accountWide: true });

      // Block password changes for SSO users
      const targetUser = await userService.getById(id);
      if (!targetUser) throw new AppError(404, 'User not found');
      if (targetUser.foreignSource === 'obligate') {
        throw new AppError(400, 'Cannot modify SSO user — manage from Obligate');
      }

      const data = req.body as ChangePasswordInput;
      assertPasswordNotUsername(data.password, targetUser.username);
      const success = await userService.changePassword(id, data.password, { mustChange: true });
      if (!success) throw new AppError(404, 'User not found');
      invalidateAccountPolicyCache(id);
      await killSessionsForUser(id, 'password_reset_by_admin');

      await auditService.logReq(req, {
        action: 'user.password_reset_by_admin',
        resourceType: 'user',
        resourceId: id,
        details: { username: targetUser.username },
      });
      res.json({ success: true, message: 'Password changed' });
    } catch (err) {
      sendScopeError(err, res, next);
    }
  },

  // DELETE /api/users/:id/2fa — an administrator removes every second factor
  // of a locked-out account. Platform admins: any local
  // account; other managers: a dominated member of the current tenant that is
  // neither a platform nor a tenant admin. SSO accounts: managed by Obligate.
  async resetTwoFactor(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id);
      // One's own factors are managed from the profile, with a proof.
      if (id === req.session.userId) {
        throw new AppError(400, 'Use your profile to manage your own two-factor authentication');
      }
      const actor = actorFromReq(req);
      if (!actor.isPlatformAdmin) {
        const target = await userScope.assertManageableTarget(actor, id, { accountWide: true });
        if (target.tenantRole === TENANT_ADMIN_ROLE) refuse('admin_target');
      }

      const targetUser = await userService.getById(id);
      if (!targetUser) throw new AppError(404, 'User not found');
      if (targetUser.foreignSource) {
        throw new AppError(400, 'Cannot modify SSO user — manage from Obligate');
      }

      if (!(await userService.resetSecondFactors(id))) throw new AppError(404, 'User not found');
      // The force-2FA policy applies again at the next request.
      invalidateAccountPolicyCache(id);
      invalidateSessionUserCache(id);
      await killSessionsForUser(id, '2fa_reset_by_admin');
      twoFactorService.notifyInBackground(targetUser.email, 'Two-factor authentication reset', [
        `An administrator removed the two-factor authentication of your account "${targetUser.username}".`,
        'Sign in again and set up two-factor authentication from your profile.',
      ]);

      await auditService.logReq(req, {
        action: 'user.2fa_reset_by_admin',
        resourceType: 'user',
        resourceId: id,
        details: { username: targetUser.username },
      });
      res.json({ success: true, message: 'Two-factor authentication reset' });
    } catch (err) {
      sendScopeError(err, res, next);
    }
  },

  // DELETE /api/users/:id
  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id);

      if (id === req.session.userId) {
        throw new AppError(400, 'Cannot delete your own account');
      }
      const actor = actorFromReq(req);
      if (!actor.isPlatformAdmin) {
        await userScope.assertManageableTarget(actor, id, { accountWide: true });
        await userScope.assertNotLastTenantAdmin(actor.tenantId, id, null);
      }

      // Block deletion for SSO users
      const user = await userService.getById(id);
      if (!user) throw new AppError(404, 'User not found');
      if (user.foreignSource === 'obligate') {
        throw new AppError(400, 'Cannot delete SSO user — manage from Obligate');
      }

      if (user.role === 'admin' && await lastActivePlatformAdmin(id)) {
        throw new AppError(400, 'Cannot delete the last admin');
      }

      // Last-tenant-admin re-check under the tenant lock, in the deleting transaction.
      const deleted = await userService.delete(id, actor.isPlatformAdmin ? {} : {
        guard: (trx) => guardLastTenantAdmin(trx, actor.tenantId, id, null),
      });
      if (!deleted) throw new AppError(404, 'User not found');
      invalidateSessionUserCache(id);
      invalidateTenantAccessCache(id);
      await killSessionsForUser(id, 'deleted');

      await auditService.logReq(req, {
        action: 'user.deleted',
        resourceType: 'user',
        resourceId: id,
        details: { username: user.username },
      });
      res.json({ success: true, message: 'User deleted' });
    } catch (err) {
      sendScopeError(err, res, next);
    }
  },

  // GET /api/users/:id/effective-access?tenantId=
  // Role, capabilities, teams and the resulting readable / writable groups
  // and sites of a user in a tenant. Platform admins: any user, any
  // tenant (default: the current one). Other managers: a member of the
  // current tenant they dominate (or themselves), current tenant only.
  async effectiveAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id);
      const actor = actorFromReq(req);
      let tenantId = actor.tenantId;
      if (req.query.tenantId !== undefined) {
        const requested = toDbId(req.query.tenantId);
        if (requested === null) throw new AppError(400, 'Invalid tenant id');
        if (!actor.isPlatformAdmin && requested !== actor.tenantId) throw new AppError(404, 'User not found');
        tenantId = requested;
      }
      if (!actor.isPlatformAdmin) {
        if (id === actor.userId) await userScope.assertReadableTarget(actor, id);
        else await userScope.assertManageableTarget(actor, id, { accountWide: false });
      }

      const [target, tenant, membership] = await Promise.all([
        db('users').where({ id }).first('id', 'username', 'role', 'is_active') as
          Promise<{ id: number; username: string; role: string; is_active: boolean } | undefined>,
        db('tenants').where({ id: tenantId }).first('id', 'name') as Promise<{ id: number; name: string } | undefined>,
        db('user_tenants').where({ user_id: id, tenant_id: tenantId }).first('role') as Promise<{ role: string } | undefined>,
      ]);
      if (!target) throw new AppError(404, 'User not found');
      if (!tenant) throw new AppError(404, 'Tenant not found');

      const isPlatformAdmin = target.role === 'admin';
      const fullAccess = target.is_active !== false
        && await permissionService.isFullAccess(id, tenantId, isPlatformAdmin);
      const perms = await permissionService.getUserPermissions(id, isPlatformAdmin, tenantId);

      const teams = await teamService.getUserTeams(id, tenantId);
      const teamRows = await Promise.all(teams.map(async (t) => ({
        id: t.id,
        name: t.name,
        canCreate: t.canCreate,
        permissions: (await teamService.getPermissions(t.id))
          .map((p) => ({ scope: p.scope, scopeId: p.scopeId, level: p.level })),
      })));

      // Team grants of the tenant (a platform admin's own teams included).
      const grants: Record<string, 'ro' | 'rw'> = {};
      for (const t of teamRows) {
        for (const p of t.permissions) {
          const key = `${p.scope}:${p.scopeId}`;
          if (grants[key] !== 'rw') grants[key] = p.level;
        }
      }
      const grantedGroupIds = Object.keys(grants)
        .filter((k) => k.startsWith('group:'))
        .map((k) => Number(k.slice(6)));
      const [groups, sites, closure] = await Promise.all([
        db('monitor_groups').where({ tenant_id: tenantId }).select('id', 'is_general') as
          Promise<Array<{ id: number; is_general: boolean }>>,
        db('sites').where({ tenant_id: tenantId }).select('id', 'group_id') as
          Promise<Array<{ id: number; group_id: number | null }>>,
        grantedGroupIds.length === 0 ? Promise.resolve([] as Array<{ ancestor_id: number; descendant_id: number }>)
          : db('group_closure').whereIn('ancestor_id', grantedGroupIds).select('ancestor_id', 'descendant_id') as
            Promise<Array<{ ancestor_id: number; descendant_id: number }>>,
      ]);
      const tree = computeAccessTree({
        fullAccess,
        groups: groups.map((g) => ({ id: Number(g.id), isGeneral: !!g.is_general })),
        sites: sites.map((s) => ({ id: Number(s.id), groupId: s.group_id != null ? Number(s.group_id) : null })),
        closure: closure.map((c) => ({ ancestorId: Number(c.ancestor_id), descendantId: Number(c.descendant_id) })),
        grants,
      });
      // The authoritative readable sites (the same resolver as every route).
      const visible = target.is_active === false ? [] : await permissionService.getVisibleSiteIds(id, tenantId, isPlatformAdmin);
      const readableSites = visible === 'all' ? sites.map((s) => Number(s.id)).sort((a, b) => a - b) : [...visible].sort((a, b) => a - b);

      res.json({
        success: true,
        data: {
          userId: id,
          username: target.username,
          tenantId,
          tenantName: tenant.name,
          isActive: target.is_active !== false,
          isPlatformAdmin,
          role: membership ? normaliseTenantRole(membership.role) : null,
          fullAccess,
          canCreate: perms.canCreate,
          capabilities: target.is_active === false ? [] : perms.capabilities,
          teams: teamRows,
          readable: { groups: target.is_active === false ? [] : tree.readable.groups, sites: readableSites },
          writable: target.is_active === false ? { groups: [], sites: [] } : tree.writable,
        },
      });
    } catch (err) {
      sendScopeError(err, res, next);
    }
  },

  // GET /api/users/:id/teams
  async getTeams(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id);
      const actor = actorFromReq(req);
      if (actor.isPlatformAdmin) {
        res.json({ success: true, data: await teamService.getUserTeams(id) });
        return;
      }
      await userScope.assertReadableTarget(actor, id);
      res.json({ success: true, data: await teamService.getUserTeams(id, actor.tenantId) });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/users/:id/tenants
  // Managers that are not platform admins see only the current tenant's row:
  // other tenants are neither listed nor named.
  async getTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id);
      const actor = actorFromReq(req);
      await userScope.assertReadableTarget(actor, id);
      let assignments = await userService.getUserTenantAssignments(id);
      if (!actor.isPlatformAdmin) assignments = assignments.filter((a) => Number(a.tenantId) === actor.tenantId);
      res.json({
        success: true,
        data: assignments.map((a) => ({ ...a, role: normaliseTenantRole(a.role) })),
      });
    } catch (err) {
      next(err);
    }
  },

  // PUT /api/users/:id/tenants
  // Body: { assignments: [{ tenantId: number, role: 'admin' | <permission set slug> }] }
  // ('member' is stored as 'viewer'). Managers that are not platform admins
  // may only change the current tenant's row (userScope.resolveTenantAssignments).
  async setTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id);
      const actor = actorFromReq(req);
      const targetUser = await userService.getById(id);
      if (!targetUser) throw new AppError(404, 'User not found');
      if (targetUser.foreignSource === 'obligate') {
        throw new AppError(400, 'Cannot modify SSO user tenant access — manage from Obligate');
      }
      const { assignments: requested } = req.body as SetUserTenantsInput;
      const assignments = await userScope.resolveTenantAssignments(actor, id, requested);
      // Managers that are not platform admins only change the current
      // tenant's row: its last-tenant-admin check is re-run under the tenant
      // lock in the writing transaction.
      const nextHere = assignments.find((a) => a.tenantId === actor.tenantId);
      const before = await userService.setUserTenantAssignments(id, assignments, actor.isPlatformAdmin ? {} : {
        guard: (trx) => guardLastTenantAdmin(trx, actor.tenantId, id, nextHere ? nextHere.role : null),
      });

      // Removals apply at once: cached access answers dropped, and the user's
      // open sockets leave the tenants they no longer belong to (platform
      // admins keep access to every tenant).
      invalidateTenantAccessCache(id);
      // Tenant roles changed: capabilities and device-check accountability
      // (deviceChecks.manage) are re-resolved on the next request / build.
      invalidateTenantCapabilityCache(id);
      invalidateAccountableCache(id);
      // The user's open client re-reads its permissions and tree.
      emitPermissionsChanged([id]);
      const after = new Map(assignments.map((a) => [a.tenantId, a.role] as const));
      const removed = before.filter((b) => !after.has(b.tenantId)).map((b) => b.tenantId);
      if (targetUser.role !== 'admin') {
        const io = req.app.get('io') as SocketIOServer | undefined;
        for (const tenantId of removed) leaveTenantRooms(io, tenantId, id);
        // As DELETE /tenant/current/members: a removed membership ends the
        // user's sessions (their open clients may be working in that tenant).
        if (removed.length > 0) await killSessionsForUser(id, 'tenant_access_removed');
      }

      const beforeRoles = new Map(before.map((b) => [b.tenantId, b.role] as const));
      const added = [...after.keys()].filter((tid) => !beforeRoles.has(tid));
      const roleChanged = [...after.entries()]
        .filter(([tid, role]) => beforeRoles.has(tid) && beforeRoles.get(tid) !== role)
        .map(([tid, role]) => ({ tenantId: tid, from: beforeRoles.get(tid), to: role }));
      if (added.length > 0 || removed.length > 0 || roleChanged.length > 0) {
        await auditService.logReq(req, {
          action: 'user.tenants_changed',
          resourceType: 'user',
          resourceId: id,
          details: { username: targetUser.username, added, removed, roleChanged },
        });
      }
      res.json({ success: true, message: 'Tenant assignments updated' });
    } catch (err) {
      sendScopeError(err, res, next);
    }
  },
};
