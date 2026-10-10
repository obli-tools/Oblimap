import type { Knex } from 'knex';
import { db } from '../db';
import type { UserTeam, TeamPermission } from '@oblimap/shared';
import { AppError } from '../middleware/errorHandler';
import { TEAM_PERMISSION_SCOPES, type TeamPermissionScope } from '../validators/team.schema';

// Teams are strictly mono-tenant: every call by
// id takes the tenant and filters on user_teams.tenant_id, members must be
// members of that tenant, and permissions may only target groups / sites of
// that tenant.

interface TeamRow {
  id: number;
  name: string;
  description: string | null;
  can_create: boolean;
  tenant_id: number;
  tenant_name?: string; // populated by JOIN when fetching all tenants
  created_at: Date;
  updated_at: Date;
}

interface PermissionRow {
  id: number;
  team_id: number;
  scope: TeamPermissionScope;
  scope_id: number;
  level: 'ro' | 'rw';
}

/** TeamPermission with the current scopes ('group' | 'site'). */
export type TeamPermissionEntry = Omit<TeamPermission, 'scope'> & { scope: TeamPermissionScope };

export interface TeamPermissionInput {
  scope: TeamPermissionScope;
  scopeId: number;
  level: 'ro' | 'rw';
}

function rowToTeam(row: TeamRow): UserTeam {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    canCreate: row.can_create,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToPermission(row: PermissionRow): TeamPermissionEntry {
  return {
    id: row.id,
    teamId: row.team_id,
    scope: row.scope,
    scopeId: row.scope_id,
    level: row.level,
  };
}

/** Legacy 'monitor' rows (Obliview) are ignored: they grant nothing any more. */
function currentPermissions(q: Knex, teamId: number) {
  return q<PermissionRow>('team_permissions')
    .where({ team_id: teamId })
    .whereIn('scope', [...TEAM_PERMISSION_SCOPES])
    .orderBy('scope')
    .orderBy('scope_id');
}

export const teamService = {
  /**
   * Returns teams scoped to a tenant.
   * If tenantId is null (platform admin cross-tenant view), returns ALL teams across
   * all tenants, joined with tenant name.
   */
  async getAll(tenantId: number | null): Promise<UserTeam[]> {
    const query = db('user_teams')
      .join('tenants', 'user_teams.tenant_id', 'tenants.id')
      .select('user_teams.*', 'tenants.name as tenant_name')
      .orderBy('user_teams.name');
    if (tenantId !== null) {
      query.where('user_teams.tenant_id', tenantId);
    }
    const rows = await query;
    return rows.map(rowToTeam);
  },

  async getById(id: number, tenantId: number): Promise<UserTeam | null> {
    const row = await db<TeamRow>('user_teams').where({ id, tenant_id: tenantId }).first();
    return row ? rowToTeam(row) : null;
  },

  async create(data: { name: string; description?: string | null; canCreate?: boolean }, tenantId: number): Promise<UserTeam> {
    const [row] = await db<TeamRow>('user_teams')
      .insert({
        name: data.name,
        description: data.description ?? null,
        can_create: data.canCreate ?? false,
        tenant_id: tenantId,
      })
      .returning('*');
    return rowToTeam(row);
  },

  async update(
    id: number,
    tenantId: number,
    data: { name?: string; description?: string | null; canCreate?: boolean },
  ): Promise<UserTeam | null> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.canCreate !== undefined) updateData.can_create = data.canCreate;

    const [row] = await db<TeamRow>('user_teams')
      .where({ id, tenant_id: tenantId })
      .update(updateData)
      .returning('*');
    return row ? rowToTeam(row) : null;
  },

  async delete(id: number, tenantId: number): Promise<boolean> {
    const count = await db('user_teams').where({ id, tenant_id: tenantId }).del();
    return count > 0;
  },

  // ── Members ──
  // The member / permission helpers take a team id the caller has already
  // resolved with getById(id, tenantId).

  async getMembers(teamId: number): Promise<number[]> {
    const rows = await db('team_memberships')
      .where({ team_id: teamId })
      .select('user_id');
    return rows.map((r) => r.user_id);
  },

  /** Users who may join a team of the tenant: the tenant's members. */
  async getEligibleMemberIds(tenantId: number): Promise<number[]> {
    const rows = await db('user_tenants').where({ tenant_id: tenantId }).select('user_id');
    return rows.map((r) => Number(r.user_id));
  },

  /**
   * The tenant's members as team member candidates, so a
   * users.manage holder sees names instead of ids. foreignSource: SSO
   * accounts, whose teams Obligate re-syncs at each sign-in.
   */
  async getEligibleMembers(tenantId: number): Promise<Array<{
    id: number;
    username: string;
    displayName: string | null;
    isActive: boolean;
    foreignSource: string | null;
  }>> {
    const rows = await db('user_tenants')
      .join('users', 'users.id', 'user_tenants.user_id')
      .where('user_tenants.tenant_id', tenantId)
      .select('users.id', 'users.username', 'users.display_name', 'users.is_active', 'users.foreign_source')
      .orderBy('users.username') as Array<{
        id: number; username: string; display_name: string | null; is_active: boolean; foreign_source: string | null;
      }>;
    return rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      displayName: r.display_name ?? null,
      isActive: r.is_active !== false,
      foreignSource: r.foreign_source ?? null,
    }));
  },

  /**
   * Replaces the members of a team of the tenant. Every user must be a
   * member of the team's tenant (400 otherwise, nothing changed).
   * Returns the previous member ids.
   */
  async setMembers(teamId: number, tenantId: number, userIds: number[]): Promise<number[]> {
    const ids = [...new Set(userIds)];
    return db.transaction(async (trx) => {
      const team = await trx('user_teams').where({ id: teamId, tenant_id: tenantId }).first('id');
      if (!team) throw new AppError(404, 'Team not found');

      if (ids.length > 0) {
        const eligible = new Set((await trx('user_tenants')
          .where({ tenant_id: tenantId })
          .whereIn('user_id', ids)
          .select('user_id')).map((r) => Number(r.user_id)));
        const invalid = ids.filter((id) => !eligible.has(id));
        if (invalid.length > 0) {
          throw new AppError(400, `Users must be members of the team's tenant (invalid user ids: ${invalid.slice(0, 20).join(', ')})`);
        }
      }

      const before = (await trx('team_memberships').where({ team_id: teamId }).select('user_id'))
        .map((r) => Number(r.user_id));
      await trx('team_memberships').where({ team_id: teamId }).del();
      if (ids.length > 0) {
        await trx('team_memberships').insert(
          ids.map((uid) => ({ team_id: teamId, user_id: uid })),
        );
      }
      return before;
    });
  },

  /**
   * Teams of a user. With a tenant: only that tenant's teams (permission
   * checks, group auto-grant). Without: every tenant (platform admin view).
   */
  async getUserTeams(userId: number, tenantId?: number): Promise<UserTeam[]> {
    const query = db<TeamRow>('user_teams')
      .join('team_memberships', 'user_teams.id', 'team_memberships.team_id')
      .where('team_memberships.user_id', userId)
      .select('user_teams.*')
      .orderBy('user_teams.name');
    if (tenantId !== undefined) query.where('user_teams.tenant_id', tenantId);
    const rows = await query;
    return rows.map(rowToTeam);
  },

  // ── Permissions ──

  async getPermissions(teamId: number): Promise<TeamPermissionEntry[]> {
    const rows = await currentPermissions(db, teamId);
    return rows.map(rowToPermission);
  },

  /**
   * Replaces the permissions of a team of the tenant. Every scopeId must be a
   * group / site of the team's tenant (400 otherwise, nothing changed).
   * Duplicates (same scope + scopeId) keep the highest level.
   */
  async setPermissions(
    teamId: number,
    tenantId: number,
    permissions: TeamPermissionInput[],
  ): Promise<TeamPermissionEntry[]> {
    const byKey = new Map<string, TeamPermissionInput>();
    for (const p of permissions) {
      const key = `${p.scope}:${p.scopeId}`;
      const existing = byKey.get(key);
      if (!existing || (existing.level === 'ro' && p.level === 'rw')) byKey.set(key, p);
    }
    const unique = [...byKey.values()];

    return db.transaction(async (trx) => {
      const team = await trx('user_teams').where({ id: teamId, tenant_id: tenantId }).first('id');
      if (!team) throw new AppError(404, 'Team not found');

      for (const scope of TEAM_PERMISSION_SCOPES) {
        const ids = [...new Set(unique.filter((p) => p.scope === scope).map((p) => p.scopeId))];
        if (ids.length === 0) continue;
        const table = scope === 'group' ? 'monitor_groups' : 'sites';
        const owned = new Set((await trx(table)
          .where({ tenant_id: tenantId })
          .whereIn('id', ids)
          .select('id')).map((r) => Number(r.id)));
        const invalid = ids.filter((id) => !owned.has(id));
        if (invalid.length > 0) {
          throw new AppError(400, `Unknown ${scope} ids for this tenant: ${invalid.slice(0, 20).join(', ')}`);
        }
      }

      await trx('team_permissions').where({ team_id: teamId }).del();
      if (unique.length > 0) {
        await trx('team_permissions').insert(
          unique.map((p) => ({
            team_id: teamId,
            scope: p.scope,
            scope_id: p.scopeId,
            level: p.level,
          })),
        );
      }
      const rows = await currentPermissions(trx, teamId);
      return rows.map(rowToPermission);
    });
  },

  /**
   * Upserts one permission. The caller guarantees that the team and the
   * group / site belong to the same tenant (groups.controller create).
   */
  async addPermission(
    teamId: number,
    scope: TeamPermissionScope,
    scopeId: number,
    level: 'ro' | 'rw',
  ): Promise<TeamPermissionEntry> {
    const [row] = await db<PermissionRow>('team_permissions')
      .insert({ team_id: teamId, scope, scope_id: scopeId, level })
      .onConflict(['team_id', 'scope', 'scope_id'])
      .merge({ level })
      .returning('*');
    return rowToPermission(row);
  },

  /** Removes one permission of one team (both ids must match). */
  async removePermission(teamId: number, permissionId: number): Promise<TeamPermissionEntry | null> {
    const row = await db<PermissionRow>('team_permissions')
      .where({ id: permissionId, team_id: teamId })
      .first();
    if (!row) return null;
    await db('team_permissions').where({ id: permissionId, team_id: teamId }).del();
    return rowToPermission(row);
  },
};
