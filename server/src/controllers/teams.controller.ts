import type { Request, Response, NextFunction } from 'express';
import { teamService } from '../services/team.service';
import { auditService } from '../services/audit.service';
import { emitPermissionsChanged } from '../services/realtime.service';
import { teamScope } from '../services/teamScope.service';
import { actorFromReq, sendScopeError } from '../services/userScope.service';
import { AppError } from '../middleware/errorHandler';
import { requireDbId } from '../utils/dbId';
import type {
  CreateTeamInput,
  UpdateTeamInput,
  SetTeamMembersInput,
  SetTeamPermissionsInput,
} from '../validators/team.schema';

// Teams of the current tenant only: a team of another tenant
// answers 404 like a missing one. To manage another tenant's teams, switch
// to that tenant. Only the list has a read-only cross-tenant view
// (?scope=all, platform admins).
//
// Callers without full access in the tenant (users.manage holders that are
// neither platform nor tenant admins) go through teamScope: never
// their own team, never themselves, never more than their own access.

async function requireTeam(req: Request) {
  const id = requireDbId(req.params.id, 'team ID');
  const team = await teamService.getById(id, req.tenantId);
  if (!team) throw new AppError(404, 'Team not found');
  return team;
}

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof AppError) return false;
  const e = err as { code?: string; message?: string } | null;
  return e?.code === '23505' || (typeof e?.message === 'string' && e.message.includes('unique'));
}

export const teamsController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Platform admins can request all teams across tenants via ?scope=all
      // Otherwise scope to the current tenant from session
      const isPlatformAdmin = req.session.role === 'admin';
      const scopeAll = isPlatformAdmin && req.query.scope === 'all';
      const teams = await teamService.getAll(scopeAll ? null : req.tenantId);
      res.json({ success: true, data: teams });
    } catch (err) {
      next(err);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await requireTeam(req);

      const [members, permissions, eligibleMembers] = await Promise.all([
        teamService.getMembers(team.id),
        teamService.getPermissions(team.id),
        teamService.getEligibleMembers(team.tenantId),
      ]);
      const eligibleMemberIds = eligibleMembers.map((m) => m.id);

      res.json({ success: true, data: { ...team, memberIds: members, permissions, eligibleMemberIds, eligibleMembers } });
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateTeamInput;
      await teamScope.assertCreatable(req, actorFromReq(req), data);
      // Teams are mono-tenant: always the session's tenant.
      const team = await teamService.create(data, req.tenantId);
      await auditService.logReq(req, {
        action: 'team.created',
        resourceType: 'team',
        resourceId: team.id,
        details: { name: team.name, canCreate: team.canCreate },
      });
      res.status(201).json({ success: true, data: team });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        next(new AppError(409, 'Team name already exists'));
      } else {
        sendScopeError(err, res, next);
      }
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const before = await requireTeam(req);
      const id = before.id;
      const data = req.body as UpdateTeamInput;
      await teamScope.assertEditable(req, actorFromReq(req), before, data);
      const team = await teamService.update(id, req.tenantId, data);
      if (!team) throw new AppError(404, 'Team not found');
      // can_create grants group creation: the members' clients refetch their permissions.
      if (before.canCreate !== team.canCreate) {
        emitPermissionsChanged(await teamService.getMembers(team.id));
      }
      await auditService.logReq(req, {
        action: 'team.updated',
        resourceType: 'team',
        resourceId: id,
        details: { name: team.name, fields: Object.keys(data) },
      });
      res.json({ success: true, data: team });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        next(new AppError(409, 'Team name already exists'));
      } else {
        sendScopeError(err, res, next);
      }
    }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await requireTeam(req);
      await teamScope.assertEditable(req, actorFromReq(req), team);
      // Members read before the delete (the memberships go with the team).
      const members = await teamService.getMembers(team.id);
      const deleted = await teamService.delete(team.id, req.tenantId);
      if (!deleted) throw new AppError(404, 'Team not found');
      emitPermissionsChanged(members);
      await auditService.logReq(req, {
        action: 'team.deleted',
        resourceType: 'team',
        resourceId: team.id,
        details: { name: team.name },
      });
      res.json({ success: true, message: 'Team deleted' });
    } catch (err) {
      sendScopeError(err, res, next);
    }
  },

  // ── Members ──

  async getMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await requireTeam(req);
      const members = await teamService.getMembers(team.id);
      res.json({ success: true, data: members });
    } catch (err) {
      next(err);
    }
  },

  async setMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await requireTeam(req);
      const { userIds } = req.body as SetTeamMembersInput;
      await teamScope.assertMembers(req, actorFromReq(req), team, userIds);
      // Only members of the team's tenant (400 otherwise).
      const before = await teamService.setMembers(team.id, req.tenantId, userIds);

      const after = new Set(userIds);
      const beforeSet = new Set(before);
      const added = [...after].filter((id) => !beforeSet.has(id));
      const removed = before.filter((id) => !after.has(id));
      if (added.length > 0 || removed.length > 0) {
        // Old and new members: what they may read / write follows the team.
        emitPermissionsChanged([...before, ...after]);
        await auditService.logReq(req, {
          action: 'team.members_changed',
          resourceType: 'team',
          resourceId: team.id,
          details: { name: team.name, added, removed },
        });
      }
      res.json({ success: true, data: [...after] });
    } catch (err) {
      sendScopeError(err, res, next);
    }
  },

  // ── Permissions ──

  async getPermissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await requireTeam(req);
      const permissions = await teamService.getPermissions(team.id);
      res.json({ success: true, data: permissions });
    } catch (err) {
      next(err);
    }
  },

  async setPermissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await requireTeam(req);
      const { permissions: requested } = req.body as SetTeamPermissionsInput;
      // Without full access: rows the caller does not dominate are kept as
      // they are, and nothing beyond the caller's own access is granted.
      const permissions = await teamScope.resolvePermissions(req, actorFromReq(req), team, requested);
      // scope 'group' | 'site' with scopeIds of the team's tenant (400 otherwise).
      const result = await teamService.setPermissions(team.id, req.tenantId, permissions);
      emitPermissionsChanged(await teamService.getMembers(team.id));
      await auditService.logReq(req, {
        action: 'team.permissions_changed',
        resourceType: 'team',
        resourceId: team.id,
        details: {
          name: team.name,
          permissions: result.map((p) => ({ scope: p.scope, scopeId: p.scopeId, level: p.level })),
        },
      });
      res.json({ success: true, data: result });
    } catch (err) {
      sendScopeError(err, res, next);
    }
  },

  async removePermission(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await requireTeam(req);
      const permId = requireDbId(req.params.permId, 'permission ID');
      const existing = (await teamService.getPermissions(team.id)).find((p) => p.id === permId);
      if (!existing) throw new AppError(404, 'Permission not found');
      await teamScope.assertRemovable(req, actorFromReq(req), team, existing);
      const removed = await teamService.removePermission(team.id, permId);
      if (!removed) throw new AppError(404, 'Permission not found');
      emitPermissionsChanged(await teamService.getMembers(team.id));
      await auditService.logReq(req, {
        action: 'team.permission_removed',
        resourceType: 'team',
        resourceId: team.id,
        details: { name: team.name, scope: removed.scope, scopeId: removed.scopeId, level: removed.level },
      });
      res.json({ success: true, message: 'Permission removed' });
    } catch (err) {
      sendScopeError(err, res, next);
    }
  },
};
