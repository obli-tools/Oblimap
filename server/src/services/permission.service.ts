import { db } from '../db';
import type { PermissionLevel, UserPermissions } from '@oblimap/shared';
import { TEAM_PERMISSION_SCOPES } from '../validators/team.schema';
import {
  TENANT_ADMIN_ROLE,
  TENANT_CAPABILITIES,
  parseCapabilities,
  permissionSetSlugForRole,
  type TenantCapability,
} from './permissionSet.service';
import { onUserSessionsKilled } from './userSessions.service';

// Team-scoped RBAC. Teams are strictly mono-tenant
// (user_teams.tenant_id): every query below takes the request's tenant and
// only counts teams of THAT tenant, and only groups / sites of that tenant.
// A membership in a team of another tenant never grants anything here.
//
// Who sees what inside a tenant:
//  - platform admins (users.role = 'admin') and tenant admins
//    (user_tenants.role = 'admin'): everything ('rw'), `isFullAccess`;
//  - everyone else: what their teams of the tenant grant —
//    scope 'group' (the group, its descendants and their sites, via
//    group_closure) and scope 'site' (one site). Without a team permission
//    a member reads no site (Obliance semantics). The tenant's general
//    groups (monitor_groups.is_general) are readable by every member as
//    groups (name, tree), but their sites still need a team permission.
//
// "Visible" groups (getVisibleGroupIds, canViewGroup) are a superset of the
// readable ones: the ancestors of a readable group or site are shown in the
// tree so it can be reached, without any permission on them.
//
// The functions answer null / [] for a group or site that is not in the
// tenant, for admins too: callers answer 404 for those (middleware/rbac.ts).
//
// Tenant capabilities (Obliance permission.service
// userHasTenantCapability) are the other half: WHAT the user may do in the
// tenant (manage probes, settings, notifications...), from their tenant role
// — a permission set slug, see permissionSet.service.ts. Platform admins and
// tenant admins hold them all. Resolved capabilities are cached 10 s per
// (user, tenant); invalidateTenantCapabilityCache drops them.

// ── Tenant capability cache ─────────────────────────────────────────────────

const CAPABILITY_TTL_MS = 10_000;
const CAPABILITY_CACHE_MAX = 10_000;
const ALL_CAPABILITIES: ReadonlySet<TenantCapability> = new Set(TENANT_CAPABILITIES);
const NO_CAPABILITY: ReadonlySet<TenantCapability> = new Set();
const capabilityCache = new Map<string, { at: number; caps: ReadonlySet<TenantCapability> }>();

/**
 * Drops cached tenant capabilities: one user's (tenant role changed,
 * membership removed, platform role changed), or everyone's when userId is
 * omitted (a permission set edited or deleted). Without a call a change
 * applies within 10 s.
 */
export function invalidateTenantCapabilityCache(userId?: number): void {
  if (userId === undefined) { capabilityCache.clear(); return; }
  const prefix = `${userId}:`;
  for (const key of capabilityCache.keys()) {
    if (key.startsWith(prefix)) capabilityCache.delete(key);
  }
}

// A user whose sessions are killed (deactivated, deleted, demoted, tenant
// access removed) loses their cached capabilities at once too.
onUserSessionsKilled((userId) => invalidateTenantCapabilityCache(userId));

function isPositiveId(v: number): boolean {
  return Number.isSafeInteger(v) && v > 0 && v <= 2_147_483_647;
}

/**
 * Capabilities of a user in a tenant: every one for an active platform admin
 * (users.role = 'admin') or tenant admin (user_tenants.role = 'admin'); the
 * capabilities of the permission set named by the tenant role otherwise
 * (legacy 'member' → 'viewer'); none for an inactive or unknown user, a
 * non-member, or a role naming no set.
 */
async function resolveTenantCapabilities(userId: number, tenantId: number): Promise<ReadonlySet<TenantCapability>> {
  if (!isPositiveId(userId) || !isPositiveId(tenantId)) return NO_CAPABILITY;
  const key = `${userId}:${tenantId}`;
  const now = Date.now();
  const hit = capabilityCache.get(key);
  if (hit && now - hit.at < CAPABILITY_TTL_MS) return hit.caps;

  const [user, membership] = await Promise.all([
    db('users').where({ id: userId }).first('role', 'is_active'),
    db('user_tenants').where({ user_id: userId, tenant_id: tenantId }).first('role'),
  ]) as [{ role: string; is_active: boolean } | undefined, { role: string } | undefined];

  let caps: ReadonlySet<TenantCapability> = NO_CAPABILITY;
  if (user && user.is_active !== false) {
    if (user.role === 'admin' || membership?.role === TENANT_ADMIN_ROLE) {
      caps = ALL_CAPABILITIES;
    } else if (membership) {
      const set = await db('permission_sets')
        .where({ slug: permissionSetSlugForRole(String(membership.role)) })
        .first('capabilities') as { capabilities: unknown } | undefined;
      caps = set ? new Set(parseCapabilities(set.capabilities)) : NO_CAPABILITY;
    }
  }

  if (capabilityCache.size >= CAPABILITY_CACHE_MAX) capabilityCache.clear();
  capabilityCache.set(key, { at: now, caps });
  return caps;
}

/** UserPermissions plus the tenant capabilities of the current tenant (client gates). */
export type UserPermissionsWithCapabilities = UserPermissions & { capabilities: TenantCapability[] };

function highest(...levels: Array<PermissionLevel | null | undefined>): PermissionLevel | null {
  if (levels.includes('rw')) return 'rw';
  if (levels.includes('ro')) return 'ro';
  return null;
}

function levelOf(rows: Array<{ level: string }>): PermissionLevel | null {
  if (rows.length === 0) return null;
  return rows.some((r) => r.level === 'rw') ? 'rw' : 'ro';
}

export const permissionService = {
  /** Team ids of the user among the teams of one tenant. */
  async getUserTeamIds(userId: number, tenantId: number): Promise<number[]> {
    const rows = await db('team_memberships')
      .join('user_teams', 'user_teams.id', 'team_memberships.team_id')
      .where('team_memberships.user_id', userId)
      .where('user_teams.tenant_id', tenantId)
      .select('team_memberships.team_id');
    return rows.map((r) => Number(r.team_id));
  },

  /** True when the user is an admin of the tenant (user_tenants.role = 'admin'). */
  async isTenantAdmin(userId: number, tenantId: number): Promise<boolean> {
    const row = await db('user_tenants')
      .where({ user_id: userId, tenant_id: tenantId, role: 'admin' })
      .first('user_id');
    return !!row;
  },

  /** Platform admin, or admin of this tenant: full access inside the tenant. */
  async isFullAccess(userId: number, tenantId: number, isPlatformAdmin: boolean): Promise<boolean> {
    if (isPlatformAdmin) return true;
    return this.isTenantAdmin(userId, tenantId);
  },

  /** The group when it belongs to the tenant, else null. */
  async findGroup(groupId: number, tenantId: number): Promise<{ id: number; isGeneral: boolean } | null> {
    const row = await db('monitor_groups')
      .where({ id: groupId, tenant_id: tenantId })
      .first('id', 'is_general') as { id: number; is_general: boolean } | undefined;
    return row ? { id: Number(row.id), isGeneral: !!row.is_general } : null;
  },

  /** The site when it belongs to the tenant, else null. */
  async findSite(siteId: number, tenantId: number): Promise<{ id: number; groupId: number | null } | null> {
    const row = await db('sites')
      .where({ id: siteId, tenant_id: tenantId })
      .first('id', 'group_id') as { id: number; group_id: number | null } | undefined;
    return row ? { id: Number(row.id), groupId: row.group_id != null ? Number(row.group_id) : null } : null;
  },

  /**
   * True when the user holds the tenant capability in the tenant (platform
   * admins and tenant admins hold them all). Cached 10 s.
   */
  async userHasTenantCapability(userId: number, tenantId: number, capability: TenantCapability): Promise<boolean> {
    return (await resolveTenantCapabilities(userId, tenantId)).has(capability);
  },

  /** Every tenant capability the user holds in the tenant, in TENANT_CAPABILITIES order. */
  async listUserTenantCapabilities(userId: number, tenantId: number): Promise<TenantCapability[]> {
    const caps = await resolveTenantCapabilities(userId, tenantId);
    return TENANT_CAPABILITIES.filter((c) => caps.has(c));
  },

  /**
   * Check if user may create groups in the tenant: full access, a team of
   * THIS tenant with can_create (the team-granted right, unchanged), or the
   * tenant capability groups.manage. Below the root, the controller also
   * requires write permission on the parent group; a top-level group also
   * needs canCreateRootGroup.
   */
  async canCreate(userId: number, tenantId: number, isPlatformAdmin = false): Promise<boolean> {
    if (await this.canCreateRootGroup(userId, tenantId, isPlatformAdmin)) return true;
    return this.userHasTenantCapability(userId, tenantId, 'groups.manage');
  },

  /**
   * Check if user may create a top-level group: full access, or a team of
   * THIS tenant with can_create — the team the controller grants 'rw' on the
   * new group. groups.manage alone is not enough: nothing would own the group
   * and its creator could neither see nor write it. A sub-group needs no
   * owner: it inherits the parent's team permissions (group_closure).
   */
  async canCreateRootGroup(userId: number, tenantId: number, isPlatformAdmin = false): Promise<boolean> {
    if (await this.isFullAccess(userId, tenantId, isPlatformAdmin)) return true;
    const row = await db('user_teams')
      .join('team_memberships', 'user_teams.id', 'team_memberships.team_id')
      .where('team_memberships.user_id', userId)
      .where('user_teams.tenant_id', tenantId)
      .where('user_teams.can_create', true)
      .first('user_teams.id');
    return !!row;
  },

  /**
   * Effective permission on a group of the tenant: team group permissions on
   * the group or any ancestor (closure table), at least 'ro' on a general
   * group. null when the group is not in the tenant.
   */
  async getGroupPermission(
    userId: number,
    groupId: number,
    tenantId: number,
    isPlatformAdmin = false,
  ): Promise<PermissionLevel | null> {
    const group = await this.findGroup(groupId, tenantId);
    if (!group) return null;
    if (await this.isFullAccess(userId, tenantId, isPlatformAdmin)) return 'rw';

    const level = await this._getGroupPermissionViaClosure(userId, groupId, tenantId);
    // General groups are readable by every member of their tenant.
    if (group.isGeneral) return level ?? 'ro';
    return level;
  },

  async canReadGroup(userId: number, groupId: number, tenantId: number, isPlatformAdmin = false): Promise<boolean> {
    const perm = await this.getGroupPermission(userId, groupId, tenantId, isPlatformAdmin);
    return perm !== null;
  },

  async canWriteGroup(userId: number, groupId: number, tenantId: number, isPlatformAdmin = false): Promise<boolean> {
    const perm = await this.getGroupPermission(userId, groupId, tenantId, isPlatformAdmin);
    return perm === 'rw';
  },

  /**
   * True when the group is shown to the user (getVisibleGroupIds): readable,
   * or an ancestor shown only to reach a readable group or site. Enough for
   * the group page (the group row, as the tree already shows it, plus
   * counts and probes of the visible sites only); not for settings, writes
   * or site data, which keep their own checks.
   */
  async canViewGroup(userId: number, groupId: number, tenantId: number, isPlatformAdmin = false): Promise<boolean> {
    if (!(await this.findGroup(groupId, tenantId))) return false;
    const visible = await this.getVisibleGroupIds(userId, tenantId, isPlatformAdmin);
    return visible === 'all' || visible.includes(groupId);
  },

  /**
   * Effective permission on a site of the tenant: a direct team 'site'
   * permission, or a team 'group' permission on the site's group or one of
   * its ancestors. A general group gives no access to its sites. null when
   * the site is not in the tenant or nothing grants it.
   */
  async getSitePermission(
    userId: number,
    siteId: number,
    tenantId: number,
    isPlatformAdmin = false,
  ): Promise<PermissionLevel | null> {
    const site = await this.findSite(siteId, tenantId);
    if (!site) return null;
    if (await this.isFullAccess(userId, tenantId, isPlatformAdmin)) return 'rw';

    const directRows = await db('team_permissions')
      .join('team_memberships', 'team_permissions.team_id', 'team_memberships.team_id')
      .join('user_teams', 'user_teams.id', 'team_permissions.team_id')
      .where('team_memberships.user_id', userId)
      .where('user_teams.tenant_id', tenantId)
      .where('team_permissions.scope', 'site')
      .where('team_permissions.scope_id', siteId)
      .select('team_permissions.level');
    const direct = levelOf(directRows);
    if (direct === 'rw' || site.groupId === null) return direct;

    const viaGroup = await this._getGroupPermissionViaClosure(userId, site.groupId, tenantId);
    return highest(direct, viaGroup);
  },

  async canReadSite(userId: number, siteId: number, tenantId: number, isPlatformAdmin = false): Promise<boolean> {
    const perm = await this.getSitePermission(userId, siteId, tenantId, isPlatformAdmin);
    return perm !== null;
  },

  async canWriteSite(userId: number, siteId: number, tenantId: number, isPlatformAdmin = false): Promise<boolean> {
    const perm = await this.getSitePermission(userId, siteId, tenantId, isPlatformAdmin);
    return perm === 'rw';
  },

  /**
   * Site ids of the tenant the user may read. 'all' for full access (platform
   * or tenant admin). Users without any team permission in the tenant see no
   * site ([]), general groups included.
   */
  async getVisibleSiteIds(userId: number, tenantId: number, isPlatformAdmin = false): Promise<number[] | 'all'> {
    if (await this.isFullAccess(userId, tenantId, isPlatformAdmin)) return 'all';

    const teamIds = await this.getUserTeamIds(userId, tenantId);
    if (teamIds.length === 0) return [];

    const ids = new Set<number>();

    // Sites via group permissions (inherited through the closure table).
    const groupSites = await db('sites')
      .join('group_closure', 'group_closure.descendant_id', 'sites.group_id')
      .join('team_permissions', function () {
        this.on('team_permissions.scope_id', 'group_closure.ancestor_id')
          .andOn(db.raw("team_permissions.scope = 'group'"));
      })
      .join('monitor_groups as ancestor', 'ancestor.id', 'group_closure.ancestor_id')
      .whereIn('team_permissions.team_id', teamIds)
      .where('sites.tenant_id', tenantId)
      .where('ancestor.tenant_id', tenantId)
      .select('sites.id');
    for (const r of groupSites) ids.add(Number(r.id));

    // Sites via direct site permissions.
    const directSites = await db('sites')
      .whereIn('id', db('team_permissions')
        .whereIn('team_id', teamIds)
        .where('scope', 'site')
        .select('scope_id'))
      .where('tenant_id', tenantId)
      .select('id');
    for (const r of directSites) ids.add(Number(r.id));

    return [...ids];
  },

  /**
   * Group ids of the tenant visible to the user (sidebar tree, lists, stats).
   * A group is visible if the user has a permission on it or on an ancestor,
   * if it is a general group, or if it is an ancestor of one of those or of
   * a site the user may read directly (tree navigation: the tree drops a
   * hidden node with its whole subtree).
   * Returns 'all' for full access.
   */
  async getVisibleGroupIds(userId: number, tenantId: number, isPlatformAdmin = false): Promise<number[] | 'all'> {
    if (await this.isFullAccess(userId, tenantId, isPlatformAdmin)) return 'all';

    const ids = new Set<number>();

    // General groups of the tenant.
    const generalIds = (await db('monitor_groups')
      .where({ tenant_id: tenantId, is_general: true })
      .select('id'))
      .map((r) => Number(r.id));

    let permGroupIds: number[] = [];
    let siteGroupIds: number[] = [];
    const teamIds = await this.getUserTeamIds(userId, tenantId);
    if (teamIds.length > 0) {
      // Groups of the tenant with a direct group permission.
      permGroupIds = (await db('team_permissions')
        .join('monitor_groups', 'monitor_groups.id', 'team_permissions.scope_id')
        .whereIn('team_permissions.team_id', teamIds)
        .where('team_permissions.scope', 'group')
        .where('monitor_groups.tenant_id', tenantId)
        .select('team_permissions.scope_id'))
        .map((r) => Number(r.scope_id));

      // Groups of the tenant holding a site with a direct site permission.
      siteGroupIds = (await db('sites')
        .whereIn('id', db('team_permissions')
          .whereIn('team_id', teamIds)
          .where('scope', 'site')
          .select('scope_id'))
        .where('tenant_id', tenantId)
        .whereNotNull('group_id')
        .select('group_id'))
        .map((r) => Number(r.group_id));
    }

    // Descendants of the permitted groups (the permission is inherited).
    if (permGroupIds.length > 0) {
      const descRows = await db('group_closure')
        .whereIn('ancestor_id', permGroupIds)
        .select('descendant_id');
      for (const r of descRows) ids.add(Number(r.descendant_id));
    }

    // The general groups, the permitted groups, the sites' groups, and all
    // their ancestors (navigation).
    const anchorIds = [...new Set([...generalIds, ...permGroupIds, ...siteGroupIds])];
    if (anchorIds.length > 0) {
      const ancRows = await db('group_closure')
        .whereIn('descendant_id', anchorIds)
        .select('ancestor_id');
      for (const r of ancRows) ids.add(Number(r.ancestor_id));
      for (const id of anchorIds) ids.add(id);
    }

    // Closure rows could still point at another tenant's group (legacy
    // cross-tenant parents): keep only the tenant's groups.
    if (ids.size === 0) return [];
    const inTenant = await db('monitor_groups')
      .where('tenant_id', tenantId)
      .whereIn('id', [...ids])
      .select('id');
    return inTenant.map((r) => Number(r.id));
  },

  /**
   * Build the full UserPermissions object for the current user, in the
   * session's tenant. Sent to the client on login/session check so the UI
   * can adapt (every route enforces the checks above on its own).
   *
   * Only teams of that tenant count, and a tenant admin gets canCreate plus
   * 'rw' on every group and site of the tenant (what the server grants
   * them). `capabilities` lists the user's tenant capabilities there. A
   * session without a tenant gets nothing (platform admins: canCreate and
   * every capability, as everywhere).
   */
  async getUserPermissions(
    userId: number,
    isAdmin: boolean,
    tenantId: number | null,
  ): Promise<UserPermissionsWithCapabilities> {
    if (isAdmin) {
      return { canCreate: true, teams: [], permissions: {}, capabilities: [...TENANT_CAPABILITIES] };
    }
    if (tenantId == null) {
      return { canCreate: false, teams: [], permissions: {}, capabilities: [] };
    }

    const permissions: Record<string, PermissionLevel> = {};
    const add = (scope: string, scopeId: number, level: PermissionLevel) => {
      const key = `${scope}:${scopeId}`;
      const existing = permissions[key];
      if (!existing || (existing === 'ro' && level === 'rw')) permissions[key] = level;
    };

    const [teamIds, capabilities] = await Promise.all([
      this.getUserTeamIds(userId, tenantId),
      this.listUserTenantCapabilities(userId, tenantId),
    ]);

    if (await this.isTenantAdmin(userId, tenantId)) {
      const [groupRows, siteRows] = await Promise.all([
        db('monitor_groups').where({ tenant_id: tenantId }).select('id'),
        db('sites').where({ tenant_id: tenantId }).select('id'),
      ]);
      for (const g of groupRows) add('group', Number(g.id), 'rw');
      for (const s of siteRows) add('site', Number(s.id), 'rw');
      return { canCreate: true, teams: teamIds, permissions, capabilities };
    }

    const canCreate = await this.canCreate(userId, tenantId, false);
    const perms = teamIds.length === 0 ? [] : await db('team_permissions')
      .whereIn('team_id', teamIds)
      .whereIn('scope', [...TEAM_PERMISSION_SCOPES])
      .select('scope', 'scope_id', 'level');
    for (const p of perms) add(p.scope, Number(p.scope_id), p.level);

    return { canCreate, teams: teamIds, permissions, capabilities };
  },

  // ── Private helpers ──

  /**
   * Highest team 'group' permission of the user (teams of the tenant only)
   * on a group, through the group or any of its ancestors (closure table).
   * The permitted ancestor must belong to the tenant as well.
   */
  async _getGroupPermissionViaClosure(
    userId: number,
    groupId: number,
    tenantId: number,
  ): Promise<PermissionLevel | null> {
    const rows = await db('team_permissions')
      .join('team_memberships', 'team_permissions.team_id', 'team_memberships.team_id')
      .join('user_teams', 'user_teams.id', 'team_permissions.team_id')
      .join('group_closure', 'group_closure.ancestor_id', 'team_permissions.scope_id')
      .join('monitor_groups as ancestor', 'ancestor.id', 'group_closure.ancestor_id')
      .where('team_memberships.user_id', userId)
      .where('user_teams.tenant_id', tenantId)
      .where('ancestor.tenant_id', tenantId)
      .where('team_permissions.scope', 'group')
      .where('group_closure.descendant_id', groupId)
      .select('team_permissions.level');
    return levelOf(rows);
  },
};
