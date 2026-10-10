import type { Request } from 'express';
import type { PermissionLevel } from '@oblimap/shared';
import { db } from '../db';
import { permissionService } from './permission.service';
import { auditService } from './audit.service';
import {
  ScopeRefusal,
  accessCovered,
  actorTeamLevels,
  levelCovers,
  uncoveredGrants,
  type ScopeActor,
} from './userScope.service';
import type { TeamPermissionScope } from '../validators/team.schema';

// ── Team anti-escalation ──────────────────────────────────────────
//
// The /teams routes need the tenant capability users.manage. Teams decide
// WHERE members read and write, so a holder without full access in the
// tenant (not a platform admin, not a tenant admin) must never use them to
// widen anybody's rights beyond their own — their own included:
//   1. they cannot add or remove themselves, and cannot edit or delete a
//      team they belong to;
//   2. every granted {scope, scopeId, level} is at most their own permission
//      on that group / site (getGroupPermission / getSitePermission);
//   3. in the replace-all PUT /teams/:id/permissions, the rows they do not
//      dominate are kept unchanged (computed here, never dropped silently);
//      changing such a row is refused;
//   4. canCreate = true needs canCreateRootGroup themselves;
//   5. adding members to a team needs the team's whole access (every row,
//      and can_create) to be covered by their own — otherwise a member they
//      created or whose password they reset would carry it for them.
//      Removing members stays allowed.
// "Their own level" is team-derived (userScope.actorTeamLevels): the bare
// 'ro' every member gets on a general group shows the group only, it is
// never a grantable level.
// Refusals answer 403 { error: 'forbidden', reason } and are audited
// 'team.grant_refused'. Full-access callers are not checked here.

export interface TeamGrant {
  scope: TeamPermissionScope;
  scopeId: number;
  level: PermissionLevel;
}

export type TeamRefusalReason =
  | 'self_membership'
  | 'own_team'
  | 'grant_exceeds_own'
  | 'non_dominated_row_changed'
  | 'can_create_not_held'
  | 'team_exceeds_own';

const TEAM_REFUSAL_MESSAGES: Record<TeamRefusalReason, string> = {
  team_exceeds_own: 'This team has access you do not hold: you cannot add members to it',
  self_membership: 'You cannot add yourself to a team or remove yourself from one',
  own_team: 'You cannot change a team you belong to',
  grant_exceeds_own: 'You can only grant access you hold yourself',
  non_dominated_row_changed: 'This team has access you do not hold: it cannot be changed by you',
  can_create_not_held: 'You cannot let a team create top-level groups without that right yourself',
};

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

function rank(level: PermissionLevel | null | undefined): number {
  return level === 'rw' ? 2 : level === 'ro' ? 1 : 0;
}

/** True when `actorLevel` covers `granted` (rw ≥ ro ≥ nothing); defined in userScope. */
export { levelCovers };

export function grantKey(g: { scope: string; scopeId: number }): string {
  return `${g.scope}:${g.scopeId}`;
}

/** Membership change check: the actor neither joins nor leaves, and is not in the team. */
export function membersRefusal(actorId: number, before: readonly number[], after: readonly number[]): TeamRefusalReason | null {
  const inBefore = before.includes(actorId);
  const inAfter = after.includes(actorId);
  if (inBefore !== inAfter) return 'self_membership';
  if (inBefore) return 'own_team';
  return null;
}

/**
 * Plans a replace-all of a team's permissions by an actor without full
 * access. `actorLevels` maps grantKey → the actor's own level on that target
 * (missing = none).
 *  - a current row the actor does not dominate is kept as it is; the request
 *    may omit it or repeat it unchanged, any other level is refused;
 *  - every other requested row must be covered by the actor's level;
 *  - duplicates in the request keep the highest level (as team.service).
 * Returns the full list to store, or the refused rows.
 */
export function planPermissionReplace(
  current: readonly TeamGrant[],
  requested: readonly TeamGrant[],
  actorLevels: ReadonlyMap<string, PermissionLevel>,
): { ok: true; permissions: TeamGrant[]; kept: TeamGrant[] } | { ok: false; reason: TeamRefusalReason; refused: TeamGrant[] } {
  const wanted = new Map<string, TeamGrant>();
  for (const p of requested) {
    const key = grantKey(p);
    const existing = wanted.get(key);
    if (!existing || rank(p.level) > rank(existing.level)) wanted.set(key, { scope: p.scope, scopeId: p.scopeId, level: p.level });
  }

  const kept = new Map<string, TeamGrant>();
  for (const c of current) {
    if (!levelCovers(actorLevels.get(grantKey(c)), c.level)) {
      kept.set(grantKey(c), { scope: c.scope, scopeId: c.scopeId, level: c.level });
    }
  }

  const changedKept: TeamGrant[] = [];
  const exceeding: TeamGrant[] = [];
  for (const [key, w] of wanted) {
    const k = kept.get(key);
    if (k) {
      if (k.level !== w.level) changedKept.push(w);
      continue;
    }
    if (!levelCovers(actorLevels.get(key), w.level)) exceeding.push(w);
  }
  if (changedKept.length > 0) return { ok: false, reason: 'non_dominated_row_changed', refused: changedKept };
  if (exceeding.length > 0) return { ok: false, reason: 'grant_exceeds_own', refused: exceeding };

  const permissions = [...kept.values()];
  for (const [key, w] of wanted) if (!kept.has(key)) permissions.push(w);
  return { ok: true, permissions, kept: [...kept.values()] };
}

/**
 * Adding members (`added` non-empty) to a team with rows `teamRows` and
 * `teamCanCreate`: refused unless the actor covers all of it. Removals alone
 * are never refused here.
 */
export function addMembersRefusal(input: {
  added: readonly number[];
  teamRows: readonly TeamGrant[];
  teamCanCreate: boolean;
  actorLevels: ReadonlyMap<string, PermissionLevel>;
  actorCanCreate: boolean;
}): { reason: TeamRefusalReason; refused: TeamGrant[] } | null {
  if (input.added.length === 0) return null;
  const covered = accessCovered({
    grants: input.teamRows,
    actorLevels: input.actorLevels,
    canCreate: input.teamCanCreate,
    actorCanCreate: input.actorCanCreate,
  });
  if (covered) return null;
  return { reason: 'team_exceeds_own', refused: uncoveredGrants(input.teamRows, input.actorLevels) };
}

/** Removing one row: allowed only when the actor covers it. */
export function removalRefusal(actorLevel: PermissionLevel | null | undefined, row: TeamGrant): TeamRefusalReason | null {
  return levelCovers(actorLevel, row.level) ? null : 'non_dominated_row_changed';
}

// ── Database-backed checks ──────────────────────────────────────────────────

async function refuseTeam(
  req: Request,
  team: { id: number | null; name: string },
  reason: TeamRefusalReason,
  details: Record<string, unknown> = {},
): Promise<never> {
  await auditService.logReq(req, {
    action: 'team.grant_refused',
    resourceType: 'team',
    resourceId: team.id,
    details: { name: team.name, reason, ...details },
  });
  throw new ScopeRefusal(reason, TEAM_REFUSAL_MESSAGES[reason]);
}

/** The actor's own team-derived level on each target (group / site of the tenant). */
async function actorLevelsFor(actor: ScopeActor, targets: readonly { scope: TeamPermissionScope; scopeId: number }[]): Promise<Map<string, PermissionLevel>> {
  return actorTeamLevels(actor, targets);
}

async function teamRows(teamId: number): Promise<TeamGrant[]> {
  return (await db('team_permissions')
    .where({ team_id: teamId })
    .whereIn('scope', ['group', 'site'])
    .select('scope', 'scope_id', 'level') as Array<{ scope: TeamPermissionScope; scope_id: number; level: PermissionLevel }>)
    .map((r) => ({ scope: r.scope, scopeId: Number(r.scope_id), level: r.level }));
}

async function isTeamMember(teamId: number, userId: number): Promise<boolean> {
  return !!(await db('team_memberships').where({ team_id: teamId, user_id: userId }).first('user_id'));
}

export const teamScope = {
  /** True when the actor bypasses these checks (platform admin or tenant admin). */
  async hasFullAccess(actor: ScopeActor): Promise<boolean> {
    return permissionService.isFullAccess(actor.userId, actor.tenantId, actor.isPlatformAdmin);
  },

  /** create: canCreate = true needs canCreateRootGroup. */
  async assertCreatable(req: Request, actor: ScopeActor, data: { name: string; canCreate?: boolean }): Promise<void> {
    if (await this.hasFullAccess(actor)) return;
    if (data.canCreate === true && !(await permissionService.canCreateRootGroup(actor.userId, actor.tenantId, false))) {
      await refuseTeam(req, { id: null, name: data.name }, 'can_create_not_held');
    }
  },

  /** update (name, description, canCreate) and delete: not one's own team; canCreate as on create. */
  async assertEditable(
    req: Request,
    actor: ScopeActor,
    team: { id: number; name: string; canCreate: boolean },
    next?: { canCreate?: boolean },
  ): Promise<void> {
    if (await this.hasFullAccess(actor)) return;
    if (await isTeamMember(team.id, actor.userId)) await refuseTeam(req, team, 'own_team');
    if (next?.canCreate === true && !team.canCreate
      && !(await permissionService.canCreateRootGroup(actor.userId, actor.tenantId, false))) {
      await refuseTeam(req, team, 'can_create_not_held');
    }
  },

  /**
   * setMembers: the actor neither joins nor leaves, nor edits a team they
   * are in; adding members needs the team's whole access covered.
   */
  async assertMembers(req: Request, actor: ScopeActor, team: { id: number; name: string }, userIds: readonly number[]): Promise<void> {
    if (await this.hasFullAccess(actor)) return;
    const before = (await db('team_memberships').where({ team_id: team.id }).pluck('user_id') as unknown[]).map(Number);
    const reason = membersRefusal(actor.userId, before, userIds);
    if (reason) await refuseTeam(req, team, reason);

    const added = [...new Set(userIds)].filter((id) => !before.includes(id));
    if (added.length === 0) return;
    const rows = await teamRows(team.id);
    const teamRow = await db('user_teams').where({ id: team.id }).first('can_create') as { can_create: boolean } | undefined;
    const teamCanCreate = !!teamRow?.can_create;
    const refusal = addMembersRefusal({
      added,
      teamRows: rows,
      teamCanCreate,
      actorLevels: await actorLevelsFor(actor, rows),
      actorCanCreate: teamCanCreate
        ? await permissionService.canCreateRootGroup(actor.userId, actor.tenantId, false)
        : false,
    });
    if (refusal) {
      await refuseTeam(req, team, refusal.reason, {
        added: added.slice(0, 50),
        canCreate: teamCanCreate,
        refused: refusal.refused.slice(0, 50).map((p) => ({ scope: p.scope, scopeId: p.scopeId, level: p.level })),
      });
    }
  },

  /**
   * setPermissions: the list to store (rows the actor does not dominate are
   * kept), or a refusal. Full access: the request as sent.
   */
  async resolvePermissions(
    req: Request,
    actor: ScopeActor,
    team: { id: number; name: string },
    requested: readonly TeamGrant[],
  ): Promise<TeamGrant[]> {
    if (await this.hasFullAccess(actor)) return [...requested];
    if (await isTeamMember(team.id, actor.userId)) await refuseTeam(req, team, 'own_team');
    const current = await teamRows(team.id);
    const levels = await actorLevelsFor(actor, [...current, ...requested]);
    const plan = planPermissionReplace(current, requested, levels);
    if (!plan.ok) {
      await refuseTeam(req, team, plan.reason, {
        refused: plan.refused.slice(0, 50).map((p) => ({ scope: p.scope, scopeId: p.scopeId, level: p.level })),
      });
      return [];
    }
    return plan.permissions;
  },

  /** removePermission: the actor covers the removed row and is not in the team. */
  async assertRemovable(req: Request, actor: ScopeActor, team: { id: number; name: string }, row: TeamGrant): Promise<void> {
    if (await this.hasFullAccess(actor)) return;
    if (await isTeamMember(team.id, actor.userId)) await refuseTeam(req, team, 'own_team');
    const levels = await actorLevelsFor(actor, [row]);
    const reason = removalRefusal(levels.get(grantKey(row)), row);
    if (reason) await refuseTeam(req, team, reason, { scope: row.scope, scopeId: row.scopeId, level: row.level });
  },
};
