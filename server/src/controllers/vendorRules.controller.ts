import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { auditService } from '../services/audit.service';
import { permissionService } from '../services/permission.service';
import { pushConfigToAffectedProbes } from '../services/deviceChecks/config.service';
import { emitSiteUpdated } from '../services/realtime.service';
import { matchVendorRule, type ScopedVendorRuleRow } from '../services/vendorRuleMatch';
import { logger } from '../utils/logger';
import { requireDbId } from '../utils/dbId';
import type { CreateVendorRuleInput, UpdateVendorRuleInput, BulkCreateVendorRulesInput } from '../validators/vendorRule.schema';
import type { VendorTypeRule, DeviceType, ObservedVendor } from '@oblimap/shared';

// ── re-apply ───────────────────────────────────────────────────

/** POST /vendor-rules/reapply body. */
export const reapplyVendorRulesSchema = z.object({
  scope: z.enum(['tenant', 'group', 'site']),
  id: z.number().int().positive().max(2_147_483_647).optional(),
}).strict().refine((b) => b.scope === 'tenant' ? b.id === undefined : b.id !== undefined, {
  message: "'id' is required for the group and site scopes, and not allowed for the tenant scope",
  path: ['id'],
});

export type ReapplyScope =
  | { scope: 'tenant' }
  | { scope: 'group'; id: number }
  | { scope: 'site'; id: number };

export interface ReapplyResult {
  /** Devices whose type (or source) changed. */
  updated: number;
  /** Devices examined (vendor known, type not set by hand). */
  scanned: number;
}

const SITE_CHUNK = 200;
const UPDATE_CHUNK = 1000;

/** Sites of the scope: id + group. */
async function sitesOfScope(tenantId: number, target: ReapplyScope): Promise<Array<{ id: number; groupId: number | null }>> {
  const q = db('sites').where('tenant_id', tenantId);
  if (target.scope === 'site') {
    q.andWhere('id', target.id);
  } else if (target.scope === 'group') {
    q.whereIn('group_id', db('group_closure').select('descendant_id').where('ancestor_id', target.id));
  }
  const rows = await q.select('id', 'group_id') as Array<{ id: number; group_id: number | null }>;
  return rows.map((r) => ({ id: Number(r.id), groupId: r.group_id != null ? Number(r.group_id) : null }));
}

/**
 * Re-classifies the devices of a scope with the tenant's vendor rules, with
 * the scan pipeline's semantics (vendorRuleMatch). Only devices whose vendor
 * is known and whose type was not set by hand are touched: source 'rule' or
 * 'ports', or no source while still 'unknown' (a typed row without a source
 * is treated as manual, like the scan pipeline's mayReclassify). A matching
 * rule sets its type with source 'rule' (and its label as the name of a
 * device that had no type and no name yet); a device no rule matches keeps
 * its type. The probes of the changed sites get their device-check targets
 * again (rules matching on deviceTypes) and the sites' readers a SITE_UPDATED.
 */
export async function reapplyVendorRules(tenantId: number, target: ReapplyScope): Promise<ReapplyResult> {
  const sites = await sitesOfScope(tenantId, target);
  if (sites.length === 0) return { updated: 0, scanned: 0 };

  const rules = await db('vendor_type_rules')
    .where('tenant_id', tenantId)
    .select('id', 'group_id', 'priority', 'vendor_pattern', 'device_type', 'label') as ScopedVendorRuleRow[];

  const groupIds = [...new Set(sites.map((s) => s.groupId).filter((g): g is number => g !== null))];
  const ancestorsOf = new Map<number, number[]>();
  if (groupIds.length > 0) {
    const closure = await db('group_closure')
      .whereIn('descendant_id', groupIds)
      .select('ancestor_id', 'descendant_id') as Array<{ ancestor_id: number; descendant_id: number }>;
    for (const row of closure) {
      const d = Number(row.descendant_id);
      const list = ancestorsOf.get(d) ?? [];
      list.push(Number(row.ancestor_id));
      ancestorsOf.set(d, list);
    }
  }
  const groupOfSite = new Map(sites.map((s) => [s.id, s.groupId]));

  let scanned = 0;
  let updated = 0;
  const changedSites = new Set<number>();
  const typeChangedSites = new Set<number>();
  const now = new Date();

  for (let start = 0; start < sites.length; start += SITE_CHUNK) {
    const siteIds = sites.slice(start, start + SITE_CHUNK).map((s) => s.id);
    const items = await db('site_items')
      .where('tenant_id', tenantId)
      .whereIn('site_id', siteIds)
      .whereNotNull('vendor')
      .where(function () {
        this.whereIn('device_type_source', ['rule', 'ports'])
          .orWhere(function () {
            this.whereNull('device_type_source')
              .where(function () { this.whereNull('device_type').orWhere('device_type', 'unknown'); });
          });
      })
      .select('id', 'site_id', 'vendor', 'device_type', 'device_type_source', 'custom_name') as Array<{
        id: number; site_id: number; vendor: string | null; device_type: string | null;
        device_type_source: string | null; custom_name: string | null;
      }>;

    // (type | label) → item ids, so the updates are a few batched statements.
    const plain = new Map<string, number[]>();
    const labelled = new Map<string, { type: string; label: string; ids: number[] }>();
    for (const item of items) {
      scanned++;
      const groupId = groupOfSite.get(Number(item.site_id)) ?? null;
      const match = matchVendorRule(item.vendor, rules, groupId !== null ? ancestorsOf.get(groupId) ?? [groupId] : null);
      if (!match) continue;
      const currentType = item.device_type || 'unknown';
      if (match.deviceType === currentType && item.device_type_source === 'rule') continue;
      const siteId = Number(item.site_id);
      changedSites.add(siteId);
      if (match.deviceType !== currentType) typeChangedSites.add(siteId);
      if (match.label && currentType === 'unknown' && !item.custom_name) {
        const label = match.label.slice(0, 255);
        const key = `${match.deviceType}\u0000${label}`;
        const entry = labelled.get(key) ?? { type: match.deviceType, label, ids: [] };
        entry.ids.push(Number(item.id));
        labelled.set(key, entry);
      } else {
        const list = plain.get(match.deviceType) ?? [];
        list.push(Number(item.id));
        plain.set(match.deviceType, list);
      }
    }

    const apply = async (ids: number[], patch: Record<string, unknown>, keepName: boolean) => {
      for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
        const chunk = ids.slice(i, i + UPDATE_CHUNK);
        const q = db('site_items').where('tenant_id', tenantId).whereIn('id', chunk)
          // Re-checked at write time: a concurrent manual edit wins.
          .where(function () { this.whereNull('device_type_source').orWhereNot('device_type_source', 'manual'); });
        // Same test as the bucket choice above: '' counts as no name.
        if (!keepName) q.where(function () { this.whereNull('custom_name').orWhere('custom_name', ''); });
        updated += await q.update({ ...patch, updated_at: now });
      }
    };
    for (const [type, ids] of plain) {
      await apply(ids, { device_type: type, device_type_source: 'rule' }, true);
    }
    for (const { type, label, ids } of labelled.values()) {
      await apply(ids, { device_type: type, device_type_source: 'rule', custom_name: label }, false);
    }
  }

  if (typeChangedSites.size > 0) {
    // Device checks match on deviceTypes: refresh the probes' assignments.
    await pushConfigToAffectedProbes(tenantId, [...typeChangedSites]).catch((err: unknown) => {
      logger.warn({ err: (err as Error)?.message, tenantId }, 'Device-check config push after vendor-rule re-apply failed');
    });
  }
  for (const siteId of changedSites) emitSiteUpdated(tenantId, siteId);

  return { updated, scanned };
}

// One re-apply at a time per tenant (rule edits in quick succession queue up).
const reapplyQueues = new Map<number, Promise<unknown>>();

function queueReapply(tenantId: number, target: ReapplyScope): Promise<ReapplyResult> {
  const previous = reapplyQueues.get(tenantId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => reapplyVendorRules(tenantId, target));
  const tail = run.catch(() => undefined);
  reapplyQueues.set(tenantId, tail);
  void tail.then(() => { if (reapplyQueues.get(tenantId) === tail) reapplyQueues.delete(tenantId); });
  return run;
}

/**
 * Re-apply in the background after a rule change, on the rule's scope(s)
 * (null = whole tenant). The actor's access is checked like the
 * POST /reapply endpoint: the tenant scope needs full access, a group scope
 * write access on that group (or full access); a scope the actor may not
 * re-apply is skipped (logged), the scan pipeline still applies the rule to
 * untyped devices. A whole-tenant scope covers every other one.
 */
function reapplyInBackground(req: Request, groupIds: Array<number | null>): void {
  const tenantId = req.tenantId;
  const userId = Number(req.session?.userId);
  const isPlatformAdmin = req.session?.role === 'admin';
  const scopes = groupIds.some((g) => g == null)
    ? [null]
    : [...new Set(groupIds.map((g) => Number(g)))];
  void (async () => {
    if (!Number.isInteger(userId) || userId <= 0) return;
    const fullAccess = await permissionService.isFullAccess(userId, tenantId, isPlatformAdmin);
    for (const groupId of scopes) {
      const allowed = fullAccess
        || (groupId !== null && await permissionService.canWriteGroup(userId, groupId, tenantId, isPlatformAdmin));
      if (!allowed) {
        logger.info({ tenantId, userId, groupId }, 'Automatic vendor-rule re-apply skipped: the actor may not re-type this scope');
        continue;
      }
      const target: ReapplyScope = groupId !== null ? { scope: 'group', id: groupId } : { scope: 'tenant' };
      queueReapply(tenantId, target).then(
        (r) => { if (r.updated > 0) logger.info({ tenantId, ...target, ...r }, 'Vendor rules re-applied after a rule change'); },
        (err: unknown) => logger.warn({ err: (err as Error)?.message, tenantId }, 'Vendor rules re-apply after a rule change failed'),
      );
    }
  })().catch((err: unknown) => {
    logger.warn({ err: (err as Error)?.message, tenantId }, 'Vendor rules re-apply after a rule change failed');
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toRule(row: Record<string, unknown>): VendorTypeRule {
  return {
    id:            row.id as number,
    groupId:       row.group_id as number | null,
    tenantId:      row.tenant_id as number,
    vendorPattern: row.vendor_pattern as string,
    deviceType:    row.device_type as DeviceType,
    label:         row.label as string | null,
    priority:      row.priority as number,
    createdAt:     (row.created_at as Date).toISOString(),
  };
}

// ── controller ────────────────────────────────────────────────────────────────
// Bodies are validated by the route (validators/vendorRule.schema.ts);
// mutations are admin-only (routes/vendorRules.routes.ts).

export const vendorRulesController = {

  /** GET /vendor-rules?groupId=N  — list rules for tenant, optionally filtered by group */
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const raw = req.query.groupId;
      const groupId = raw === undefined || raw === '' ? undefined : requireDbId(raw, 'groupId');
      const q = db('vendor_type_rules').where('tenant_id', req.tenantId);
      if (groupId !== undefined) {
        q.andWhere('group_id', groupId);
      }
      const rows = await q.orderBy('priority', 'desc').orderBy('id', 'asc');
      res.json({ rules: rows.map(toRule) });
    } catch (err) { next(err); }
  },

  /**
   * GET /vendor-rules/observed-vendors — the vendor names of the tenant's
   * devices, limited to the sites the caller may read (nothing for a member
   * without team permission), most frequent first (≤ 1000): the pattern list
   * of the rule dialog and the "Auto rules" suggestions.
   */
  async observedVendors(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = Number(req.session?.userId);
      const visible = await permissionService.getVisibleSiteIds(userId, req.tenantId, req.session?.role === 'admin');
      if (visible !== 'all' && visible.length === 0) {
        res.json({ vendors: [] });
        return;
      }
      const q = db('site_items')
        .where('tenant_id', req.tenantId)
        .whereNotNull('vendor')
        .whereRaw("btrim(vendor) <> ''");
      if (visible !== 'all') q.whereIn('site_id', visible);
      const rows = await q
        .select('vendor')
        .count({ devices: '*' })
        .select(db.raw("count(*) filter (where device_type is null or device_type = 'unknown') as untyped"))
        .groupBy('vendor')
        .orderBy('devices', 'desc')
        .orderBy('vendor', 'asc')
        .limit(1000) as Array<{ vendor: string; devices: string | number; untyped: string | number }>;
      const vendors: ObservedVendor[] = rows.map((r) => ({
        vendor: r.vendor,
        devices: Number(r.devices),
        untyped: Number(r.untyped),
      }));
      res.json({ vendors });
    } catch (err) { next(err); }
  },

  /**
   * POST /vendor-rules/bulk — "Auto rules": creates tenant-wide rules in one
   * go, skipping a pattern a tenant-wide rule already has (case-insensitive).
   * One audit entry and one re-apply for the batch.
   */
  async bulkCreate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { rules } = req.body as BulkCreateVendorRulesInput;
      const created = await db.transaction(async (trx) => {
        const existing = await trx('vendor_type_rules')
          .where('tenant_id', req.tenantId)
          .whereNull('group_id')
          .select('vendor_pattern') as Array<{ vendor_pattern: string }>;
        const taken = new Set(existing.map((r) => String(r.vendor_pattern).trim().toLowerCase()));
        const rows: Array<Record<string, unknown>> = [];
        for (const rule of rules) {
          const key = rule.vendorPattern.toLowerCase();
          if (taken.has(key)) continue;
          taken.add(key);
          rows.push({
            tenant_id: req.tenantId,
            group_id: null,
            vendor_pattern: rule.vendorPattern,
            device_type: rule.deviceType,
            label: rule.label ?? null,
            priority: rule.priority ?? 0,
          });
        }
        if (rows.length === 0) return [] as Array<Record<string, unknown>>;
        return trx('vendor_type_rules').insert(rows).returning('*') as Promise<Array<Record<string, unknown>>>;
      });

      if (created.length > 0) {
        void auditService.logReq(req, {
          action: 'vendor_rule.bulk_created',
          resourceType: 'vendor_rule',
          resourceId: null,
          details: {
            count: created.length,
            rules: created.map((r) => ({ vendorPattern: r.vendor_pattern, deviceType: r.device_type, priority: r.priority })),
          },
        });
      }
      res.status(201).json({ rules: created.map(toRule), skipped: rules.length - created.length });
      if (created.length > 0) reapplyInBackground(req, [null]);
    } catch (err) { next(err); }
  },

  /** POST /vendor-rules */
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { vendorPattern, deviceType, label, priority, groupId } = req.body as CreateVendorRuleInput;

      // A group-scoped rule must target a group of this tenant.
      if (groupId != null) {
        const group = await db('monitor_groups').where({ id: groupId, tenant_id: req.tenantId }).first('id');
        if (!group) throw new AppError(404, 'Group not found');
      }

      const [row] = await db('vendor_type_rules').insert({
        tenant_id:      req.tenantId,
        group_id:       groupId ?? null,
        vendor_pattern: vendorPattern,
        device_type:    deviceType,
        label:          label ?? null,
        priority:       priority ?? 0,
      }).returning('*');

      void auditService.logReq(req, {
        action: 'vendor_rule.created',
        resourceType: 'vendor_rule',
        resourceId: row.id as number,
        details: { vendorPattern, deviceType, label: label ?? null, priority: priority ?? 0, groupId: groupId ?? null },
      });
      res.status(201).json({ rule: toRule(row) });
      // Existing devices not typed by hand follow the new rule.
      reapplyInBackground(req, [(row.group_id as number | null) ?? null]);
    } catch (err) { next(err); }
  },

  /** PATCH /vendor-rules/:id */
  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ruleId = requireDbId(req.params.id, 'rule id');
      const existing = await db('vendor_type_rules')
        .where({ id: ruleId, tenant_id: req.tenantId }).first();
      if (!existing) throw new AppError(404, 'Rule not found');

      const { vendorPattern, deviceType, label, priority } = req.body as UpdateVendorRuleInput;

      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (vendorPattern !== undefined) patch.vendor_pattern = vendorPattern;
      if (deviceType   !== undefined) patch.device_type    = deviceType;
      if (label        !== undefined) patch.label          = label;
      if (priority     !== undefined) patch.priority       = priority;

      const [row] = await db('vendor_type_rules')
        .where({ id: ruleId, tenant_id: req.tenantId })
        .update(patch)
        .returning('*');
      if (!row) throw new AppError(404, 'Rule not found');

      void auditService.logReq(req, {
        action: 'vendor_rule.updated',
        resourceType: 'vendor_rule',
        resourceId: ruleId,
        details: {
          fields: Object.keys(patch).filter((k) => k !== 'updated_at'),
          before: {
            vendorPattern: existing.vendor_pattern,
            deviceType: existing.device_type,
            label: existing.label,
            priority: existing.priority,
          },
          after: { vendorPattern: row.vendor_pattern, deviceType: row.device_type, label: row.label, priority: row.priority },
        },
      });
      res.json({ rule: toRule(row) });
      // The old scope too when the rule moved (a lower-priority rule may win there now).
      reapplyInBackground(req, [(row.group_id as number | null) ?? null, (existing.group_id as number | null) ?? null]);
    } catch (err) { next(err); }
  },

  /** DELETE /vendor-rules/:id */
  async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ruleId = requireDbId(req.params.id, 'rule id');
      const [deleted] = await db('vendor_type_rules')
        .where({ id: ruleId, tenant_id: req.tenantId })
        .delete()
        .returning(['id', 'vendor_pattern', 'device_type', 'group_id']);
      if (!deleted) throw new AppError(404, 'Rule not found');

      void auditService.logReq(req, {
        action: 'vendor_rule.deleted',
        resourceType: 'vendor_rule',
        resourceId: ruleId,
        details: {
          vendorPattern: deleted.vendor_pattern,
          deviceType: deleted.device_type,
          groupId: deleted.group_id ?? null,
        },
      });
      res.status(204).send();
      // Devices the rule typed fall back to the remaining rules (when one matches).
      reapplyInBackground(req, [(deleted.group_id as number | null) ?? null]);
    } catch (err) { next(err); }
  },

  /**
   * POST /vendor-rules/reapply {scope: 'tenant' | 'group' | 'site', id?}
   * Re-classifies the scope's devices (never those typed by hand). The route
   * requires sites.manage + deviceChecks.manage; the tenant scope needs full
   * access, a group / site scope write permission on it (or full access).
   */
  async reapply(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as z.infer<typeof reapplyVendorRulesSchema>;
      const userId = requireDbId(req.session.userId, 'user id');
      const isPlatformAdmin = req.session.role === 'admin';
      const fullAccess = await permissionService.isFullAccess(userId, req.tenantId, isPlatformAdmin);

      let target: ReapplyScope;
      if (body.scope === 'tenant') {
        if (!fullAccess) throw new AppError(403, 'Re-applying the rules to the whole tenant needs full access');
        target = { scope: 'tenant' };
      } else if (body.scope === 'group') {
        const groupId = requireDbId(body.id, 'id');
        if (!(await permissionService.findGroup(groupId, req.tenantId))) throw new AppError(404, 'Group not found');
        if (!fullAccess && !(await permissionService.canWriteGroup(userId, groupId, req.tenantId, isPlatformAdmin))) {
          throw new AppError(403, 'Insufficient permissions');
        }
        target = { scope: 'group', id: groupId };
      } else {
        const siteId = requireDbId(body.id, 'id');
        if (!(await permissionService.findSite(siteId, req.tenantId))) throw new AppError(404, 'Site not found');
        if (!fullAccess && !(await permissionService.canWriteSite(userId, siteId, req.tenantId, isPlatformAdmin))) {
          throw new AppError(403, 'Insufficient permissions');
        }
        target = { scope: 'site', id: siteId };
      }

      const result = await queueReapply(req.tenantId, target);
      await auditService.logReq(req, {
        action: 'vendor_rule.reapplied',
        resourceType: target.scope === 'tenant' ? 'tenant' : target.scope,
        resourceId: target.scope === 'tenant' ? req.tenantId : target.id,
        details: { scope: target.scope, updated: result.updated, scanned: result.scanned },
      });
      res.json(result);
    } catch (err) { next(err); }
  },
};
