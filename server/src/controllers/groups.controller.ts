import type { Request, Response, NextFunction } from 'express';
import type { Knex } from 'knex';
import { db } from '../db';
import { groupService, groupDeleteDecision } from '../services/group.service';
import { permissionService } from '../services/permission.service';
import { teamService } from '../services/team.service';
import { groupNotificationService } from '../services/groupNotification.service';
import { auditService } from '../services/audit.service';
import { clearRealtimeReadCacheForTenant, emitTreeChanged } from '../services/realtime.service';
import { probeLiveState } from '../services/probe.service';
import { AppError } from '../middleware/errorHandler';
import { requireDbId } from '../utils/dbId';
import { SOCKET_EVENTS } from '@oblimap/shared';
import {
  invalidateSiteCheckSettings,
  invalidateTenantCaches,
  pushConfigToAffectedProbes,
  scopeSiteIds,
} from '../services/deviceChecks/config.service';
import { logger } from '../utils/logger';
import type {
  CreateGroupInput,
  UpdateGroupInput,
  MoveGroupInput,
  ReorderGroupsInput,
} from '../validators/group.schema';

// Groups of the current tenant only: every lookup by id goes
// through groupService with req.tenantId, so another tenant's group is a 404.
// Reads are filtered by the user's team permissions; platform
// admins and tenant admins see the whole tenant. The group page (getById,
// detail-stats, probes) opens for every group of the user's tree
// (permissionService.canViewGroup), site data is always limited to the
// sites they may read.

interface Viewer {
  userId: number;
  tenantId: number;
  isPlatformAdmin: boolean;
  /** Platform admin or admin of the tenant. */
  fullAccess: boolean;
}

async function viewerOf(req: Request): Promise<Viewer> {
  const userId = req.session.userId!;
  const tenantId = req.tenantId;
  const isPlatformAdmin = req.session.role === 'admin';
  const fullAccess = await permissionService.isFullAccess(userId, tenantId, isPlatformAdmin);
  return { userId, tenantId, isPlatformAdmin, fullAccess };
}

/**
 * Group events (with the group's name) go to the admins of the group's
 * tenant only. The other members get the payload-free
 * TREE_CHANGED and refetch the tree, which the server filters for them.
 */
function emitGroupEvent(req: Request, event: string, payload: unknown): void {
  const io = req.app.get('io');
  if (io) io.to(`tenant:${req.tenantId}:admin`).emit(event, payload);
  emitTreeChanged(req.tenantId);
}

/**
 * After a reparent: the rules of the old and new ancestor groups, and the
 * inherited deviceChecksEnabled / businessHours, change for every site of the
 * moved subtree. Drops the cached site settings and re-sends the Device
 * Checks assignment to the connected probes of those sites. Not awaited;
 * never throws.
 */
function refreshDeviceChecksForSubtree(tenantId: number, groupId: number): void {
  invalidateSiteCheckSettings(tenantId);
  scopeSiteIds(tenantId, { groupId, siteId: null })
    .then((siteIds) => pushConfigToAffectedProbes(tenantId, siteIds))
    .catch((err: unknown) =>
      logger.warn({ err: (err as Error)?.message, tenantId, groupId }, 'Device checks config push after a group move failed'));
}

/**
 * After a group delete: drops the tenant's device-check caches and re-sends the
 * Device Checks assignment to the connected probes of the given sites. Not
 * awaited; never throws.
 */
function refreshDeviceChecksForSites(tenantId: number, siteIds: number[]): void {
  // The group's own rules went with it (FK cascade): drop the rules /
  // assignment caches too, even when no site is affected.
  invalidateTenantCaches(tenantId);
  if (siteIds.length === 0) return;
  pushConfigToAffectedProbes(tenantId, siteIds)
    .catch((err: unknown) =>
      logger.warn({ err: (err as Error)?.message, tenantId }, 'Device checks config push after a group delete failed'));
}

/** Restricts a sites query to the visible sites ('all': no restriction). */
function limitToSites(q: Knex.QueryBuilder, column: string, siteIds: number[] | 'all'): void {
  if (siteIds !== 'all') q.whereIn(column, siteIds);
}

export const groupsController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const viewer = await viewerOf(req);
      const allGroups = await groupService.getAll(viewer.tenantId);

      if (viewer.fullAccess) {
        res.json({ success: true, data: allGroups });
        return;
      }

      const visibleIds = await permissionService.getVisibleGroupIds(viewer.userId, viewer.tenantId, false);
      if (visibleIds === 'all') {
        res.json({ success: true, data: allGroups });
        return;
      }

      const visibleSet = new Set(visibleIds);
      const filtered = allGroups.filter((g) => visibleSet.has(g.id));
      res.json({ success: true, data: filtered });
    } catch (err) {
      next(err);
    }
  },

  async tree(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const viewer = await viewerOf(req);
      if (viewer.fullAccess) {
        res.json({ success: true, data: await groupService.getTree(viewer.tenantId) });
        return;
      }

      // Sidebar tree: only the sites the user may read, and only the groups
      // they may see (permitted groups, their ancestors, general groups).
      const [visibleSiteIds, visibleIds] = await Promise.all([
        permissionService.getVisibleSiteIds(viewer.userId, viewer.tenantId, false),
        permissionService.getVisibleGroupIds(viewer.userId, viewer.tenantId, false),
      ]);
      const tree = await groupService.getTree(viewer.tenantId, visibleSiteIds);
      if (visibleIds === 'all') {
        res.json({ success: true, data: tree });
        return;
      }

      const visibleSet = new Set(visibleIds);
      function filterTree(nodes: typeof tree): typeof tree {
        return nodes
          .filter((n) => visibleSet.has(n.id))
          .map((n) => ({ ...n, children: filterTree(n.children) }));
      }
      res.json({ success: true, data: filterTree(tree) });
    } catch (err) {
      next(err);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'group ID');
      const group = await groupService.getById(id, req.tenantId);
      if (!group) throw new AppError(404, 'Group not found');

      // Any group shown in the user's tree, including an ancestor shown only
      // for navigation: the row is what the tree already carries.
      const canView = await permissionService.canViewGroup(
        req.session.userId!, id, req.tenantId, req.session.role === 'admin',
      );
      if (!canView) throw new AppError(403, 'Access denied');

      res.json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateGroupInput;
      const viewer = await viewerOf(req);

      // The parent (if any) must be a group of this tenant (400 otherwise,
      // also checked by groupService.create); non-admins need write
      // permission on it, as for a move into it.
      if (data.parentId && !viewer.fullAccess) {
        if (!(await permissionService.findGroup(data.parentId, viewer.tenantId))) {
          throw new AppError(400, 'Parent group not found');
        }
        const canWriteParent = await permissionService.canWriteGroup(viewer.userId, data.parentId, viewer.tenantId, false);
        if (!canWriteParent) throw new AppError(403, 'No write permission on parent group');
      }
      // A general group is shown to every member of the tenant (its sites
      // still need a team permission): only admins may publish one.
      if (data.isGeneral && !viewer.fullAccess) {
        throw new AppError(403, 'Only admins can create a general group');
      }

      const group = await groupService.create(data, req.tenantId);

      // Auto-assign RW to the creator's can_create teams — teams of THIS
      // tenant only: a team of another tenant never gets a
      // grant on this tenant's group.
      if (req.session.role !== 'admin') {
        const userTeams = await teamService.getUserTeams(req.session.userId!, req.tenantId);
        for (const team of userTeams) {
          if (team.canCreate && team.tenantId === req.tenantId) {
            await teamService.addPermission(team.id, 'group', group.id, 'rw');
          }
        }
      }

      emitGroupEvent(req, SOCKET_EVENTS.GROUP_CREATED, { group });

      await auditService.logReq(req, {
        action: 'group.created',
        resourceType: 'group',
        resourceId: group.id,
        details: { name: group.name, parentId: group.parentId ?? null },
      });

      res.status(201).json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'group ID');
      const data = req.body as UpdateGroupInput;

      const existing = await groupService.getById(id, req.tenantId);
      if (!existing) throw new AppError(404, 'Group not found');
      // Turning the general flag on / off changes who can read the group:
      // admins only (the edit forms send the unchanged value, which is fine).
      if (data.isGeneral !== undefined && data.isGeneral !== (existing.isGeneral ?? false)) {
        const viewer = await viewerOf(req);
        if (!viewer.fullAccess) throw new AppError(403, 'Only admins can change the general flag');
      }

      const group = await groupService.update(id, req.tenantId, data);

      if (!group) throw new AppError(404, 'Group not found');

      if (data.groupNotifications !== undefined) {
        groupNotificationService.removeGroup(id);
      }

      emitGroupEvent(req, SOCKET_EVENTS.GROUP_UPDATED, { group });

      await auditService.logReq(req, {
        action: 'group.updated',
        resourceType: 'group',
        resourceId: id,
        details: { name: group.name, fields: Object.keys(data) },
      });

      res.json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async move(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'group ID');
      const { newParentId } = req.body as MoveGroupInput;
      const userId = req.session.userId!;
      const isPlatformAdmin = req.session.role === 'admin';

      const existing = await groupService.getById(id, req.tenantId);
      if (!existing) throw new AppError(404, 'Group not found');

      // The target parent must be a group of this tenant, and non-admins
      // need write permission on it too.
      if (newParentId !== null) {
        const parent = await permissionService.findGroup(newParentId, req.tenantId);
        if (!parent) throw new AppError(400, 'Parent group not found');
        const canWriteTarget = await permissionService.canWriteGroup(userId, newParentId, req.tenantId, isPlatformAdmin);
        if (!canWriteTarget) throw new AppError(403, 'No write permission on target group');
      } else {
        // A top-level group is reachable only by admins and the teams granted
        // on it: a member whose rw comes from an ancestor would detach the
        // subtree out of everyone's reach but the admins'.
        const fullAccess = await permissionService.isFullAccess(userId, req.tenantId, isPlatformAdmin);
        if (!fullAccess) throw new AppError(403, 'Only an administrator can make a group top-level');
      }

      const group = await groupService.move(id, req.tenantId, newParentId);
      if (!group) throw new AppError(404, 'Group not found');

      // A subtree move changes who reads its sites: later site events
      // recompute their readers.
      clearRealtimeReadCacheForTenant(req.tenantId);
      emitGroupEvent(req, SOCKET_EVENTS.GROUP_MOVED, { group });
      refreshDeviceChecksForSubtree(req.tenantId, id);

      await auditService.logReq(req, {
        action: 'group.moved',
        resourceType: 'group',
        resourceId: id,
        details: { name: group.name, fromParentId: existing.parentId ?? null, toParentId: newParentId },
      });

      res.json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'group ID');

      const existing = await groupService.getById(id, req.tenantId);
      if (!existing) throw new AppError(404, 'Group not found');

      // The content of a deleted group moves to its parent. Admins may delete
      // a non-empty group; other writers must empty it first, so a
      // writer never reshapes a subtree it does not fully see. Pre-checked
      // here for the answer, re-checked under the tree lock by the service.
      const viewer = await viewerOf(req);
      if (!viewer.fullAccess) {
        const decision = groupDeleteDecision({
          fullAccess: false,
          ...(await groupService.getContentCounts(id, viewer.tenantId)),
        });
        if (!decision.ok) {
          res.status(decision.status).json({ success: false, error: decision.error, message: decision.message });
          return;
        }
      }

      const outcome = await groupService.delete(id, req.tenantId, { requireEmpty: !viewer.fullAccess });
      if (outcome.status === 'not_found') throw new AppError(404, 'Group not found');
      if (outcome.status === 'not_empty') {
        // Content added between the pre-check and the delete.
        res.status(409).json({
          success: false,
          error: 'group_not_empty',
          message: 'Move or delete its sites and sub-groups first',
        });
        return;
      }

      groupNotificationService.removeGroup(id);

      // Moved sites change readers (ancestor grants), inherited settings and
      // device-check rules (the group's own rules cascade with it).
      clearRealtimeReadCacheForTenant(req.tenantId);
      refreshDeviceChecksForSites(req.tenantId, outcome.subtreeSiteIds);

      emitGroupEvent(req, SOCKET_EVENTS.GROUP_DELETED, { groupId: id });

      await auditService.logReq(req, {
        action: 'group.deleted',
        resourceType: 'group',
        resourceId: id,
        details: {
          name: existing.name,
          parentId: outcome.parentId,
          movedGroupIds: outcome.movedGroupIds,
          movedSiteIds: outcome.movedSiteIds,
        },
      });

      res.json({ success: true, message: 'Group deleted' });
    } catch (err) {
      next(err);
    }
  },

  async stats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const viewer = await viewerOf(req);
      const tenantId = viewer.tenantId;
      let groups = await groupService.getAll(tenantId);
      let siteIds: number[] | 'all' = 'all';

      // Non-admins: only the groups they may see, counting only the sites
      // they may read.
      if (!viewer.fullAccess) {
        const [visibleGroupIds, visibleSiteIds] = await Promise.all([
          permissionService.getVisibleGroupIds(viewer.userId, tenantId, false),
          permissionService.getVisibleSiteIds(viewer.userId, tenantId, false),
        ]);
        if (visibleGroupIds !== 'all') {
          const visibleSet = new Set(visibleGroupIds);
          groups = groups.filter((g) => visibleSet.has(g.id));
        }
        siteIds = visibleSiteIds;
      }

      const result: Record<number, { uptimePct: number; total: number; up: number; siteCount: number; onlineCount: number; offlineCount: number }> = {};

      // One aggregate query for every group, not two per group.
      const stats = await groupService.getSubtreeStats(tenantId, siteIds);

      for (const group of groups) {
        const s = stats.get(group.id);
        const total = s?.total ?? 0;
        const online = s?.online ?? 0;
        const offline = s?.offline ?? 0;
        const siteCount = s?.siteCount ?? 0;
        const uptimePct = total > 0 ? Math.round((online / total) * 100) : 100;

        result[group.id] = { total, up: online, uptimePct, siteCount, onlineCount: online, offlineCount: offline };
      }

      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },

  async reorder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { items } = req.body as ReorderGroupsInput;
      // Groups of other tenants are ignored (filtered on tenant_id).
      const updated = await groupService.reorder(req.tenantId, items);

      emitGroupEvent(req, SOCKET_EVENTS.GROUP_REORDERED, { items });

      await auditService.logReq(req, {
        action: 'group.reordered',
        resourceType: 'group',
        details: { count: updated },
      });

      res.json({ success: true, message: 'Groups reordered' });
    } catch (err) {
      next(err);
    }
  },

  // IPAM mode: real site/device stats for this group (replaces dummy heartbeat stats)
  async groupDetailStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = requireDbId(req.params.id, 'group ID');
      const viewer = await viewerOf(req);
      const tenantId = viewer.tenantId;
      const group = await groupService.getById(groupId, tenantId);
      if (!group) throw new AppError(404, 'Group not found');

      // Groups shown in the tree only for navigation are allowed too: the
      // counts only cover the sites the user may read.
      let siteIds: number[] | 'all' = 'all';
      if (!viewer.fullAccess) {
        const canView = await permissionService.canViewGroup(viewer.userId, groupId, tenantId, false);
        if (!canView) throw new AppError(403, 'Access denied');
        siteIds = await permissionService.getVisibleSiteIds(viewer.userId, tenantId, false);
      }

      const descendantIds = await groupService.getDescendantIds(groupId);

      const row = await db('sites')
        .where('tenant_id', tenantId)
        .whereIn('group_id', descendantIds)
        .modify((q) => limitToSites(q, 'sites.id', siteIds))
        .leftJoin(
          db('site_items')
            .select('site_id')
            .count('* as item_count')
            .where('tenant_id', tenantId)
            .groupBy('site_id')
            .as('ic'),
          'sites.id', 'ic.site_id',
        )
        .leftJoin(
          db('site_items')
            .select('site_id')
            .count('* as online_count')
            .where({ tenant_id: tenantId, status: 'online' })
            .groupBy('site_id')
            .as('oc'),
          'sites.id', 'oc.site_id',
        )
        .select(
          db.raw('COUNT(DISTINCT sites.id)::int as site_count'),
          db.raw('COALESCE(SUM(ic.item_count), 0)::int as total'),
          db.raw('COALESCE(SUM(oc.online_count), 0)::int as up'),
        )
        .first();

      // Approved probes on the counted sites (as listed by getGroupProbes).
      const probeRow = await db('probes')
        .where({ 'probes.tenant_id': tenantId, 'probes.status': 'approved' })
        .whereIn(
          'probes.site_id',
          db('sites')
            .where('tenant_id', tenantId)
            .whereIn('group_id', descendantIds)
            .modify((q) => limitToSites(q, 'sites.id', siteIds))
            .select('sites.id'),
        )
        .count<{ count: string | number }[]>('* as count');

      const total = Number(row?.total ?? 0);
      const up = Number(row?.up ?? 0);
      const siteCount = Number(row?.site_count ?? 0);
      const probeCount = Number(probeRow[0]?.count ?? 0);
      const uptimePct = total > 0 ? Math.round((up / total) * 100) : 100;

      res.json({ success: true, data: { uptimePct, total, up, siteCount, probeCount } });
    } catch (err) {
      next(err);
    }
  },

  /** GET /groups/:id/probes — list all probes in this group and its sub-groups */
  async getGroupProbes(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = requireDbId(req.params.id, 'group ID');
      const viewer = await viewerOf(req);
      const tenantId = viewer.tenantId;

      const group = await groupService.getById(groupId, tenantId);
      if (!group) throw new AppError(404, 'Group not found');

      // As for detail-stats: any group shown in the tree, listing only the
      // probes of the sites the user may read.
      let visibleSiteIds: number[] | 'all' = 'all';
      if (!viewer.fullAccess) {
        const canView = await permissionService.canViewGroup(viewer.userId, groupId, tenantId, false);
        if (!canView) throw new AppError(403, 'Access denied');
        visibleSiteIds = await permissionService.getVisibleSiteIds(viewer.userId, tenantId, false);
      }

      const descendantIds = await groupService.getDescendantIds(groupId);
      const siteIds: number[] = await db('sites')
        .whereIn('group_id', descendantIds)
        .where('tenant_id', tenantId)
        .modify((q) => limitToSites(q, 'id', visibleSiteIds))
        .pluck('id');

      if (siteIds.length === 0) {
        res.json({ probes: [] });
        return;
      }

      const probes = await db('probes')
        .whereIn('probes.site_id', siteIds)
        .where('probes.tenant_id', tenantId)
        .leftJoin('sites', 'probes.site_id', 'sites.id')
        .select('probes.*', 'sites.name as site_name');

      // Probe network identity (uuid, ip, mac) is for admins only, as on
      // /api/probe/devices.
      const showIdentity = viewer.fullAccess;
      const mapped = probes.map((p: any) => ({
        id: p.id,
        uuid: showIdentity ? p.uuid : null,
        hostname: p.hostname,
        ip: showIdentity ? p.ip : null,
        mac: showIdentity ? p.mac : null,
        name: p.name,
        status: p.status,
        probeVersion: p.probe_version,
        siteId: p.site_id,
        siteName: p.site_name,
        lastSeenAt: p.last_seen_at,
        createdAt: p.created_at,
        // Server liveness verdict (same as /api/probe/devices).
        ...probeLiveState(p),
      }));

      res.json({ probes: mapped });
    } catch (err) {
      next(err);
    }
  },
};
