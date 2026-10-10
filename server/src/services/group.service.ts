import type { Knex } from 'knex';
import { db } from '../db';
import type { MonitorGroup, GroupTreeNode } from '@oblimap/shared';
import { AppError } from '../middleware/errorHandler';

// Every read or write by id takes the tenant and filters on it
// A group of another tenant behaves as if it did not exist.

// Tree changes (create, move, delete) rewrite group_closure in several
// statements. Each runs in one transaction holding this per-tenant advisory
// lock: two concurrent moves cannot both pass the cycle check, and a failure
// never leaves a subtree cut off from its ancestors (which would silently
// drop inherited team permissions). Other code rewriting the closure of a
// tenant (import) should take it too.
const GROUP_TREE_LOCK = 0x4f4d4754; // 'OMGT', first key of the (int, int) lock

export async function lockTenantTree(trx: Knex.Transaction, tenantId: number): Promise<void> {
  await trx.raw('SELECT pg_advisory_xact_lock(?::int, ?::int)', [GROUP_TREE_LOCK, tenantId]);
}

// ── Group delete planning (pure, unit-tested) ──

export interface GroupContentCounts {
  childCount: number;
  siteCount: number;
}

export interface GroupDeletePlan {
  /** New parent of the direct sub-groups and group of the direct sites (null = root / ungrouped). */
  targetParentId: number | null;
  /** Direct sub-groups reparented to targetParentId. */
  movedGroupIds: number[];
  /** Direct sites moved to targetParentId. */
  movedSiteIds: number[];
}

export type GroupDeleteOutcome =
  | { status: 'not_found' }
  | { status: 'not_empty'; childCount: number; siteCount: number }
  | {
    status: 'deleted';
    parentId: number | null;
    movedGroupIds: number[];
    movedSiteIds: number[];
    /** Every site of the deleted group's subtree (before the delete). */
    subtreeSiteIds: number[];
  };

export type GroupDeleteDecision =
  | { ok: true }
  | { ok: false; status: 409; error: 'group_not_empty'; message: string };

function uniqueIds(ids: number[], exclude?: number): number[] {
  return [...new Set(ids.filter((v) => Number.isInteger(v) && v > 0 && v !== exclude))].sort((a, b) => a - b);
}

/**
 * The moves a group delete makes: its direct sub-groups and its sites go to
 * the deleted group's parent (root / ungrouped when it was a root).
 */
export function planGroupDelete(
  group: { id: number; parentId: number | null },
  childGroupIds: number[],
  siteIds: number[],
): GroupDeletePlan {
  const targetParentId = group.parentId !== null && group.parentId !== group.id ? group.parentId : null;
  return {
    targetParentId,
    movedGroupIds: uniqueIds(childGroupIds, group.id),
    movedSiteIds: uniqueIds(siteIds),
  };
}

/**
 * Who may delete a group with content: full access (platform / tenant admin)
 * always; anyone else only an empty group (no sub-group, no site) — a writer
 * must move or delete the content first.
 */
export function groupDeleteDecision(input: { fullAccess: boolean } & GroupContentCounts): GroupDeleteDecision {
  if (input.fullAccess || (input.childCount === 0 && input.siteCount === 0)) return { ok: true };
  return {
    ok: false,
    status: 409,
    error: 'group_not_empty',
    message: 'Move or delete its sites and sub-groups first',
  };
}

interface GroupRow {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  parent_id: number | null;
  sort_order: number;
  is_general: boolean;
  group_notifications: boolean;
  kind: string;
  tenant_id: number;
  agent_thresholds?: unknown;
  agent_group_config?: unknown;
  created_at: Date;
  updated_at: Date;
}

function rowToGroup(row: GroupRow): MonitorGroup {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    parentId: row.parent_id,
    tenantId: row.tenant_id,
    sortOrder: row.sort_order,
    isGeneral: row.is_general,
    groupNotifications: row.group_notifications,
    kind: (row.kind as MonitorGroup['kind']) || 'monitor',
    agentThresholds: row.agent_thresholds
      ? (typeof row.agent_thresholds === 'string' ? JSON.parse(row.agent_thresholds) : row.agent_thresholds)
      : null,
    agentGroupConfig: row.agent_group_config
      ? (typeof row.agent_group_config === 'string' ? JSON.parse(row.agent_group_config) : row.agent_group_config)
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Slugs are unique per tenant (unique (slug, tenant_id), migration 004).
async function ensureUniqueSlug(
  slug: string,
  tenantId: number,
  excludeId?: number,
  conn: Knex | Knex.Transaction = db,
): Promise<string> {
  let candidate = slug;
  let i = 1;
  while (true) {
    const q = conn('monitor_groups').where({ slug: candidate, tenant_id: tenantId });
    if (excludeId) q.whereNot({ id: excludeId });
    const exists = await q.first();
    if (!exists) return candidate;
    candidate = `${slug}-${i++}`;
  }
}

function buildTree(groupMap: Map<number, GroupTreeNode>): GroupTreeNode[] {
  const roots: GroupTreeNode[] = [];
  for (const node of groupMap.values()) {
    if (node.parentId && groupMap.has(node.parentId)) {
      groupMap.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export const groupService = {
  async getAll(tenantId: number): Promise<MonitorGroup[]> {
    const rows = await db<GroupRow>('monitor_groups').where({ tenant_id: tenantId }).orderBy('sort_order').orderBy('name');
    return rows.map(rowToGroup);
  },

  async getById(id: number, tenantId: number): Promise<MonitorGroup | null> {
    const row = await db<GroupRow>('monitor_groups').where({ id, tenant_id: tenantId }).first();
    return row ? rowToGroup(row) : null;
  },

  async create(data: {
    name: string;
    description?: string | null;
    parentId?: number | null;
    sortOrder?: number;
    isGeneral?: boolean;
    groupNotifications?: boolean;
    kind?: 'monitor' | 'agent';
  }, tenantId: number): Promise<MonitorGroup> {
    return db.transaction(async (trx) => {
      await lockTenantTree(trx, tenantId);

      // The parent must be a group of the same tenant: a cross-tenant parent
      // would link the new group into another tenant's closure chain.
      if (data.parentId) {
        const parent = await trx('monitor_groups').where({ id: data.parentId, tenant_id: tenantId }).first('id');
        if (!parent) throw new AppError(400, 'Parent group not found');
      }

      const slug = await ensureUniqueSlug(slugify(data.name), tenantId, undefined, trx);

      const [row] = await trx<GroupRow>('monitor_groups')
        .insert({
          name: data.name,
          slug,
          description: data.description ?? null,
          parent_id: data.parentId ?? null,
          sort_order: data.sortOrder ?? 0,
          is_general: data.isGeneral ?? false,
          group_notifications: data.groupNotifications ?? false,
          kind: data.kind ?? 'monitor',
          tenant_id: tenantId,
        })
        .returning('*');

      // Maintain closure table
      // Self-reference (depth 0)
      await trx('group_closure').insert({
        ancestor_id: row.id,
        descendant_id: row.id,
        depth: 0,
      });

      // Copy ancestor paths from parent
      if (data.parentId) {
        await trx.raw(
          `INSERT INTO group_closure (ancestor_id, descendant_id, depth)
           SELECT gc.ancestor_id, ?, gc.depth + 1
           FROM group_closure gc
           WHERE gc.descendant_id = ?`,
          [row.id, data.parentId],
        );
      }

      return rowToGroup(row);
    });
  },

  async update(
    id: number,
    tenantId: number,
    data: {
      name?: string;
      description?: string | null;
      sortOrder?: number;
      isGeneral?: boolean;
      groupNotifications?: boolean;
    },
  ): Promise<MonitorGroup | null> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };

    if (data.name !== undefined) {
      updateData.name = data.name;
      updateData.slug = await ensureUniqueSlug(slugify(data.name), tenantId, id);
    }
    if (data.description !== undefined) updateData.description = data.description;
    if (data.sortOrder !== undefined) updateData.sort_order = data.sortOrder;
    if (data.isGeneral !== undefined) updateData.is_general = data.isGeneral;
    if (data.groupNotifications !== undefined) updateData.group_notifications = data.groupNotifications;

    const [row] = await db<GroupRow>('monitor_groups')
      .where({ id, tenant_id: tenantId })
      .update(updateData)
      .returning('*');

    return row ? rowToGroup(row) : null;
  },

  async move(id: number, tenantId: number, newParentId: number | null): Promise<MonitorGroup | null> {
    // One transaction under the tenant's tree lock: the cycle check and the
    // closure rewrite see (and leave) a consistent tree.
    return db.transaction(async (trx) => {
      await lockTenantTree(trx, tenantId);

      // Get current group
      const group = await trx<GroupRow>('monitor_groups').where({ id, tenant_id: tenantId }).first();
      if (!group) return null;

      if (newParentId !== null) {
        // The new parent must be a group of the same tenant.
        const parent = await trx('monitor_groups').where({ id: newParentId, tenant_id: tenantId }).first('id');
        if (!parent) throw new AppError(400, 'Parent group not found');

        // Prevent circular reference: newParentId must not be the group itself
        // or one of its descendants (closure self-row covers the first case).
        const isDescendant = await trx('group_closure')
          .where({ ancestor_id: id, descendant_id: newParentId })
          .first();
        if (isDescendant) {
          throw new AppError(400, 'Cannot move group into its own descendant');
        }
      }

      // Get all descendants of the subtree (including self)
      const subtreeIds = await trx('group_closure')
        .where({ ancestor_id: id })
        .select('descendant_id');
      const descIds = subtreeIds.map((r) => r.descendant_id);

      // Remove all closure entries where ancestor is NOT in the subtree
      // but descendant IS in the subtree (these are the "outside" links)
      await trx('group_closure')
        .whereIn('descendant_id', descIds)
        .whereNotIn('ancestor_id', descIds)
        .del();

      // Reconnect: for each ancestor of newParent, create links to every node in subtree
      if (newParentId !== null) {
        await trx.raw(
          `INSERT INTO group_closure (ancestor_id, descendant_id, depth)
           SELECT p.ancestor_id, s.descendant_id, p.depth + s.depth + 1
           FROM group_closure p
           CROSS JOIN group_closure s
           WHERE p.descendant_id = ?
             AND s.ancestor_id = ?`,
          [newParentId, id],
        );
      }

      // Update the parent_id column
      const [row] = await trx<GroupRow>('monitor_groups')
        .where({ id, tenant_id: tenantId })
        .update({ parent_id: newParentId, updated_at: new Date() })
        .returning('*');

      return row ? rowToGroup(row) : null;
    });
  },

  /** Direct sub-groups and direct sites of a group of the tenant. */
  async getContentCounts(id: number, tenantId: number, conn: Knex | Knex.Transaction = db): Promise<GroupContentCounts> {
    const [children, sites] = await Promise.all([
      conn('monitor_groups').where({ parent_id: id, tenant_id: tenantId }).count<{ count: string | number }[]>('* as count'),
      conn('sites').where({ group_id: id, tenant_id: tenantId }).count<{ count: string | number }[]>('* as count'),
    ]);
    return {
      childCount: Number(children[0]?.count ?? 0),
      siteCount: Number(sites[0]?.count ?? 0),
    };
  },

  /**
   * Deletes a group without orphaning its content: its
   * direct sub-groups and sites move to its parent (root / ungrouped when it
   * was a root), and the moved subtrees' closure rows are rebuilt the way
   * move() does, so a team permission on a former ancestor keeps reaching
   * them. The grants, settings and notification bindings of the group itself
   * (no FK on scope_id) are dropped.
   *
   * requireEmpty: refuse (status 'not_empty') when the group still has
   * sub-groups or sites. Sub-groups cannot appear meanwhile (create / move
   * take the tree lock); sites cannot either, because the group row is locked
   * FOR UPDATE, which conflicts with the FOR KEY SHARE lock a site insert /
   * update referencing it takes: such a writer either committed before the
   * read below (its site is seen) or waits and then fails on the FK.
   */
  async delete(id: number, tenantId: number, opts: { requireEmpty?: boolean } = {}): Promise<GroupDeleteOutcome> {
    return db.transaction(async (trx): Promise<GroupDeleteOutcome> => {
      await lockTenantTree(trx, tenantId);

      const group = await trx('monitor_groups').where({ id, tenant_id: tenantId }).forUpdate().first('id', 'parent_id');
      if (!group) return { status: 'not_found' };

      const childGroupIds: number[] = (await trx('monitor_groups')
        .where({ parent_id: id, tenant_id: tenantId })
        .pluck('id')).map(Number);
      const directSiteIds: number[] = (await trx('sites')
        .where({ group_id: id, tenant_id: tenantId })
        .pluck('id')).map(Number);

      if (opts.requireEmpty) {
        const decision = groupDeleteDecision({
          fullAccess: false,
          childCount: childGroupIds.length,
          siteCount: directSiteIds.length,
        });
        if (!decision.ok) {
          return { status: 'not_empty', childCount: childGroupIds.length, siteCount: directSiteIds.length };
        }
      }

      // Every site of the subtree (its inherited settings and device-check
      // rules change), read before the closure is rewritten.
      const subtreeSiteIds: number[] = (await trx('sites')
        .where('tenant_id', tenantId)
        .whereIn('group_id', trx('group_closure').where({ ancestor_id: id }).select('descendant_id'))
        .pluck('id')).map(Number);

      const plan = planGroupDelete(
        { id: Number(group.id), parentId: group.parent_id === null ? null : Number(group.parent_id) },
        childGroupIds,
        directSiteIds,
      );

      // Reparent each direct child's subtree, as move() does: drop the links
      // from outside the subtree (the deleted group and its ancestors), then
      // link every ancestor of the new parent (itself included) to every node
      // of the subtree.
      for (const childId of plan.movedGroupIds) {
        const descIds: number[] = (await trx('group_closure')
          .where({ ancestor_id: childId })
          .pluck('descendant_id')).map(Number);
        if (descIds.length === 0) continue;

        await trx('group_closure')
          .whereIn('descendant_id', descIds)
          .whereNotIn('ancestor_id', descIds)
          .del();

        if (plan.targetParentId !== null) {
          await trx.raw(
            `INSERT INTO group_closure (ancestor_id, descendant_id, depth)
             SELECT p.ancestor_id, s.descendant_id, p.depth + s.depth + 1
             FROM group_closure p
             CROSS JOIN group_closure s
             WHERE p.descendant_id = ?
               AND s.ancestor_id = ?`,
            [plan.targetParentId, childId],
          );
        }
      }

      if (plan.movedGroupIds.length > 0) {
        await trx('monitor_groups')
          .where('tenant_id', tenantId)
          .whereIn('id', plan.movedGroupIds)
          .update({ parent_id: plan.targetParentId, updated_at: new Date() });
      }
      if (plan.movedSiteIds.length > 0) {
        await trx('sites')
          .where('tenant_id', tenantId)
          .whereIn('id', plan.movedSiteIds)
          .update({ group_id: plan.targetParentId, updated_at: new Date() });
      }

      // scope_id has no FK on these tables: drop the rows of this group.
      await trx('team_permissions').where({ scope: 'group', scope_id: id }).del();
      await trx('settings').where({ scope: 'group', scope_id: id, tenant_id: tenantId }).del();
      await trx('notification_bindings').where({ scope: 'group', scope_id: id, tenant_id: tenantId }).del();

      // Remaining closure rows of the group itself (its self row) cascade.
      const count = await trx('monitor_groups').where({ id, tenant_id: tenantId }).del();
      // Throw (not return) so the moves above roll back.
      if (count === 0) throw new AppError(404, 'Group not found');

      return {
        status: 'deleted',
        parentId: plan.targetParentId,
        movedGroupIds: plan.movedGroupIds,
        movedSiteIds: plan.movedSiteIds,
        subtreeSiteIds,
      };
    });
  },

  // ── Tree queries using closure table ──

  async getAncestors(groupId: number): Promise<MonitorGroup[]> {
    const rows = await db<GroupRow>('monitor_groups')
      .join('group_closure', 'monitor_groups.id', 'group_closure.ancestor_id')
      .where('group_closure.descendant_id', groupId)
      .where('group_closure.depth', '>', 0)
      .orderBy('group_closure.depth', 'desc')
      .select('monitor_groups.*');
    return rows.map(rowToGroup);
  },

  /**
   * Site / device counters of every group of the tenant (its subtree's sites
   * included) in one aggregate query over group_closure. visibleSiteIds
   * limits the counted sites; groups without a counted site are absent.
   */
  async getSubtreeStats(
    tenantId: number,
    visibleSiteIds: number[] | 'all' = 'all',
  ): Promise<Map<number, { siteCount: number; total: number; online: number; offline: number }>> {
    const result = new Map<number, { siteCount: number; total: number; online: number; offline: number }>();
    if (visibleSiteIds !== 'all' && visibleSiteIds.length === 0) return result;

    // One row per (ancestor, site): a site is counted once per group of its
    // ancestor chain, never twice for the same group.
    const rows = await db('group_closure as gc')
      .join('monitor_groups as g', 'g.id', 'gc.ancestor_id')
      .join('sites as s', 's.group_id', 'gc.descendant_id')
      .leftJoin(
        db('site_items')
          .select('site_id')
          .select(db.raw('COUNT(*) as item_count'))
          .select(db.raw("COUNT(*) FILTER (WHERE status = 'online') as online_count"))
          .select(db.raw("COUNT(*) FILTER (WHERE status = 'offline') as offline_count"))
          .where('tenant_id', tenantId)
          .groupBy('site_id')
          .as('ic'),
        's.id', 'ic.site_id',
      )
      .where('g.tenant_id', tenantId)
      .where('s.tenant_id', tenantId)
      .modify((q) => {
        if (visibleSiteIds !== 'all') q.whereIn('s.id', visibleSiteIds);
      })
      .groupBy('gc.ancestor_id')
      .select(
        'gc.ancestor_id as group_id',
        db.raw('COUNT(DISTINCT s.id)::int as site_count'),
        db.raw('COALESCE(SUM(ic.item_count), 0)::int as total'),
        db.raw('COALESCE(SUM(ic.online_count), 0)::int as online_count'),
        db.raw('COALESCE(SUM(ic.offline_count), 0)::int as offline_count'),
      );

    for (const row of rows as Array<Record<string, unknown>>) {
      result.set(Number(row.group_id), {
        siteCount: Number(row.site_count ?? 0),
        total: Number(row.total ?? 0),
        online: Number(row.online_count ?? 0),
        offline: Number(row.offline_count ?? 0),
      });
    }
    return result;
  },

  async getDescendantIds(groupId: number): Promise<number[]> {
    const rows = await db('group_closure')
      .where({ ancestor_id: groupId })
      .select('descendant_id');
    return rows.map((r) => r.descendant_id);
  },

  async getChildren(parentId: number | null): Promise<MonitorGroup[]> {
    const query = db<GroupRow>('monitor_groups').orderBy('sort_order').orderBy('name');
    if (parentId === null) {
      query.whereNull('parent_id');
    } else {
      query.where({ parent_id: parentId });
    }
    const rows = await query;
    return rows.map(rowToGroup);
  },

  /**
   * Group tree of the tenant with its sites. visibleSiteIds (from
   * permissionService.getVisibleSiteIds) limits the sites listed under the
   * groups; the caller filters the groups themselves.
   */
  async getTree(tenantId: number, visibleSiteIds: number[] | 'all' = 'all'): Promise<GroupTreeNode[]> {
    const allGroups = await this.getAll(tenantId);
    const groupMap = new Map<number, GroupTreeNode>();

    // Initialize nodes
    for (const g of allGroups) {
      groupMap.set(g.id, { ...g, children: [], monitors: [], sites: [], depth: 0 });
    }

    // Fetch site summaries with counts
    if (visibleSiteIds !== 'all' && visibleSiteIds.length === 0) return buildTree(groupMap);
    const siteRows = await db('sites as s')
      .where('s.tenant_id', tenantId)
      .whereNotNull('s.group_id')
      .modify((q) => {
        if (visibleSiteIds !== 'all') q.whereIn('s.id', visibleSiteIds);
      })
      .leftJoin(
        db('site_items')
          .select('site_id')
          .count('* as item_count')
          .where('tenant_id', tenantId)
          .groupBy('site_id')
          .as('ic'),
        's.id', 'ic.site_id',
      )
      .leftJoin(
        db('site_items')
          .select('site_id')
          .count('* as online_count')
          .where({ tenant_id: tenantId, status: 'online' })
          .groupBy('site_id')
          .as('oc'),
        's.id', 'oc.site_id',
      )
      .leftJoin(
        db('site_items')
          .select('site_id')
          .count('* as offline_count')
          .where({ tenant_id: tenantId, status: 'offline' })
          .groupBy('site_id')
          .as('ofc'),
        's.id', 'ofc.site_id',
      )
      .leftJoin(
        db('probes')
          .select('site_id')
          .count('* as probe_count')
          .where({ tenant_id: tenantId, status: 'approved' })
          .whereNotNull('site_id')
          .groupBy('site_id')
          .as('pc'),
        's.id', 'pc.site_id',
      )
      .select(
        's.id',
        's.name',
        's.group_id',
        db.raw('COALESCE(ic.item_count, 0)::int as item_count'),
        db.raw('COALESCE(oc.online_count, 0)::int as online_count'),
        db.raw('COALESCE(ofc.offline_count, 0)::int as offline_count'),
        db.raw('COALESCE(pc.probe_count, 0)::int as probe_count'),
      )
      .orderBy('s.name', 'asc');

    for (const row of siteRows) {
      const groupNode = groupMap.get(row.group_id as number);
      if (groupNode) {
        groupNode.sites!.push({
          id: row.id as number,
          name: row.name as string,
          itemCount: Number(row.item_count),
          onlineCount: Number(row.online_count),
          offlineCount: Number(row.offline_count),
          probeCount: Number(row.probe_count),
        });
      }
    }

    return buildTree(groupMap);
  },

  /**
   * Batch-update sortOrder for multiple groups at once. Only groups of the
   * tenant are touched; returns the number of groups updated.
   */
  async reorder(tenantId: number, items: { id: number; sortOrder: number }[]): Promise<number> {
    return db.transaction(async (trx) => {
      let updated = 0;
      for (const item of items) {
        updated += await trx('monitor_groups')
          .where({ id: item.id, tenant_id: tenantId })
          .update({ sort_order: item.sortOrder, updated_at: new Date() });
      }
      return updated;
    });
  },

  /**
   * Find the nearest ancestor (or self) with group_notifications = true.
   * Uses the closure table, ordered by depth ASC (self = depth 0 first).
   * Returns the group if found, null otherwise.
   */
  async findGroupNotificationAncestor(groupId: number): Promise<MonitorGroup | null> {
    const row = await db<GroupRow>('monitor_groups')
      .join('group_closure', 'monitor_groups.id', 'group_closure.ancestor_id')
      .where('group_closure.descendant_id', groupId)
      .where('monitor_groups.group_notifications', true)
      .orderBy('group_closure.depth', 'asc')
      .first('monitor_groups.*');
    return row ? rowToGroup(row) : null;
  },
};
