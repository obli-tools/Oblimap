import type {
  DeviceCheckCredentialInfo,
  DeviceCheckEvent,
  DeviceCheckRule,
  DeviceCheckSiteSummary,
  DeviceCheckSpec,
  DeviceCheckStateDetail,
  DeviceCheckAssertionResult,
  DeviceCheckTraceStep,
  DeviceCheckValue,
  DeviceType,
  PermissionLevel,
  SiteItem,
} from '@oblimap/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { AppError } from '../../middleware/errorHandler';
import * as secretBox from '../../utils/secretBox';
import { appConfigService } from '../appConfig.service';
import { permissionService } from '../permission.service';
import type {
  CreateRuleInput,
  CredentialsInput,
  PreviewInput,
  UpdateRuleInput,
} from '../../validators/deviceCheck.schema';
import { specUsesBasicAuth } from '../../validators/deviceCheck.schema';
import {
  canonicalJson,
  credentialAad,
  emitRulesChanged,
  invalidateAccountableCache,
  invalidateTenantCaches,
  isChecksCapable,
  mergeSiteScopes,
  pushConfigToAffectedProbes,
  rowToRuleRecord,
  scopeSiteIds,
  specHash,
} from './config.service';
import { matchesItem, prefilterQuery } from './match';
import { buildCheckSummary } from './eval';
import { actionEventRows, emitAlertChange, resolveDeviceCheckLiveAlert, type EventBase } from './ingest.service';

// Device Checks rules: CRUD with scope ownership checks, revision bumps,
// enable / disable, write-only credentials, coverage and the read models of
// the UI (site states, events, site summaries). Routes audit every mutation
// (controllers/deviceChecks.controller.ts); after every mutation that can
// change what probes run, the WS-connected probes of the affected sites get a
// fresh config and the tenant's admins a DEVICE_CHECK_RULES_CHANGED.

export interface ValidationIssue {
  path: string;
  message: string;
}

/** 400 with field-level issues (same shape as middleware/validate.ts). */
export class DeviceCheckValidationError extends AppError {
  constructor(public readonly issues: ValidationIssue[]) {
    super(400, 'Validation failed');
    this.name = 'DeviceCheckValidationError';
  }
}

type Row = Record<string, unknown>;

function iso(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
}

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return iso(v);
}

function dateOrNull(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}

function jsonOf<T>(v: unknown, fallback: T): T {
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }
  return (v ?? fallback) as T;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

/** "admin" → "ad***": enough to recognise it, never the whole username. */
export function maskUsername(username: string): string {
  const chars = Array.from(username);
  const keep = chars.length >= 4 ? 2 : chars.length >= 2 ? 1 : 0;
  return `${chars.slice(0, keep).join('')}***`;
}

// ── Row mapping ──────────────────────────────────────────────────────────────

function rowToCredentialInfo(row: Row): DeviceCheckCredentialInfo {
  return {
    siteId: (row.site_id as number | null) ?? null,
    usernameMasked: String(row.username_masked ?? '***'),
    secretVersion: Number(row.secret_version) || 1,
    updatedAt: iso(row.updated_at),
    updatedBy: (row.updated_by as number | null) ?? null,
  };
}

function rowToRule(row: Row, credentials: DeviceCheckCredentialInfo[], coverage?: DeviceCheckRule['coverage']): DeviceCheckRule {
  return {
    id: Number(row.id),
    uuid: String(row.uuid),
    tenantId: Number(row.tenant_id),
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    enabled: row.enabled === true,
    suspendedReason: (row.suspended_reason as string | null) ?? null,
    groupId: (row.group_id as number | null) ?? null,
    siteId: (row.site_id as number | null) ?? null,
    presetKey: (row.preset_key as string | null) ?? null,
    presetVersion: (row.preset_version as number | null) ?? null,
    spec: jsonOf<DeviceCheckSpec>(row.spec, {} as DeviceCheckSpec),
    revision: Number(row.revision) || 1,
    credentials,
    createdBy: (row.created_by as number | null) ?? null,
    updatedBy: (row.updated_by as number | null) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(coverage ? { coverage } : {}),
  };
}

function rowToSiteItem(row: Row): SiteItem {
  return {
    id: Number(row.id),
    siteId: Number(row.site_id),
    tenantId: Number(row.tenant_id),
    ip: String(row.ip),
    mac: (row.mac as string | null) ?? null,
    hostname: (row.hostname as string | null) ?? null,
    customName: (row.custom_name as string | null) ?? null,
    deviceType: ((row.device_type as DeviceType | null) ?? 'unknown'),
    vendor: (row.vendor as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    status: (row.status as SiteItem['status']) ?? 'unknown',
    isManual: row.is_manual === true,
    discoveredByProbeId: (row.discovered_by_probe_id as number | null) ?? null,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

// ── Validation that needs the database ───────────────────────────────────────

async function assertScopeOwned(tenantId: number, groupId: number | null, siteId: number | null): Promise<void> {
  if (groupId !== null && siteId !== null) throw new AppError(400, 'A rule is scoped to a group or to a site, not both');
  if (groupId !== null) {
    const g = await db('monitor_groups').where({ id: groupId, tenant_id: tenantId }).first('id');
    if (!g) throw new AppError(404, 'Group not found');
  }
  if (siteId !== null) {
    const s = await db('sites').where({ id: siteId, tenant_id: tenantId }).first('id');
    if (!s) throw new AppError(404, 'Site not found');
  }
}

/**
 * Checks of a (schema-valid) spec against the platform policy and the
 * tenant's data: variant ports ⊂ allowedPorts, interval ≥ policy minimum,
 * explicit devices owned by the tenant. With a `viewer`, explicit devices
 * must also be in a site the viewer may read: a device of another
 * site is reported as unknown, so the answer never tells a scoped author
 * which devices exist elsewhere.
 */
export async function specPolicyIssues(
  tenantId: number,
  spec: DeviceCheckSpec,
  viewer?: DeviceCheckViewer,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const policy = await appConfigService.getDeviceChecksPolicy();
  const allowed = new Set(policy.allowedPorts);
  spec.variants.forEach((v, i) => {
    if (!allowed.has(v.request.port)) {
      issues.push({
        path: `variants.${i}.request.port`,
        message: `Port ${v.request.port} is not allowed (allowed: ${policy.allowedPorts.join(', ')})`,
      });
    }
  });
  if (spec.schedule.intervalSeconds < policy.minIntervalSeconds) {
    issues.push({ path: 'schedule.intervalSeconds', message: `The interval must be at least ${policy.minIntervalSeconds} seconds` });
  }
  let visible: number[] | 'all' | null = null;
  for (const key of ['itemIds', 'excludeItemIds'] as const) {
    const ids = [...new Set(spec.match[key] ?? [])];
    if (ids.length === 0) continue;
    if (visible === null) {
      visible = viewer
        ? await permissionService.getVisibleSiteIds(viewer.userId, tenantId, viewer.isPlatformAdmin)
        : 'all';
    }
    const q = db('site_items').where({ tenant_id: tenantId }).whereIn('id', ids);
    if (visible !== 'all') q.whereIn('site_id', visible.length > 0 ? visible : [-1]);
    const found = new Set((await q.pluck('id') as number[]).map(Number));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      issues.push({ path: `match.${key}`, message: `Unknown device${missing.length > 1 ? 's' : ''}: ${missing.slice(0, 5).join(', ')}` });
    }
  }
  return issues;
}

// ── Authoring scope ────────────────────────────────────────────────
//
// deviceChecks.manage is a tenant capability, but a holder without full
// access (neither platform nor tenant admin) only authors checks inside the
// part of the tenant their teams reach:
//  - preview: the rule scope must be a group or site they can READ, and the
//    sample / counts / per-site breakdown only list sites they may read;
//  - test / run now: the device's site must be readable (404 otherwise);
//  - create / update / enable / disable / delete / credentials: the rule's
//    scope (the current one and, on update, the new one) must be a group or
//    site they can WRITE. A tenant-wide rule (no group, no site) stays with
//    full access: the probes of every site would run it.
// Full access behaves as before. Probes, settings and notification bindings
// stay tenant-level objects (their capabilities are not bounded by team
// scopes yet); only device-check authoring is.

export type AuthoringAccess = 'read' | 'write';

export interface AuthoringScope {
  groupId: number | null;
  siteId: number | null;
}

/**
 * Pure decision: may a device-check author act on `scope`? `level` is the
 * author's effective team permission on the scope's group or site (null:
 * none, or a tenant-wide scope). Full access is always allowed; otherwise a
 * tenant-wide scope never is, 'read' needs any level and 'write' needs 'rw'.
 */
export function authoringScopeAllowed(input: {
  fullAccess: boolean;
  scope: AuthoringScope;
  need: AuthoringAccess;
  level: PermissionLevel | null;
}): boolean {
  if (input.fullAccess) return true;
  if (input.scope.groupId === null && input.scope.siteId === null) return false;
  if (input.level === null) return false;
  return input.need === 'read' ? true : input.level === 'rw';
}

/** Keeps the rows of the sites `visible` lists ('all': every row). */
export function limitToVisibleSites<T extends { site_id: unknown }>(rows: T[], visible: number[] | 'all'): T[] {
  if (visible === 'all') return rows;
  const set = new Set(visible);
  return rows.filter((r) => set.has(Number(r.site_id)));
}

/** True when the viewer has full access in the tenant (platform or tenant admin). */
export async function viewerHasFullAccess(tenantId: number, viewer: DeviceCheckViewer): Promise<boolean> {
  return permissionService.isFullAccess(viewer.userId, tenantId, viewer.isPlatformAdmin);
}

/**
 * 403 scope_not_allowed unless the viewer may act on `scope` (see
 * authoringScopeAllowed). The scope must already be known to belong to the
 * tenant (assertScopeOwned).
 */
export async function assertAuthoringScope(
  tenantId: number,
  viewer: DeviceCheckViewer,
  scope: AuthoringScope,
  need: AuthoringAccess,
): Promise<void> {
  const fullAccess = await viewerHasFullAccess(tenantId, viewer);
  let level: PermissionLevel | null = null;
  if (!fullAccess) {
    if (scope.siteId !== null) {
      level = await permissionService.getSitePermission(viewer.userId, scope.siteId, tenantId, viewer.isPlatformAdmin);
    } else if (scope.groupId !== null) {
      level = await permissionService.getGroupPermission(viewer.userId, scope.groupId, tenantId, viewer.isPlatformAdmin);
    }
  }
  if (!authoringScopeAllowed({ fullAccess, scope, need, level })) throw new AppError(403, 'scope_not_allowed');
}

async function assertSpecAllowed(tenantId: number, spec: DeviceCheckSpec, viewer: DeviceCheckViewer): Promise<void> {
  const issues = await specPolicyIssues(tenantId, spec, viewer);
  if (issues.length > 0) throw new DeviceCheckValidationError(issues);
}

// ── Coverage (rule list) ─────────────────────────────────────────────────────

type Coverage = NonNullable<DeviceCheckRule['coverage']>;

const COVERAGE_TTL_MS = 60_000;
const coverageCache = new Map<number, { at: number; byRule: Map<number, Coverage> }>();

function invalidateCoverage(tenantId: number): void {
  coverageCache.delete(tenantId);
}

async function capableSiteIds(tenantId: number): Promise<Set<number>> {
  const rows = await db('probes')
    .where({ tenant_id: tenantId, status: 'approved' })
    .whereNotNull('site_id')
    .select('site_id', 'capabilities') as Row[];
  return new Set(rows.filter((r) => isChecksCapable(r)).map((r) => Number(r.site_id)));
}

interface MatchedItem extends Row {
  id: number;
  site_id: number;
}

/** The tenant's devices a match targets within a scope (see match.ts). */
async function matchedItems(
  tenantId: number,
  match: DeviceCheckSpec['match'],
  scope: { groupId: number | null; siteId: number | null },
  columns: string[] = ['id', 'site_id', 'ip', 'mac', 'vendor', 'device_type'],
): Promise<MatchedItem[]> {
  const sites = await scopeSiteIds(tenantId, scope);
  if (sites !== 'all' && sites.length === 0) return [];
  const q = db('site_items').where({ tenant_id: tenantId }).select(columns).orderBy('id', 'asc');
  if (sites !== 'all') q.whereIn('site_id', sites);
  prefilterQuery(q, match);
  const rows = await q as MatchedItem[];
  return rows.filter((r) => matchesItem(match, {
    id: Number(r.id),
    ip: String(r.ip),
    mac: (r.mac as string | null) ?? null,
    vendor: (r.vendor as string | null) ?? null,
    device_type: String(r.device_type ?? 'unknown'),
  }));
}

async function coverageOf(tenantId: number, ruleRows: Row[]): Promise<Map<number, Coverage>> {
  const hit = coverageCache.get(tenantId);
  if (hit && Date.now() - hit.at < COVERAGE_TTL_MS && ruleRows.every((r) => hit.byRule.has(Number(r.id)))) return hit.byRule;

  const capable = await capableSiteIds(tenantId);
  const counts = new Map((await db('device_check_state')
    .where({ tenant_id: tenantId })
    .groupBy('rule_id')
    .select('rule_id')
    .select(db.raw(`count(*) filter (where status = 'ok') as ok`))
    .select(db.raw(`count(*) filter (where status in ('fail', 'error')) as failing`))
    .select(db.raw(`count(*) filter (where alert_state = 'alerting') as alerting`)) as Row[])
    .map((r) => [Number(r.rule_id), r]));

  const byRule = new Map<number, Coverage>();
  for (const row of ruleRows) {
    const id = Number(row.id);
    const c = counts.get(id);
    const stateCounts = { ok: Number(c?.ok ?? 0), failing: Number(c?.failing ?? 0), alerting: Number(c?.alerting ?? 0) };
    const rule = rowToRuleRecord(row);
    if (!rule) {
      byRule.set(id, { matchedItems: 0, sites: 0, withoutCapableProbe: 0, ...stateCounts });
      continue;
    }
    try {
      const items = await matchedItems(tenantId, rule.spec.match, rule);
      byRule.set(id, {
        matchedItems: items.length,
        sites: new Set(items.map((i) => Number(i.site_id))).size,
        withoutCapableProbe: items.filter((i) => !capable.has(Number(i.site_id))).length,
        ...stateCounts,
      });
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, ruleId: id }, 'Device check coverage failed');
      byRule.set(id, { matchedItems: 0, sites: 0, withoutCapableProbe: 0, ...stateCounts });
    }
  }
  coverageCache.set(tenantId, { at: Date.now(), byRule });
  return byRule;
}

async function credentialsOf(tenantId: number, ruleIds: number[]): Promise<Map<number, DeviceCheckCredentialInfo[]>> {
  const out = new Map<number, DeviceCheckCredentialInfo[]>();
  if (ruleIds.length === 0) return out;
  const rows = await db('device_check_credentials')
    .where({ tenant_id: tenantId })
    .whereIn('rule_id', ruleIds)
    .select('rule_id', 'site_id', 'username_masked', 'secret_version', 'updated_at', 'updated_by')
    .orderByRaw('site_id NULLS FIRST') as Row[];
  for (const r of rows) {
    const id = Number(r.rule_id);
    const list = out.get(id) ?? [];
    list.push(rowToCredentialInfo(r));
    out.set(id, list);
  }
  return out;
}

// ── Change propagation ───────────────────────────────────────────────────────

function afterRuleChange(tenantId: number, ruleId: number, sites: number[] | 'all' | null): void {
  invalidateTenantCaches(tenantId);
  invalidateCoverage(tenantId);
  if (sites !== null) {
    void pushConfigToAffectedProbes(tenantId, sites).catch((err: unknown) =>
      logger.warn({ err: (err as Error)?.message, tenantId, ruleId }, 'Device checks config push failed'));
  }
  emitRulesChanged(tenantId, ruleId);
}

function scopeOf(row: Row): { groupId: number | null; siteId: number | null } {
  return { groupId: (row.group_id as number | null) ?? null, siteId: (row.site_id as number | null) ?? null };
}

/**
 * Closes the rule's alerts without notification (rule disabled): alerting
 * rows write alert_closed (reason rule_disabled); every row of the rule goes
 * back to 'ok' with its debounce counters reset.
 */
export async function closeAlertsSilently(tenantId: number, ruleId: number, reason: 'rule_disabled'): Promise<number> {
  const closed = await db.transaction(async (trx) => {
    const rows = await trx('device_check_state')
      .where({ tenant_id: tenantId, rule_id: ruleId })
      .whereIn('alert_state', ['alerting', 'pending', 'suppressed'])
      .forUpdate()
      .select('id', 'site_id', 'site_item_id', 'probe_id', 'alert_state', 'alert_since') as Row[];
    if (rows.length === 0) return [] as Row[];
    const events: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      if (r.alert_state !== 'alerting') continue;
      const base: EventBase = {
        tenant_id: tenantId, rule_id: ruleId, site_item_id: Number(r.site_item_id), site_id: Number(r.site_id),
        probe_id: (r.probe_id as number | null) ?? null,
      };
      events.push(...actionEventRows(base, 'alerting', 'ok', [
        { type: 'close', reason, notify: false, alertSince: dateOrNull(r.alert_since) },
      ]));
    }
    if (events.length > 0) await trx('device_check_events').insert(events);
    await trx('device_check_state').whereIn('id', rows.map((r) => Number(r.id))).update({
      alert_state: 'ok',
      alert_since: null,
      consecutive_bad: 0,
      consecutive_ok: 0,
      bad_since: null,
      ok_since: null,
      updated_at: new Date(),
    });
    return rows;
  });
  for (const r of closed) {
    emitAlertChange(tenantId, {
      siteId: Number(r.site_id), itemId: Number(r.site_item_id), ruleId,
      from: r.alert_state as 'alerting' | 'pending' | 'suppressed', to: 'ok',
    });
    // The open live alert of an alerting row is resolved (never throws).
    if (r.alert_state === 'alerting') void resolveDeviceCheckLiveAlert(tenantId, Number(r.id), dateOrNull(r.alert_since));
  }
  return closed.length;
}

/** Deletes the rule's state rows whose device no longer matches (after a match / scope change). */
async function pruneStates(tenantId: number, ruleRow: Row): Promise<number> {
  const rule = rowToRuleRecord(ruleRow);
  if (!rule) return 0;
  const sites = await scopeSiteIds(tenantId, rule);
  const siteSet = sites === 'all' ? null : new Set(sites);
  const rows = await db('device_check_state as s')
    .join('site_items as i', 'i.id', 's.site_item_id')
    .where('s.tenant_id', tenantId)
    .where('s.rule_id', rule.id)
    .select('s.id', 's.site_id', 'i.id as item_id', 'i.ip', 'i.mac', 'i.vendor', 'i.device_type') as Row[];
  const match = { ...rule.spec.match, requireMac: rule.spec.match.requireMac || specUsesBasicAuth(rule.spec) };
  const stale = rows.filter((r) => (siteSet !== null && !siteSet.has(Number(r.site_id))) || !matchesItem(match, {
    id: Number(r.item_id),
    ip: String(r.ip),
    mac: (r.mac as string | null) ?? null,
    vendor: (r.vendor as string | null) ?? null,
    device_type: String(r.device_type ?? 'unknown'),
  })).map((r) => Number(r.id));
  for (let i = 0; i < stale.length; i += 1000) {
    await db('device_check_state').where({ tenant_id: tenantId }).whereIn('id', stale.slice(i, i + 1000)).delete();
  }
  return stale.length;
}

// ── Service ──────────────────────────────────────────────────────────────────

/** The user reading states / events / summaries (team-scoped site permissions). */
export interface DeviceCheckViewer {
  userId: number;
  isPlatformAdmin: boolean;
}

export interface RuleChange {
  rule: DeviceCheckRule;
  changedKeys: string[];
  oldSpecHash: string | null;
  newSpecHash: string;
  revisionBumped: boolean;
}

export const deviceCheckRuleService = {
  async list(tenantId: number): Promise<DeviceCheckRule[]> {
    const rows = await db('device_check_rules').where({ tenant_id: tenantId }).orderBy('name', 'asc') as Row[];
    const ids = rows.map((r) => Number(r.id));
    const [creds, coverage] = await Promise.all([credentialsOf(tenantId, ids), coverageOf(tenantId, rows)]);
    return rows.map((r) => rowToRule(r, creds.get(Number(r.id)) ?? [], coverage.get(Number(r.id))));
  },

  async get(tenantId: number, id: number): Promise<DeviceCheckRule | null> {
    const row = await db('device_check_rules').where({ id, tenant_id: tenantId }).first() as Row | undefined;
    if (!row) return null;
    const [creds, coverage] = await Promise.all([credentialsOf(tenantId, [id]), coverageOf(tenantId, [row])]);
    return rowToRule(row, creds.get(id) ?? [], coverage.get(id));
  },

  /** Creates a rule — always disabled; enabling is a separate, audited action. */
  async create(tenantId: number, viewer: DeviceCheckViewer, input: CreateRuleInput): Promise<DeviceCheckRule> {
    const userId = viewer.userId;
    const groupId = input.groupId ?? null;
    const siteId = input.siteId ?? null;
    await assertScopeOwned(tenantId, groupId, siteId);
    await assertAuthoringScope(tenantId, viewer, { groupId, siteId }, 'write');
    await assertSpecAllowed(tenantId, input.spec, viewer);
    let row: Row;
    try {
      [row] = await db('device_check_rules').insert({
        tenant_id: tenantId,
        name: input.name,
        description: input.description ?? null,
        enabled: false,
        group_id: groupId,
        site_id: siteId,
        preset_key: input.presetKey ?? null,
        preset_version: input.presetVersion ?? null,
        spec: JSON.stringify(input.spec),
        revision: 1,
        created_by: userId,
        updated_by: userId,
      }).returning('*') as Row[];
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'A device check with this name already exists');
      throw err;
    }
    // Disabled: nothing changes for the probes.
    afterRuleChange(tenantId, Number(row.id), null);
    return rowToRule(row, []);
  },

  /**
   * Partial update. A change of spec or scope bumps the revision (results
   * of the previous revision are then rejected) and drops the state rows of
   * devices that no longer match. The saver becomes the accountable user, so
   * a suspension is lifted.
   * Scope: a rule has at most one of groupId / siteId, so setting one clears
   * the other when the body leaves it out ({siteId: 5} alone moves a
   * group-scoped rule to site 5); both null = tenant-wide.
   */
  async update(tenantId: number, viewer: DeviceCheckViewer, id: number, input: UpdateRuleInput): Promise<RuleChange | null> {
    const userId = viewer.userId;
    const existing = await db('device_check_rules').where({ id, tenant_id: tenantId }).first() as Row | undefined;
    if (!existing) return null;
    // The rule as it is (a tenant-wide rule stays with full access) …
    await assertAuthoringScope(tenantId, viewer, scopeOf(existing), 'write');

    let groupId = input.groupId !== undefined ? input.groupId : (existing.group_id as number | null) ?? null;
    let siteId = input.siteId !== undefined ? input.siteId : (existing.site_id as number | null) ?? null;
    if (input.siteId != null && input.groupId === undefined) groupId = null;
    if (input.groupId != null && input.siteId === undefined) siteId = null;
    await assertScopeOwned(tenantId, groupId, siteId);
    // … and as it will be.
    await assertAuthoringScope(tenantId, viewer, { groupId, siteId }, 'write');
    if (input.spec) await assertSpecAllowed(tenantId, input.spec, viewer);

    const oldSpec = jsonOf<unknown>(existing.spec, null);
    const patch: Record<string, unknown> = {};
    const changedKeys: string[] = [];
    if (input.name !== undefined && input.name !== existing.name) { patch.name = input.name; changedKeys.push('name'); }
    if (input.description !== undefined && input.description !== ((existing.description as string | null) ?? null)) {
      patch.description = input.description; changedKeys.push('description');
    }
    if (groupId !== ((existing.group_id as number | null) ?? null)) { patch.group_id = groupId; changedKeys.push('groupId'); }
    if (siteId !== ((existing.site_id as number | null) ?? null)) { patch.site_id = siteId; changedKeys.push('siteId'); }
    if (input.presetKey !== undefined && input.presetKey !== ((existing.preset_key as string | null) ?? null)) {
      patch.preset_key = input.presetKey; changedKeys.push('presetKey');
    }
    if (input.presetVersion !== undefined && input.presetVersion !== ((existing.preset_version as number | null) ?? null)) {
      patch.preset_version = input.presetVersion; changedKeys.push('presetVersion');
    }
    const specChanged = input.spec !== undefined && canonicalJson(input.spec) !== canonicalJson(oldSpec);
    if (specChanged) { patch.spec = JSON.stringify(input.spec); changedKeys.push('spec'); }

    const revisionBumped = specChanged || changedKeys.includes('groupId') || changedKeys.includes('siteId');
    const wasSuspended = existing.suspended_reason !== null && existing.suspended_reason !== undefined;
    if (wasSuspended) changedKeys.push('suspendedReason');

    let row: Row;
    try {
      [row] = await db('device_check_rules').where({ id, tenant_id: tenantId }).update({
        ...patch,
        ...(revisionBumped ? { revision: db.raw('revision + 1') } : {}),
        suspended_reason: null,
        updated_by: userId,
        updated_at: new Date(),
      }).returning('*') as Row[];
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'A device check with this name already exists');
      throw err;
    }
    if (!row) return null;

    if (revisionBumped) {
      await pruneStates(tenantId, row).catch((err: unknown) =>
        logger.warn({ err: (err as Error)?.message, ruleId: id }, 'Device check state pruning failed'));
    }
    invalidateAccountableCache(userId);
    const enabled = row.enabled === true;
    const affected = enabled && (revisionBumped || wasSuspended)
      ? mergeSiteScopes(await scopeSiteIds(tenantId, scopeOf(existing)), await scopeSiteIds(tenantId, scopeOf(row)))
      : null;
    afterRuleChange(tenantId, id, affected);

    const creds = await credentialsOf(tenantId, [id]);
    return {
      rule: rowToRule(row, creds.get(id) ?? []),
      changedKeys,
      oldSpecHash: oldSpec ? specHash(oldSpec) : null,
      newSpecHash: specHash(jsonOf<unknown>(row.spec, null)),
      revisionBumped,
    };
  },

  /**
   * Enables / disables a rule (revision bumped). Enabling re-checks the spec
   * against the current policy and makes the caller the accountable user;
   * disabling closes the rule's open alerts silently before the probes are
   * told to stop.
   */
  async setEnabled(tenantId: number, viewer: DeviceCheckViewer, id: number, enabled: boolean): Promise<DeviceCheckRule | null> {
    const userId = viewer.userId;
    const existing = await db('device_check_rules').where({ id, tenant_id: tenantId }).first() as Row | undefined;
    if (!existing) return null;
    // Enabling makes the caller accountable for what the probes run.
    await assertAuthoringScope(tenantId, viewer, scopeOf(existing), 'write');
    if (enabled) {
      const spec = jsonOf<DeviceCheckSpec | null>(existing.spec, null);
      if (!spec || !rowToRuleRecord(existing)) {
        throw new AppError(400, 'The rule spec is no longer valid: edit and save the rule first');
      }
      await assertSpecAllowed(tenantId, spec, viewer);
    }
    const [row] = await db('device_check_rules').where({ id, tenant_id: tenantId }).update({
      enabled,
      revision: db.raw('revision + 1'),
      updated_by: userId,
      ...(enabled ? { suspended_reason: null } : {}),
      updated_at: new Date(),
    }).returning('*') as Row[];
    if (!row) return null;
    // Results still in flight must meet the new state, not a cached assignment.
    invalidateTenantCaches(tenantId);
    if (!enabled) {
      await closeAlertsSilently(tenantId, id, 'rule_disabled').catch((err: unknown) =>
        logger.warn({ err: (err as Error)?.message, ruleId: id }, 'Closing the alerts of a disabled rule failed'));
    }
    invalidateAccountableCache(userId);
    afterRuleChange(tenantId, id, await scopeSiteIds(tenantId, scopeOf(row)));
    const creds = await credentialsOf(tenantId, [id]);
    return rowToRule(row, creds.get(id) ?? []);
  },

  /** Deletes a rule (state rows and credentials cascade). */
  async remove(tenantId: number, viewer: DeviceCheckViewer, id: number): Promise<{ name: string; enabled: boolean } | null> {
    const existing = await db('device_check_rules').where({ id, tenant_id: tenantId }).first() as Row | undefined;
    if (!existing) return null;
    await assertAuthoringScope(tenantId, viewer, scopeOf(existing), 'write');
    const sites = existing.enabled === true ? await scopeSiteIds(tenantId, scopeOf(existing)) : null;
    const deleted = await db('device_check_rules').where({ id, tenant_id: tenantId }).delete();
    if (!deleted) return null;
    afterRuleChange(tenantId, id, sites);
    return { name: String(existing.name), enabled: existing.enabled === true };
  },

  // ── Credentials (write-only) ────────────────────────────────────────────

  /**
   * Stores the Basic auth credentials of a rule: the default (siteId null)
   * or a site override. Encrypted with DATA_ENCRYPTION_KEY (409
   * encryption_key_missing without it); replacing bumps secret_version.
   * A site override must be for a site the rule covers (400 otherwise).
   * Returns the rule's credential metadata (never a secret).
   */
  async setCredentials(tenantId: number, viewer: DeviceCheckViewer, ruleId: number, input: CredentialsInput): Promise<DeviceCheckCredentialInfo[] | null> {
    const userId = viewer.userId;
    if (!secretBox.isAvailable()) throw new AppError(409, 'encryption_key_missing');
    const rule = await db('device_check_rules').where({ id: ruleId, tenant_id: tenantId }).first('id', 'enabled', 'group_id', 'site_id') as Row | undefined;
    if (!rule) return null;
    await assertAuthoringScope(tenantId, viewer, scopeOf(rule), 'write');
    const siteId = input.siteId ?? null;
    if (siteId !== null) {
      const site = await db('sites').where({ id: siteId, tenant_id: tenantId }).first('id');
      if (!site) throw new AppError(404, 'Site not found');
      const covered = await scopeSiteIds(tenantId, scopeOf(rule));
      if (covered !== 'all' && !covered.includes(siteId)) {
        throw new AppError(400, 'The site is outside the scope of this device check');
      }
    }

    try {
      await db.transaction(async (trx) => {
        const q = trx('device_check_credentials').where({ tenant_id: tenantId, rule_id: ruleId }).forUpdate();
        if (siteId === null) q.whereNull('site_id');
        else q.where('site_id', siteId);
        const existing = await q.first('id', 'secret_version') as Row | undefined;
        const version = existing ? (Number(existing.secret_version) || 1) + 1 : 1;
        const box = secretBox.encryptJson({ u: input.username, p: input.password }, credentialAad(tenantId, ruleId, siteId, version));
        const columns = {
          kind: 'basic',
          username_masked: maskUsername(input.username),
          ciphertext: box.ciphertext,
          iv: box.iv,
          auth_tag: box.authTag,
          key_id: box.keyId,
          secret_version: version,
          updated_by: userId,
          updated_at: new Date(),
        };
        if (existing) {
          await trx('device_check_credentials').where({ id: existing.id }).update(columns);
        } else {
          await trx('device_check_credentials').insert({ tenant_id: tenantId, rule_id: ruleId, site_id: siteId, ...columns });
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'The credentials were changed concurrently, try again');
      throw err;
    }

    afterRuleChange(tenantId, ruleId, rule.enabled === true
      ? (siteId !== null ? [siteId] : await scopeSiteIds(tenantId, scopeOf(rule)))
      : null);
    return (await credentialsOf(tenantId, [ruleId])).get(ruleId) ?? [];
  },

  /** Deletes the default (siteId null) or a site override. null when the rule does not exist; false when nothing was stored. */
  async clearCredentials(
    tenantId: number,
    viewer: DeviceCheckViewer,
    ruleId: number,
    siteId: number | null,
  ): Promise<DeviceCheckCredentialInfo[] | null | false> {
    const rule = await db('device_check_rules').where({ id: ruleId, tenant_id: tenantId }).first('id', 'enabled', 'group_id', 'site_id') as Row | undefined;
    if (!rule) return null;
    await assertAuthoringScope(tenantId, viewer, scopeOf(rule), 'write');
    const q = db('device_check_credentials').where({ tenant_id: tenantId, rule_id: ruleId });
    if (siteId === null) q.whereNull('site_id');
    else q.where('site_id', siteId);
    const deleted = await q.delete();
    if (!deleted) return false;
    afterRuleChange(tenantId, ruleId, rule.enabled === true
      ? (siteId !== null ? [siteId] : await scopeSiteIds(tenantId, scopeOf(rule)))
      : null);
    return (await credentialsOf(tenantId, [ruleId])).get(ruleId) ?? [];
  },

  // ── Preview ─────────────────────────────────────────────────────────────

  /**
   * Devices a match would target (form preview): counts per site and a
   * sample of 50. Without full access, the scope must be a group or site the
   * viewer can read (403 scope_not_allowed) and only the sites they may read
   * are counted and sampled.
   */
  async previewMatches(tenantId: number, input: PreviewInput, viewer: DeviceCheckViewer): Promise<{
    total: number;
    bySite: Array<{ siteId: number; siteName: string; count: number; withoutCapableProbe: boolean }>;
    sitesWithoutCapableProbe: number;
    sample: SiteItem[];
  }> {
    const scope = { groupId: input.groupId ?? null, siteId: input.siteId ?? null };
    await assertScopeOwned(tenantId, scope.groupId, scope.siteId);
    await assertAuthoringScope(tenantId, viewer, scope, 'read');
    const visible = await permissionService.getVisibleSiteIds(viewer.userId, tenantId, viewer.isPlatformAdmin);
    const items = visible !== 'all' && visible.length === 0 ? [] : limitToVisibleSites(await matchedItems(tenantId, input.match, scope, [
      'id', 'site_id', 'tenant_id', 'ip', 'mac', 'hostname', 'custom_name', 'device_type', 'vendor', 'notes', 'status',
      'is_manual', 'discovered_by_probe_id', 'first_seen_at', 'last_seen_at', 'created_at', 'updated_at',
    ]), visible);
    const capable = await capableSiteIds(tenantId);
    const counts = new Map<number, number>();
    for (const i of items) counts.set(Number(i.site_id), (counts.get(Number(i.site_id)) ?? 0) + 1);
    const siteIds = [...counts.keys()];
    const names = new Map<number, string>();
    for (let i = 0; i < siteIds.length; i += 1000) {
      const rows = await db('sites').where({ tenant_id: tenantId }).whereIn('id', siteIds.slice(i, i + 1000)).select('id', 'name') as Row[];
      for (const r of rows) names.set(Number(r.id), String(r.name));
    }
    const bySite = siteIds
      .map((siteId) => ({
        siteId,
        siteName: names.get(siteId) ?? `Site #${siteId}`,
        count: counts.get(siteId) ?? 0,
        withoutCapableProbe: !capable.has(siteId),
      }))
      .sort((a, b) => a.siteName.localeCompare(b.siteName));
    return {
      total: items.length,
      bySite,
      sitesWithoutCapableProbe: bySite.filter((s) => s.withoutCapableProbe).length,
      sample: items.slice(0, 50).map(rowToSiteItem),
    };
  },

  // ── Read models (tenant members) ────────────────────────────────────────

  /**
   * Latest state of every check of a site (enabled rules). 404 when the site
   * is not the tenant's. The route checks the site read permission
   * (requireSiteRead).
   */
  async siteStates(tenantId: number, siteId: number): Promise<DeviceCheckStateDetail[]> {
    const site = await db('sites').where({ id: siteId, tenant_id: tenantId }).first('id');
    if (!site) throw new AppError(404, 'Site not found');
    const rows = await db('device_check_state as s')
      .join('device_check_rules as r', function joinRule() {
        this.on('r.id', '=', 's.rule_id').andOn('r.tenant_id', '=', 's.tenant_id');
      })
      .where('s.tenant_id', tenantId)
      .where('s.site_id', siteId)
      .where('r.enabled', true)
      .select('s.*', 'r.id as r_id', 'r.tenant_id as r_tenant_id', 'r.name as r_name', 'r.enabled as r_enabled',
        'r.spec as r_spec', 'r.revision as r_revision')
      .orderBy([{ column: 's.site_item_id', order: 'asc' }, { column: 's.rule_id', order: 'asc' }]) as Row[];
    const now = new Date();
    const rules = new Map<number, ReturnType<typeof rowToRuleRecord>>();
    const out: DeviceCheckStateDetail[] = [];
    for (const r of rows) {
      const ruleId = Number(r.rule_id);
      if (!rules.has(ruleId)) {
        rules.set(ruleId, rowToRuleRecord({
          id: r.r_id, tenant_id: r.r_tenant_id, name: r.r_name, enabled: r.r_enabled, spec: r.r_spec, revision: r.r_revision,
        }));
      }
      const rule = rules.get(ruleId);
      if (!rule) continue;
      const values = jsonOf<Record<string, DeviceCheckValue>>(r.values, {});
      const summary = buildCheckSummary({
        stateId: Number(r.id),
        ruleId,
        ruleName: rule.name,
        spec: rule.spec,
        status: (r.status as DeviceCheckStateDetail['status']) ?? 'pending',
        alertState: (r.alert_state as DeviceCheckStateDetail['alertState']) ?? 'ok',
        values,
        lastCheckedAt: dateOrNull(r.last_checked_at),
        lastErrorCode: (r.last_error_code as string | null) ?? null,
      }, now);
      out.push({
        ...summary,
        siteItemId: Number(r.site_item_id),
        siteId: Number(r.site_id),
        probeId: (r.probe_id as number | null) ?? null,
        variantId: (r.variant_id as string | null) ?? null,
        values,
        valuesChangedAt: jsonOf<Record<string, string>>(r.values_changed_at, {}),
        fields: rule.spec.fields,
        assertions: jsonOf<DeviceCheckAssertionResult[] | null>(r.assertions, null),
        lastTrace: jsonOf<DeviceCheckTraceStep[] | null>(r.last_trace, null),
        lastError: (r.last_error as string | null) ?? null,
        alertSince: isoOrNull(r.alert_since),
      });
    }
    return out;
  },

  /**
   * History of one check (newest first, cursor on id). 404 when the state is
   * not the tenant's, or when `viewer` may not read its site (nothing is
   * revealed about checks of other sites).
   */
  async stateEvents(
    tenantId: number,
    viewer: DeviceCheckViewer,
    stateId: number,
    opts: { before?: number; limit?: number },
  ): Promise<{ events: DeviceCheckEvent[]; nextCursor: number | null }> {
    const state = await db('device_check_state').where({ id: stateId, tenant_id: tenantId })
      .first('rule_id', 'site_item_id', 'site_id') as Row | undefined;
    if (!state) throw new AppError(404, 'Check not found');
    if (!(await permissionService.canReadSite(viewer.userId, Number(state.site_id), tenantId, viewer.isPlatformAdmin))) {
      throw new AppError(404, 'Check not found');
    }
    const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 50)));
    const q = db('device_check_events')
      .where({ tenant_id: tenantId, rule_id: state.rule_id, site_item_id: state.site_item_id })
      .orderBy('id', 'desc')
      .limit(limit + 1);
    if (opts.before !== undefined) q.where('id', '<', opts.before);
    const rows = await q as Row[];
    const events = rows.slice(0, limit).map((r): DeviceCheckEvent => ({
      id: Number(r.id),
      kind: String(r.kind),
      fromStatus: (r.from_status as string | null) ?? null,
      toStatus: (r.to_status as string | null) ?? null,
      details: jsonOf<Record<string, unknown> | null>(r.details, null),
      createdAt: iso(r.created_at),
    }));
    return { events, nextCursor: rows.length > limit && events.length > 0 ? events[events.length - 1].id : null };
  },

  /**
   * Per-site counts of the tenant's checks (enabled rules), for the Sites
   * page: only the sites `viewer` may read (permissionService.getVisibleSiteIds).
   */
  async summary(tenantId: number, viewer: DeviceCheckViewer): Promise<DeviceCheckSiteSummary[]> {
    const visible = await permissionService.getVisibleSiteIds(viewer.userId, tenantId, viewer.isPlatformAdmin);
    if (visible !== 'all' && visible.length === 0) return [];
    const q = db('device_check_state as s')
      .join('device_check_rules as r', function joinRule() {
        this.on('r.id', '=', 's.rule_id').andOn('r.tenant_id', '=', 's.tenant_id');
      })
      .where('s.tenant_id', tenantId)
      .where('r.enabled', true);
    if (visible !== 'all') q.whereIn('s.site_id', visible);
    const rows = await q
      .groupBy('s.site_id')
      .select('s.site_id')
      .select(db.raw('count(*) as total'))
      .select(db.raw(`count(*) filter (where s.status = 'ok') as ok`))
      .select(db.raw(`count(*) filter (where s.status = 'fail') as failing`))
      .select(db.raw(`count(*) filter (where s.status = 'error') as error`))
      .select(db.raw(`count(*) filter (where s.alert_state = 'alerting') as alerting`))
      .select(db.raw(`count(*) filter (where s.last_checked_at < now() - make_interval(secs => greatest(3 * (
          CASE WHEN (r.spec->'schedule'->>'intervalSeconds') ~ '^[0-9]{1,6}$'
               THEN (r.spec->'schedule'->>'intervalSeconds')::int ELSE 60 END), 180))) as stale`))
      .orderBy('s.site_id', 'asc') as Row[];
    return rows.map((r) => ({
      siteId: Number(r.site_id),
      total: Number(r.total) || 0,
      ok: Number(r.ok) || 0,
      failing: Number(r.failing) || 0,
      error: Number(r.error) || 0,
      alerting: Number(r.alerting) || 0,
      stale: Number(r.stale) || 0,
    }));
  },
};
