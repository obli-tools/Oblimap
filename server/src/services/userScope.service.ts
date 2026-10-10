import type { Request, Response, NextFunction } from 'express';
import type { Knex } from 'knex';
import type { PermissionLevel } from '@oblimap/shared';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { permissionService } from './permission.service';
import {
  LEGACY_MEMBER_ROLE,
  LEGACY_MEMBER_SET,
  TENANT_ADMIN_ROLE,
  parseCapabilities,
  permissionSetService,
} from './permissionSet.service';

// ── Scope of `users.manage` (port of Obliance userScope.service) ───
//
// Platform admins (users.role = 'admin') manage every account and every
// membership, as before. A member holding the tenant capability users.manage
// (tenant admins hold it) manages the users of the CURRENT tenant only, and
// only the ones it dominates:
//   - never a platform admin, never themselves;
//   - the target is a member of the current tenant (404 otherwise, like a
//     missing user: nothing about other tenants leaks);
//   - dominance: a tenant admin (role 'admin') dominates every member of the
//     tenant; anyone else dominates a member whose role's capabilities are a
//     subset of their own (and never a tenant admin). Taking over an account
//     must never widen the caller's rights;
//   - a role is grantable on the same terms ('admin' by a tenant admin only);
//   - account-wide actions (edit, deactivate, delete, password, 2FA reset)
//     also need a local account (no foreign_source: Obligate owns SSO
//     accounts) that belongs to no other tenant and, for a caller that is not
//     a tenant admin, whose team access (WHERE) is covered by the caller's
//     own: every group / site grant at most the caller's level there, and
//     can_create only when the caller holds it (accessCovered). Whoever can
//     set the password of an account can sign in as it.
// The legacy tenant role 'member' is read as 'viewer'.
//
// Refusals are 403 { error: 'forbidden', reason, message } (ScopeRefusal,
// sent by sendScopeError).

export type ScopeActor = { userId: number; isPlatformAdmin: boolean; tenantId: number };

export type ManagedTarget = {
  id: number;
  username: string;
  role: string;
  is_active: boolean;
  foreign_source: string | null;
  /** Role in the current tenant (normalised), null for a platform admin actor's non-member target. */
  tenantRole: string | null;
};

export type TenantAssignment = { tenantId: number; role: string };

/** Capabilities of a tenant role: every one ('admin'), a set, or null (unknown slug: none). */
export type RoleCaps = { all: true } | { all: false; set: ReadonlySet<string> };

export type ScopeRefusalReason =
  | 'platform_admin'
  | 'self'
  | 'sso_managed'
  | 'other_tenant'
  | 'not_dominated'
  | 'admin_role_requires_tenant_admin'
  | 'role_not_grantable'
  | 'last_tenant_admin'
  | 'platform_role'
  | 'admin_target';

export class ScopeRefusal extends AppError {
  constructor(public reason: string, message: string) {
    super(403, message);
    this.name = 'ScopeRefusal';
  }
}

/**
 * Error handler of the scoped routes: a ScopeRefusal answers
 * 403 { success: false, error: 'forbidden', reason, message }; anything else
 * goes to the regular error handler.
 */
export function sendScopeError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof ScopeRefusal) {
    res.status(403).json({ success: false, error: 'forbidden', reason: err.reason, message: err.message });
    return;
  }
  next(err);
}

export function actorFromReq(req: Request): ScopeActor {
  return {
    userId: Number(req.session.userId),
    isPlatformAdmin: req.session.role === 'admin',
    tenantId: Number(req.tenantId),
  };
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** Legacy / empty tenant role → 'viewer' (the set 'member' has always been read as). */
export function normaliseTenantRole(role: unknown): string {
  const r = String(role ?? '').trim();
  return r === '' || r === LEGACY_MEMBER_ROLE ? LEGACY_MEMBER_SET : r;
}

/**
 * Does a caller with role `callerRole` / capabilities `callerCaps` in a
 * tenant dominate a member whose role there is `targetRole` / `targetCaps`?
 *  - a tenant admin dominates everyone;
 *  - a tenant admin target is dominated by a tenant admin only;
 *  - otherwise every capability of the target's role must be held by the
 *    caller (an unknown role grants nothing: dominated).
 */
export function dominates(
  callerRole: string | null,
  callerCaps: RoleCaps | null,
  targetRole: string,
  targetCaps: RoleCaps | null,
): boolean {
  if (callerRole === TENANT_ADMIN_ROLE || callerCaps?.all) return true;
  if (normaliseTenantRole(targetRole) === TENANT_ADMIN_ROLE || targetCaps?.all) return false;
  if (!callerCaps) return !targetCaps || targetCaps.set.size === 0;
  for (const cap of targetCaps?.set ?? []) {
    if (!callerCaps.set.has(cap)) return false;
  }
  return true;
}

/**
 * Why `nextRole` may not be granted by the caller (null = grantable). The
 * role must exist (`nextCaps` non-null, 'admin' always exists) and be
 * dominated by the caller; 'admin' needs a tenant admin caller.
 */
export function roleGrantRefusal(
  callerRole: string | null,
  callerCaps: RoleCaps | null,
  nextRole: string,
  nextCaps: RoleCaps | null,
): ScopeRefusalReason | 'unknown_role' | null {
  const role = normaliseTenantRole(nextRole);
  if (role === TENANT_ADMIN_ROLE) {
    return callerRole === TENANT_ADMIN_ROLE ? null : 'admin_role_requires_tenant_admin';
  }
  if (!nextCaps) return 'unknown_role';
  return dominates(callerRole, callerCaps, role, nextCaps) ? null : 'role_not_grantable';
}

/**
 * True when the change (role `nextRole`, or null = membership removed /
 * account deactivated or deleted) would leave the tenant without an active
 * tenant admin. `admins`: the tenant's current tenant admins.
 */
export function wouldRemoveLastTenantAdmin(
  admins: ReadonlyArray<{ userId: number; isActive: boolean }>,
  targetUserId: number,
  nextRole: string | null,
): boolean {
  const target = admins.find((a) => a.userId === targetUserId);
  if (!target) return false; // not a tenant admin: nothing to lose
  if (nextRole !== null && normaliseTenantRole(nextRole) === TENANT_ADMIN_ROLE) return false;
  return !admins.some((a) => a.userId !== targetUserId && a.isActive);
}

function levelRank(level: PermissionLevel | null | undefined): number {
  return level === 'rw' ? 2 : level === 'ro' ? 1 : 0;
}

/** True when `actorLevel` covers `granted` (rw ≥ ro ≥ nothing). */
export function levelCovers(actorLevel: PermissionLevel | null | undefined, granted: PermissionLevel): boolean {
  return levelRank(actorLevel) >= levelRank(granted);
}

/** A team-style grant on a group or a site. */
export interface ScopedGrant {
  scope: 'group' | 'site';
  scopeId: number;
  level: PermissionLevel;
}

/** 'group:<id>' / 'site:<id>' → level, as UserPermissions.permissions, into grants (other keys ignored). */
export function grantsFromPermissionMap(map: Readonly<Record<string, PermissionLevel>>): ScopedGrant[] {
  const out: ScopedGrant[] = [];
  for (const [key, level] of Object.entries(map)) {
    const m = /^(group|site):(\d+)$/.exec(key);
    if (!m || (level !== 'ro' && level !== 'rw')) continue;
    out.push({ scope: m[1] as 'group' | 'site', scopeId: Number(m[2]), level });
  }
  return out;
}

/** The grants the actor's own levels (`grantKey` → level) do not cover. */
export function uncoveredGrants(
  grants: readonly ScopedGrant[],
  actorLevels: ReadonlyMap<string, PermissionLevel>,
): ScopedGrant[] {
  return grants.filter((g) => !levelCovers(actorLevels.get(`${g.scope}:${g.scopeId}`), g.level));
}

/**
 * True when the actor's own team access covers a set of grants and a
 * can_create right: every grant at most the actor's level on that target,
 * and can_create only when the actor holds canCreateRootGroup. Used for an
 * account takeover (password, 2FA, e-mail…) and for adding members to a team.
 */
export function accessCovered(input: {
  grants: readonly ScopedGrant[];
  actorLevels: ReadonlyMap<string, PermissionLevel>;
  canCreate: boolean;
  actorCanCreate: boolean;
}): boolean {
  if (input.canCreate && !input.actorCanCreate) return false;
  return uncoveredGrants(input.grants, input.actorLevels).length === 0;
}

/**
 * Account-level refusal for a manager that is not a platform admin
 * (null = allowed). Pure: the caller resolved every fact.
 */
export function accountRefusal(facts: {
  actorId: number;
  targetId: number;
  targetIsPlatformAdmin: boolean;
  targetForeignSource: string | null;
  targetOtherTenantCount: number;
  dominated: boolean;
  accountWide: boolean;
}): ScopeRefusalReason | null {
  if (facts.targetIsPlatformAdmin) return 'platform_admin';
  if (facts.targetId === facts.actorId) return 'self';
  if (facts.accountWide) {
    if (facts.targetForeignSource) return 'sso_managed';
    if (facts.targetOtherTenantCount > 0) return 'other_tenant';
  }
  if (!facts.dominated) return 'not_dominated';
  return null;
}

const REFUSAL_MESSAGES: Record<ScopeRefusalReason, string> = {
  platform_admin: 'Only a platform administrator can manage a platform administrator account',
  self: 'You cannot manage your own account or role here',
  sso_managed: 'This account is managed in Obligate (SSO)',
  other_tenant: 'This account also belongs to another workspace: only a platform administrator can change it',
  not_dominated: 'This user has permissions you do not hold',
  admin_role_requires_tenant_admin: 'Only a workspace administrator can grant the administrator role',
  role_not_grantable: 'You can only grant a role whose permissions you hold',
  last_tenant_admin: 'The workspace must keep at least one active administrator',
  platform_role: 'Only a platform administrator can change the platform role',
  admin_target: 'Only a platform administrator can do this for a workspace administrator',
};

export function refuse(reason: ScopeRefusalReason): never {
  throw new ScopeRefusal(reason, REFUSAL_MESSAGES[reason]);
}

/** Readable / writable groups and sites of a member (GET /users/:id/effective-access). */
export interface AccessTree {
  readable: { groups: number[]; sites: number[] };
  writable: { groups: number[]; sites: number[] };
}

/**
 * The groups and sites a member reads / writes from their team grants, as
 * permissionService resolves them: a 'group' grant covers the group
 * and its descendants (closure) and their sites; a 'site' grant one site; a
 * general group is readable by every member but gives no access to its
 * sites. Full access: everything. Pure: the caller loads the tenant's groups,
 * sites, closure rows of the granted groups and the grants.
 */
export function computeAccessTree(input: {
  fullAccess: boolean;
  groups: ReadonlyArray<{ id: number; isGeneral: boolean }>;
  sites: ReadonlyArray<{ id: number; groupId: number | null }>;
  /** group_closure rows (ancestor = a granted group, depth 0 included). */
  closure: ReadonlyArray<{ ancestorId: number; descendantId: number }>;
  /** 'group:<id>' / 'site:<id>' → level (UserPermissions.permissions). */
  grants: Readonly<Record<string, 'ro' | 'rw'>>;
}): AccessTree {
  const sortIds = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b);
  if (input.fullAccess) {
    const g = sortIds(input.groups.map((x) => x.id));
    const st = sortIds(input.sites.map((x) => x.id));
    return { readable: { groups: g, sites: st }, writable: { groups: g, sites: st } };
  }
  const tenantGroups = new Set(input.groups.map((g) => g.id));
  const rank = (l: 'ro' | 'rw' | undefined) => (l === 'rw' ? 2 : l === 'ro' ? 1 : 0);
  const teamGroupLevel = new Map<number, 'ro' | 'rw'>();
  for (const c of input.closure) {
    if (!tenantGroups.has(c.ancestorId) || !tenantGroups.has(c.descendantId)) continue;
    const level = input.grants['group:' + c.ancestorId];
    if (!level) continue;
    if (rank(level) > rank(teamGroupLevel.get(c.descendantId))) teamGroupLevel.set(c.descendantId, level);
  }
  const readableGroups: number[] = [];
  const writableGroups: number[] = [];
  for (const g of input.groups) {
    const level = teamGroupLevel.get(g.id) ?? (g.isGeneral ? 'ro' : undefined);
    if (level) readableGroups.push(g.id);
    if (level === 'rw') writableGroups.push(g.id);
  }
  const readableSites: number[] = [];
  const writableSites: number[] = [];
  for (const site of input.sites) {
    const direct = input.grants['site:' + site.id];
    const viaGroup = site.groupId !== null ? teamGroupLevel.get(site.groupId) : undefined;
    const level = rank(direct) >= rank(viaGroup) ? direct : viaGroup;
    if (level) readableSites.push(site.id);
    if (level === 'rw') writableSites.push(site.id);
  }
  return {
    readable: { groups: sortIds(readableGroups), sites: sortIds(readableSites) },
    writable: { groups: sortIds(writableGroups), sites: sortIds(writableSites) },
  };
}

// ── Database-backed helpers ─────────────────────────────────────────────────

/** Capabilities of a tenant role; null when the slug names no permission set. */
export async function capsOfRole(role: string): Promise<RoleCaps | null> {
  const r = normaliseTenantRole(role);
  if (r === TENANT_ADMIN_ROLE) return { all: true };
  const set = await permissionSetService.getBySlug(r);
  if (!set) return null;
  return { all: false, set: new Set(parseCapabilities(set.capabilities)) };
}

async function membershipRole(userId: number, tenantId: number): Promise<string | null> {
  const row = await db('user_tenants').where({ user_id: userId, tenant_id: tenantId }).first('role') as
    { role: string } | undefined;
  return row ? normaliseTenantRole(row.role) : null;
}

/** The actor's role and effective capabilities in its current tenant. */
async function actorRoleCaps(actor: ScopeActor): Promise<{ role: string | null; caps: RoleCaps }> {
  const role = await membershipRole(actor.userId, actor.tenantId);
  if (role === TENANT_ADMIN_ROLE) return { role, caps: { all: true } };
  // Resolved like every capability gate (inactive account → nothing).
  const held = await permissionService.listUserTenantCapabilities(actor.userId, actor.tenantId);
  return { role, caps: { all: false, set: new Set(held) } };
}

/** The tenant's tenant admins, with their account state (last-admin guard). */
export async function tenantAdmins(tenantId: number, conn: Knex = db): Promise<Array<{ userId: number; isActive: boolean }>> {
  const rows = await conn('user_tenants')
    .join('users', 'users.id', 'user_tenants.user_id')
    .where({ 'user_tenants.tenant_id': tenantId, 'user_tenants.role': TENANT_ADMIN_ROLE })
    .select('users.id', 'users.is_active') as Array<{ id: number; is_active: boolean }>;
  return rows.map((r) => ({ userId: Number(r.id), isActive: r.is_active !== false }));
}

/** First key of the per-tenant advisory lock serialising tenant-admin removals ('OBLM'). */
const TENANT_ADMIN_LOCK_KEY = 0x4f424c4d;

/**
 * Last-tenant-admin guard INSIDE the transaction that writes the change
 * (role change, membership removal, deactivation, deletion). A per-tenant
 * transaction advisory lock serialises these writes, and the admins are read
 * after it is held (a fresh READ COMMITTED snapshot): two admins demoting or
 * removing each other at the same moment cannot both pass. Throws
 * ScopeRefusal('last_tenant_admin').
 */
export async function guardLastTenantAdmin(
  trx: Knex.Transaction,
  tenantId: number,
  targetId: number,
  nextRole: string | null,
): Promise<void> {
  await trx.raw('SELECT pg_advisory_xact_lock(?::int, ?::int)', [TENANT_ADMIN_LOCK_KEY, tenantId]);
  if (wouldRemoveLastTenantAdmin(await tenantAdmins(tenantId, trx), targetId, nextRole)) refuse('last_tenant_admin');
}

/**
 * The actor's own TEAM-derived level on each group / site of its tenant
 * (`grantKey` → level, missing = none). A group's level comes from team
 * grants on it or an ancestor only: the 'ro' every member gets on a general
 * group just shows the group row and gives no access to its sites, whereas a
 * team grant on it does — so it never counts as held here.
 */
export async function actorTeamLevels(
  actor: ScopeActor,
  targets: ReadonlyArray<{ scope: 'group' | 'site'; scopeId: number }>,
): Promise<Map<string, PermissionLevel>> {
  const levels = new Map<string, PermissionLevel>();
  const seen = new Set<string>();
  for (const t of targets) {
    const key = `${t.scope}:${t.scopeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let level: PermissionLevel | null;
    if (t.scope === 'group') {
      level = (await permissionService.findGroup(t.scopeId, actor.tenantId))
        ? await permissionService._getGroupPermissionViaClosure(actor.userId, t.scopeId, actor.tenantId)
        : null;
    } else {
      level = await permissionService.getSitePermission(actor.userId, t.scopeId, actor.tenantId, false);
    }
    if (level) levels.set(key, level);
  }
  return levels;
}

/** True when the actor's team access covers the target's in the tenant (accessCovered). */
async function targetAccessCovered(actor: ScopeActor, targetId: number): Promise<boolean> {
  const targetPerms = await permissionService.getUserPermissions(targetId, false, actor.tenantId);
  const grants = grantsFromPermissionMap(targetPerms.permissions ?? {});
  const [actorLevels, canCreate, actorCanCreate] = await Promise.all([
    actorTeamLevels(actor, grants),
    permissionService.canCreateRootGroup(targetId, actor.tenantId, false),
    permissionService.canCreateRootGroup(actor.userId, actor.tenantId, false),
  ]);
  return accessCovered({ grants, actorLevels, canCreate, actorCanCreate });
}

export const userScope = {
  /**
   * Write access to an account or to its membership of the current tenant.
   * `accountWide`: the action changes the account itself (edit, deactivate,
   * delete, password, 2FA), so SSO accounts and accounts of other tenants
   * are refused too. Platform admins pass (404 for a missing user only).
   */
  async assertManageableTarget(
    actor: ScopeActor,
    targetId: number,
    opts: { accountWide: boolean },
  ): Promise<ManagedTarget> {
    if (!Number.isSafeInteger(targetId) || targetId <= 0) throw new AppError(400, 'Invalid user id');
    const user = await db('users').where({ id: targetId })
      .first('id', 'username', 'role', 'is_active', 'foreign_source') as
      Omit<ManagedTarget, 'tenantRole'> | undefined;
    if (!user) throw new AppError(404, 'User not found');
    const tenantRole = await membershipRole(targetId, actor.tenantId);
    const target: ManagedTarget = { ...user, foreign_source: user.foreign_source ?? null, tenantRole };
    if (actor.isPlatformAdmin) return target;

    // Outside the current tenant: the same 404 as a missing account.
    if (tenantRole === null) throw new AppError(404, 'User not found');

    const otherTenants = await db('user_tenants')
      .where({ user_id: targetId })
      .whereNot({ tenant_id: actor.tenantId })
      .count<{ count: string | number }[]>('tenant_id as count');
    const caller = await actorRoleCaps(actor);
    const reason = accountRefusal({
      actorId: actor.userId,
      targetId,
      targetIsPlatformAdmin: user.role === 'admin',
      targetForeignSource: target.foreign_source,
      targetOtherTenantCount: Number(otherTenants[0]?.count ?? 0),
      dominated: dominates(caller.role, caller.caps, tenantRole, await capsOfRole(tenantRole)),
      accountWide: opts.accountWide,
    });
    if (reason) refuse(reason);
    // Taking over the account (password, 2FA, e-mail…) must not widen the
    // caller's WHERE access: its team grants must be covered as well.
    if (opts.accountWide && caller.role !== TENANT_ADMIN_ROLE && !caller.caps.all
      && !(await targetAccessCovered(actor, targetId))) {
      refuse('not_dominated');
    }
    return target;
  },

  /**
   * Read access (GET /users/:id, /:id/teams, /:id/tenants, effective
   * access): platform admins read anyone, other managers the members of the
   * current tenant only (404 outside).
   */
  async assertReadableTarget(actor: ScopeActor, targetId: number): Promise<void> {
    if (!Number.isSafeInteger(targetId) || targetId <= 0) throw new AppError(400, 'Invalid user id');
    if (actor.isPlatformAdmin) return;
    const member = await db('user_tenants').where({ user_id: targetId, tenant_id: actor.tenantId }).first('user_id');
    if (!member) throw new AppError(404, 'User not found');
  },

  /**
   * Throws unless the actor may give `role` in its current tenant (platform
   * admins: any assignable role). Returns the normalised role.
   */
  async assertGrantableRole(actor: ScopeActor, role: string): Promise<string> {
    const next = normaliseTenantRole(role);
    const nextCaps = await capsOfRole(next);
    if (actor.isPlatformAdmin) {
      if (!nextCaps) throw new AppError(400, `Unknown role: ${next}`);
      return next;
    }
    const caller = await actorRoleCaps(actor);
    const refusal = roleGrantRefusal(caller.role, caller.caps, next, nextCaps);
    if (refusal === 'unknown_role') throw new AppError(400, `Unknown role: ${next}`);
    if (refusal) refuse(refusal);
    return next;
  },

  /** Throws when the change would leave the current tenant without an active admin. */
  async assertNotLastTenantAdmin(tenantId: number, targetId: number, nextRole: string | null): Promise<void> {
    if (wouldRemoveLastTenantAdmin(await tenantAdmins(tenantId), targetId, nextRole)) refuse('last_tenant_admin');
  },

  /**
   * Resolves PUT /users/:id/tenants into the full list of memberships to
   * store. Platform admin: the list as sent ('member' read as 'viewer').
   * Other managers: only the CURRENT tenant's row may change (add, change or
   * remove it); every other membership is kept as it is — absent from the
   * list or repeated unchanged, never altered.
   */
  async resolveTenantAssignments(
    actor: ScopeActor,
    targetId: number,
    assignments: ReadonlyArray<{ tenantId: number; role: string }>,
  ): Promise<TenantAssignment[]> {
    const wanted: TenantAssignment[] = [];
    const seen = new Set<number>();
    for (const a of assignments) {
      if (seen.has(a.tenantId)) throw new AppError(400, 'Duplicate tenant in assignments');
      seen.add(a.tenantId);
      wanted.push({ tenantId: a.tenantId, role: normaliseTenantRole(a.role) });
    }
    if (actor.isPlatformAdmin) return wanted;

    if (targetId === actor.userId) refuse('self');
    // Membership-level: a member of the current tenant the actor dominates.
    const target = await this.assertManageableTarget(actor, targetId, { accountWide: false });
    if (target.foreign_source) refuse('sso_managed');

    const current = (await db('user_tenants').where({ user_id: targetId }).select('tenant_id', 'role') as
      Array<{ tenant_id: number; role: string }>)
      .map((r) => ({ tenantId: Number(r.tenant_id), role: normaliseTenantRole(r.role) }));
    const kept = current.filter((r) => r.tenantId !== actor.tenantId);
    for (const w of wanted) {
      if (w.tenantId === actor.tenantId) continue;
      const same = kept.find((k) => k.tenantId === w.tenantId);
      if (!same || same.role !== w.role) refuse('other_tenant');
    }

    const next = wanted.find((w) => w.tenantId === actor.tenantId);
    if (next) next.role = await this.assertGrantableRole(actor, next.role);
    await this.assertNotLastTenantAdmin(actor.tenantId, targetId, next ? next.role : null);
    return next ? [...kept, next] : kept;
  },
};
