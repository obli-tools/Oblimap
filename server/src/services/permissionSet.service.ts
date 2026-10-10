import type { Knex } from 'knex';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import {
  BASELINE_CAPABILITY,
  CAPABILITY_GROUPS,
  CAPABILITY_IMPLIES,
  TENANT_CAPABILITIES,
  expandCapabilities,
  isTenantCapability,
  type CapabilityGroup,
  type TenantCapability,
} from '@oblimap/shared';

// ── Types ───────────────────────────────────────────────────────────────────

interface PermissionSetRow {
  id: number;
  name: string;
  slug: string;
  capabilities: string[] | string;
  is_default: boolean;
  created_at: Date;
}

export interface PermissionSet {
  id: number;
  name: string;
  slug: string;
  capabilities: TenantCapability[];
  isDefault: boolean;
  createdAt: string;
}

export interface CapabilityInfo {
  key: TenantCapability;
  label: string;
  /** English description (the client translates it: permissionSets.capDescription.*). */
  description: string;
  /** CAPABILITY_GROUPS id of the matrix row. */
  group: CapabilityGroup['id'];
  /** Capabilities this one grants as well (CAPABILITY_IMPLIES). */
  implies: TenantCapability[];
  /** The baseline row ('monitoring'): shown locked and always ticked. */
  baseline: boolean;
}

// ── Tenant capabilities ───────────────────────────────────────
// WHAT a user may do inside a tenant. The user's tenant role
// (user_tenants.role) is a permission set slug, and the set's capabilities are
// checked by permissionService.userHasTenantCapability, behind the rbac.ts
// gates requireTenantCapability / requireAnyTenantCapability. WHERE (which
// groups and sites) stays with the team permissions (requireGroupWrite,
// requireSiteRead / requireSiteWrite, the controllers).
//  - Platform admins (users.role = 'admin') hold every capability in every
//    tenant; tenant admins (role 'admin') every capability in their tenant,
//    whatever the 'admin' set lists.
//  - The legacy role 'member' (every non-admin membership before permission
//    sets were assignable) is read as the 'viewer' set.
//  - 'monitoring' is the baseline read capability: what a user reads is
//    decided by the team permissions, it is not checked on its own.
//  - The list itself lives in @oblimap/shared (one table for the server
//    gates and the client PAGE_ACCESS). A set grants its capabilities plus
//    what they imply (CAPABILITY_IMPLIES: probes.manage → probes.approve →
//    probes.read), so sets saved before the probe split keep their rights.

export { TENANT_CAPABILITIES, isTenantCapability, expandCapabilities };
export type { TenantCapability };

// English labels and descriptions (the client translates them by key:
// permissionSets.cap.* / permissionSets.capDescription.*).
const CAPABILITY_TEXTS: Record<TenantCapability, { label: string; description: string }> = {
  monitoring: {
    label: 'View sites, groups and devices (as team permissions allow)',
    description: 'Included in every set: reading follows the team permissions.',
  },
  'groups.manage': {
    label: 'Create sub-groups and reorder groups',
    description: 'Create sub-groups below a group the member can edit, and reorder groups.',
  },
  'sites.manage': {
    label: 'Create and delete sites (vendor rules: with device checks)',
    description: 'Create and delete sites. Editing sites and devices comes from team rw permissions.',
  },
  'probes.read': {
    label: 'View probes',
    description: 'See every probe of the workspace, its details and effective scan configuration, whatever the team permissions.',
  },
  'probes.approve': {
    label: 'Approve probes',
    description: 'Approve or refuse new probes, suspend and unsuspend them. Includes viewing probes.',
  },
  'probes.manage': {
    label: 'Manage probes and probe API keys',
    description: 'Everything on probes: API keys, commands, settings, identity tokens, deletion. Includes approving and viewing.',
  },
  'tunnels.use': {
    label: 'Open TCP tunnels to devices',
    description: 'Open TCP / web tunnels to devices of sites the member can edit.',
  },
  'deviceChecks.manage': {
    label: 'Manage device checks (rules, credentials, tests)',
    description: 'Write, enable, test and run device check rules and their credentials.',
  },
  'notifications.manage': {
    label: 'Manage notification channels and SMTP servers',
    description: 'Notification channels, their bindings and the SMTP servers.',
  },
  settings: {
    label: 'Tenant settings, import / export, live alert clean-up',
    description: 'Inherited settings at every level, and clearing live alerts.',
  },
  'users.manage': {
    label: 'Manage the workspace users, roles and teams (only what the holder has)',
    description: 'Members of the workspace, their roles, teams and group / site permissions — never beyond the access the holder has.',
  },
  'audit.read': {
    label: 'Read the audit log',
    description: 'Read the audit log of the workspace.',
  },
};

const CAPABILITY_GROUP_OF = new Map<TenantCapability, CapabilityGroup['id']>(
  CAPABILITY_GROUPS.flatMap((g) => g.keys.map((k) => [k, g.id] as const)),
);

const AVAILABLE_CAPABILITIES: CapabilityInfo[] = TENANT_CAPABILITIES.map((key) => ({
  key,
  label: CAPABILITY_TEXTS[key].label,
  description: CAPABILITY_TEXTS[key].description,
  group: CAPABILITY_GROUP_OF.get(key) ?? 'administration',
  implies: [...(CAPABILITY_IMPLIES[key] ?? [])],
  baseline: key === BASELINE_CAPABILITY,
}));

/** Tenant role granting every capability of the tenant (tenant admin). */
export const TENANT_ADMIN_ROLE = 'admin';
/** Legacy user_tenants.role value, read as the LEGACY_MEMBER_SET set. */
export const LEGACY_MEMBER_ROLE = 'member';
export const LEGACY_MEMBER_SET = 'viewer';

/** Permission set slug: lowercase letters, digits and inner dashes, at most 64 (user_tenants.role). */
export const PERMISSION_SET_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** The permission set slug whose capabilities apply to a user_tenants.role value. */
export function permissionSetSlugForRole(role: string): string {
  return role === LEGACY_MEMBER_ROLE ? LEGACY_MEMBER_SET : role;
}

/**
 * Capabilities as stored on a permission set (jsonb array, or its JSON text):
 * the known ones only, deduplicated, in TENANT_CAPABILITIES order, without
 * the implied ones. Anything unreadable grants nothing.
 */
export function parseStoredCapabilities(raw: unknown): TenantCapability[] {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const present = new Set(value.filter(isTenantCapability));
  return TENANT_CAPABILITIES.filter((c) => present.has(c));
}

/**
 * Capabilities a permission set GRANTS (capability resolution): the stored
 * ones plus everything they imply (expandCapabilities).
 */
export function parseCapabilities(raw: unknown): TenantCapability[] {
  return expandCapabilities(parseStoredCapabilities(raw));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function rowToPermissionSet(row: PermissionSetRow): PermissionSet {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    // Tenant admins hold every capability, whatever the row lists. Other
    // sets: what is stored (the implied ones are derived, CAPABILITY_IMPLIES).
    capabilities: row.slug === TENANT_ADMIN_ROLE ? [...TENANT_CAPABILITIES] : parseStoredCapabilities(row.capabilities),
    isDefault: row.is_default,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

// ── Service ─────────────────────────────────────────────────────────────────
// Permission sets are platform-wide (every tenant uses the same sets); only
// platform admins change them (routes/permissionSets.routes.ts). The slug is
// what user_tenants.role stores: it cannot be changed after creation, and a
// set still assigned to a membership cannot be deleted.

class PermissionSetService {
  async getAll(): Promise<PermissionSet[]> {
    const rows = await db<PermissionSetRow>('permission_sets').orderBy('is_default', 'desc').orderBy('name', 'asc');
    return rows.map(rowToPermissionSet);
  }

  async getById(id: number): Promise<PermissionSet | null> {
    const row = await db<PermissionSetRow>('permission_sets').where({ id }).first();
    return row ? rowToPermissionSet(row) : null;
  }

  async getBySlug(slug: string): Promise<PermissionSet | null> {
    const row = await db<PermissionSetRow>('permission_sets').where({ slug }).first();
    return row ? rowToPermissionSet(row) : null;
  }

  /**
   * True when `role` may be stored as a tenant role (user_tenants.role):
   * 'admin', the legacy 'member', or the slug of an existing permission set.
   */
  async isAssignableTenantRole(role: string): Promise<boolean> {
    if (role === TENANT_ADMIN_ROLE || role === LEGACY_MEMBER_ROLE) return true;
    if (!PERMISSION_SET_SLUG_RE.test(role)) return false;
    return !!(await db('permission_sets').where({ slug: role }).first('id'));
  }

  /**
   * isAssignableTenantRole inside the transaction that then writes the role
   * to user_tenants. The set's row stays locked FOR SHARE until that
   * transaction ends, so a concurrent delete() (FOR UPDATE, then counts the
   * memberships) either waits and counts the new membership, or has already
   * deleted the set and this answers false: no membership is left on a slug
   * that no longer exists.
   */
  async lockAssignableTenantRole(trx: Knex.Transaction, role: string): Promise<boolean> {
    if (role === TENANT_ADMIN_ROLE || role === LEGACY_MEMBER_ROLE) return true;
    if (!PERMISSION_SET_SLUG_RE.test(role)) return false;
    return !!(await trx('permission_sets').where({ slug: role }).forShare().first('id'));
  }

  /** Number of tenant memberships whose role resolves to this set (legacy 'member' counts for 'viewer'). */
  async countMemberships(slug: string, conn: Knex = db): Promise<number> {
    const roles = slug === LEGACY_MEMBER_SET ? [slug, LEGACY_MEMBER_ROLE] : [slug];
    const row = await conn('user_tenants').whereIn('role', roles).count('* as cnt').first() as
      { cnt?: string | number } | undefined;
    return Number(row?.cnt ?? 0);
  }

  /** A unique violation (23505) propagates: the route answers 409. */
  async create(data: { name: string; slug: string; capabilities: TenantCapability[] }): Promise<PermissionSet> {
    if (data.slug === LEGACY_MEMBER_ROLE) {
      throw new AppError(400, `The slug "${LEGACY_MEMBER_ROLE}" is reserved`);
    }
    const [row] = await db<PermissionSetRow>('permission_sets')
      .insert({
        name: data.name,
        slug: data.slug,
        capabilities: JSON.stringify(parseStoredCapabilities(data.capabilities)),
        is_default: false,
        created_at: new Date(),
      } as unknown as PermissionSetRow)
      .returning('*');
    if (!row) throw new Error('Permission set insert returned no row');
    return rowToPermissionSet(row);
  }

  /** Name and / or capabilities. Returns null when the set does not exist. */
  async update(
    id: number,
    data: { name?: string; capabilities?: TenantCapability[] },
  ): Promise<{ before: PermissionSet; after: PermissionSet } | null> {
    const existing = await db<PermissionSetRow>('permission_sets').where({ id }).first();
    if (!existing) return null;
    if (data.capabilities !== undefined && existing.slug === TENANT_ADMIN_ROLE) {
      throw new AppError(400, 'The admin set always holds every capability');
    }

    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.capabilities !== undefined) updates.capabilities = JSON.stringify(parseStoredCapabilities(data.capabilities));
    if (Object.keys(updates).length === 0) {
      const same = rowToPermissionSet(existing);
      return { before: same, after: same };
    }

    const [row] = await db<PermissionSetRow>('permission_sets')
      .where({ id })
      .update(updates)
      .returning('*');
    if (!row) return null;
    return { before: rowToPermissionSet(existing), after: rowToPermissionSet(row) };
  }

  /**
   * Deletes a custom set that no membership uses. Returns null when it does
   * not exist. The set's row is locked FOR UPDATE before the memberships are
   * counted: a membership write validating this slug in the meantime
   * (lockAssignableTenantRole) is either counted or refused.
   */
  async delete(id: number): Promise<PermissionSet | null> {
    return db.transaction(async (trx) => {
      const existing = await trx<PermissionSetRow>('permission_sets').where({ id }).forUpdate().first();
      if (!existing) return null;
      if (existing.is_default) throw new AppError(400, 'Cannot delete a default permission set');
      const inUse = await this.countMemberships(existing.slug, trx);
      if (inUse > 0) {
        throw new AppError(409, `Permission set in use by ${inUse} tenant membership(s): assign them another role first`);
      }
      await trx('permission_sets').where({ id }).del();
      return rowToPermissionSet(existing);
    });
  }

  getAvailableCapabilities(): CapabilityInfo[] {
    return AVAILABLE_CAPABILITIES;
  }
}

export const permissionSetService = new PermissionSetService();
