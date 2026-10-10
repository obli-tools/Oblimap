import type { BusinessHours } from '@oblimap/shared';
import { db } from '../db';
import { logger } from '../utils/logger';
import { isOpen, parseBusinessHours, BUSINESS_DAYS, type BusinessDay } from '../utils/businessHours';

/**
 * Maintenance windows (port of Obliance maintenance.service): while
 * a window covering a site is active, the IPAM pipeline (probe.service)
 * raises no new live alert and sends no channel notification for that site —
 * device / probe states are still updated and alerts still resolve.
 *
 * Scope: 'tenant' (every site of the tenant, and probes without a site),
 * 'group' (the sites of the group and of its sub-groups, group_closure) or
 * 'site'. Kinds: 'one_time' (starts_at ≤ now < ends_at) and 'recurring'
 * (weekly days + HH:MM range in the window's time zone, evaluated with
 * utils/businessHours: a range whose end is before its start crosses
 * midnight and ends on the next day, '24:00' ends the day).
 *
 * isSiteInMaintenance caches the tenant's enabled windows and the site's
 * group chain for 30 s; every CRUD invalidates the tenant's entries. Any
 * lookup failure (table not migrated yet, database error) answers "not in
 * maintenance": alerting stays as it was.
 */

export const MAINTENANCE_SCOPES = ['tenant', 'group', 'site'] as const;
export type MaintenanceScope = (typeof MAINTENANCE_SCOPES)[number];
export const MAINTENANCE_KINDS = ['one_time', 'recurring'] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export interface MaintenanceRecurrence {
  days: BusinessDay[];
  /** 'HH:MM' local start. */
  start: string;
  /** 'HH:MM' local end ('24:00' = end of the day); before start = crosses midnight. */
  end: string;
}

export interface MaintenanceWindow {
  id: number;
  uuid: string;
  tenantId: number;
  name: string;
  scope: MaintenanceScope;
  scopeId: number | null;
  /** Name of the scoped group / site (null for 'tenant', or when it was deleted). */
  scopeName: string | null;
  kind: MaintenanceKind;
  startsAt: string | null;
  endsAt: string | null;
  recurrence: MaintenanceRecurrence | null;
  timezone: string;
  enabled: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  /** Active at the time of the read. */
  active: boolean;
}

export interface MaintenanceWindowInput {
  name: string;
  scope: MaintenanceScope;
  scopeId: number | null;
  kind: MaintenanceKind;
  startsAt: string | null;
  endsAt: string | null;
  recurrence: MaintenanceRecurrence | null;
  timezone: string;
  enabled: boolean;
}

/** The fields isWindowActive / windowCoversSite read. */
export interface MaintenanceWindowSpec {
  scope: MaintenanceScope;
  scopeId: number | null;
  kind: MaintenanceKind;
  startsAt: string | Date | null;
  endsAt: string | Date | null;
  recurrence: MaintenanceRecurrence | null;
  timezone: string;
  enabled: boolean;
}

/** Where a site sits: its id and its group chain (own group and every ancestor). */
export interface MaintenanceTarget {
  /** null: a probe without a site (only tenant windows apply). */
  siteId: number | null;
  groupIds: readonly number[];
}

// ── Pure evaluation ──────────────────────────────────────────────────────────

function timeOf(v: string | Date | null): number {
  if (v === null) return NaN;
  return (v instanceof Date ? v : new Date(v)).getTime();
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** A stored recurrence (jsonb, or its text) as a MaintenanceRecurrence, or null when unusable. */
export function recurrenceOf(v: unknown): MaintenanceRecurrence | null {
  const r = parseJson(v);
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return null;
  const o = r as Record<string, unknown>;
  if (!Array.isArray(o.days) || typeof o.start !== 'string' || typeof o.end !== 'string') return null;
  const days = BUSINESS_DAYS.filter((d) => (o.days as unknown[]).includes(d));
  return { days, start: o.start, end: o.end };
}

/** The recurrence as a businessHours schedule (one range on each listed day). */
export function recurrenceSchedule(r: MaintenanceRecurrence, timezone: string): BusinessHours {
  const days: NonNullable<BusinessHours['days']> = {};
  for (const d of r.days) days[d] = [[r.start, r.end]];
  return { tz: timezone || 'UTC', days };
}

/**
 * Whether the window is active at `now` (scope not considered). A disabled
 * window, a one-time window without both bounds, or a recurring window
 * without days (an empty businessHours schedule would mean "always open")
 * is never active. An invalid recurrence / time zone is never active either.
 */
export function isWindowActive(w: MaintenanceWindowSpec, now: Date = new Date()): boolean {
  if (!w.enabled) return false;
  const t = now.getTime();
  if (w.kind === 'one_time') {
    const start = timeOf(w.startsAt);
    const end = timeOf(w.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return start <= t && t < end;
  }
  const r = w.recurrence;
  if (!r || r.days.length === 0) return false;
  try {
    return isOpen(recurrenceSchedule(r, w.timezone), now);
  } catch {
    return false;
  }
}

/** Whether the window's scope covers the target (scope inheritance through the group chain). */
export function windowCoversSite(w: Pick<MaintenanceWindowSpec, 'scope' | 'scopeId'>, target: MaintenanceTarget): boolean {
  switch (w.scope) {
    case 'tenant': return true;
    case 'group': return w.scopeId !== null && target.groupIds.includes(w.scopeId);
    case 'site': return w.scopeId !== null && target.siteId !== null && w.scopeId === target.siteId;
    default: return false;
  }
}

/** The windows active at `now` that cover the target. */
export function activeWindowsFor<T extends MaintenanceWindowSpec>(windows: readonly T[], target: MaintenanceTarget, now: Date = new Date()): T[] {
  return windows.filter((w) => windowCoversSite(w, target) && isWindowActive(w, now));
}

/**
 * Normalises an input: canonical time zone (AppError 400 when unknown),
 * recurrence days in mon..sun order, the fields of the other kind / scope
 * cleared.
 */
export function normalizeInput(input: MaintenanceWindowInput): MaintenanceWindowInput {
  const timezone = parseBusinessHours({ tz: input.timezone || 'UTC' }).tz ?? 'UTC';
  const recurring = input.kind === 'recurring';
  const recurrence = recurring && input.recurrence
    ? { days: BUSINESS_DAYS.filter((d) => input.recurrence!.days.includes(d)), start: input.recurrence.start, end: input.recurrence.end }
    : null;
  if (recurrence) {
    // Validated by the businessHours parser too (HH:MM, start ≠ end).
    parseBusinessHours(recurrenceSchedule(recurrence, timezone));
  }
  return {
    name: input.name.trim(),
    scope: input.scope,
    scopeId: input.scope === 'tenant' ? null : input.scopeId,
    kind: input.kind,
    startsAt: recurring ? null : input.startsAt,
    endsAt: recurring ? null : input.endsAt,
    recurrence,
    timezone,
    enabled: input.enabled,
  };
}

// ── Rows ─────────────────────────────────────────────────────────────────────

interface MaintenanceRow {
  id: number;
  uuid: string;
  tenant_id: number;
  name: string;
  scope: string;
  scope_id: number | null;
  kind: string;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  recurrence: unknown;
  timezone: string;
  enabled: boolean;
  created_by: number | null;
  created_at: Date | string;
  updated_at: Date | string;
  group_name?: string | null;
  site_name?: string | null;
}

function iso(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function scopeOf(v: string): MaintenanceScope {
  return (MAINTENANCE_SCOPES as readonly string[]).includes(v) ? v as MaintenanceScope : 'site';
}

function rowToWindow(row: MaintenanceRow, now: Date = new Date()): MaintenanceWindow {
  const scope = scopeOf(row.scope);
  const w: Omit<MaintenanceWindow, 'active'> = {
    id: Number(row.id),
    uuid: row.uuid,
    tenantId: Number(row.tenant_id),
    name: row.name,
    scope,
    scopeId: row.scope_id != null ? Number(row.scope_id) : null,
    scopeName: scope === 'group' ? row.group_name ?? null : scope === 'site' ? row.site_name ?? null : null,
    kind: row.kind === 'recurring' ? 'recurring' : 'one_time',
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    recurrence: recurrenceOf(row.recurrence),
    timezone: row.timezone || 'UTC',
    enabled: !!row.enabled,
    createdBy: row.created_by != null ? Number(row.created_by) : null,
    createdAt: iso(row.created_at) ?? '',
    updatedAt: iso(row.updated_at) ?? '',
  };
  return { ...w, active: isWindowActive(w, now) };
}

function inputColumns(input: MaintenanceWindowInput): Record<string, unknown> {
  return {
    name: input.name,
    scope: input.scope,
    scope_id: input.scopeId,
    kind: input.kind,
    starts_at: input.startsAt ? new Date(input.startsAt) : null,
    ends_at: input.endsAt ? new Date(input.endsAt) : null,
    recurrence: input.recurrence ? JSON.stringify(input.recurrence) : null,
    timezone: input.timezone,
    enabled: input.enabled,
  };
}

/** Windows of the tenant, with the scoped group / site name (same tenant only). */
function windowsQuery(tenantId: number) {
  return db('maintenance_windows as mw')
    .leftJoin('monitor_groups as g', function () {
      this.on('g.id', '=', 'mw.scope_id').andOn('g.tenant_id', '=', 'mw.tenant_id').andOnVal('mw.scope', '=', 'group');
    })
    .leftJoin('sites as s', function () {
      this.on('s.id', '=', 'mw.scope_id').andOn('s.tenant_id', '=', 'mw.tenant_id').andOnVal('mw.scope', '=', 'site');
    })
    .where('mw.tenant_id', tenantId)
    .select('mw.*', 'g.name as group_name', 's.name as site_name');
}

// ── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;
const MAX_CACHED_SITES = 10_000;

/** Enabled windows per tenant. */
const windowCache = new Map<number, { at: number; windows: MaintenanceWindowSpec[] }>();
/** Group chain per `${tenantId}:${siteId}`. */
const targetCache = new Map<string, { at: number; target: MaintenanceTarget }>();

let warnedAt = 0;
function warnLookup(err: unknown, tenantId: number): void {
  if (Date.now() - warnedAt < 600_000) return;
  warnedAt = Date.now();
  logger.warn({ err: (err as Error)?.message, tenantId }, 'Maintenance windows lookup failed — alerting not suppressed');
}

/** Drops the cached windows (and site chains) of a tenant, or of every tenant. */
export function invalidateMaintenanceCache(tenantId?: number): void {
  if (tenantId === undefined) {
    windowCache.clear();
    targetCache.clear();
    return;
  }
  windowCache.delete(tenantId);
  for (const key of targetCache.keys()) {
    if (key.startsWith(`${tenantId}:`)) targetCache.delete(key);
  }
}

async function enabledWindows(tenantId: number): Promise<MaintenanceWindowSpec[]> {
  const hit = windowCache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.windows;
  const rows = await db('maintenance_windows')
    .where({ tenant_id: tenantId, enabled: true })
    .select('scope', 'scope_id', 'kind', 'starts_at', 'ends_at', 'recurrence', 'timezone', 'enabled') as MaintenanceRow[];
  const windows: MaintenanceWindowSpec[] = rows.map((r) => ({
    scope: scopeOf(r.scope),
    scopeId: r.scope_id != null ? Number(r.scope_id) : null,
    kind: r.kind === 'recurring' ? 'recurring' : 'one_time',
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    recurrence: recurrenceOf(r.recurrence),
    timezone: r.timezone || 'UTC',
    enabled: true,
  }));
  windowCache.set(tenantId, { at: Date.now(), windows });
  return windows;
}

/** The site's id and group chain (own group + ancestors), tenant-scoped; null when not in the tenant. */
async function siteTarget(tenantId: number, siteId: number): Promise<MaintenanceTarget | null> {
  const key = `${tenantId}:${siteId}`;
  const hit = targetCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.target;
  const site = await db('sites').where({ id: siteId, tenant_id: tenantId }).first('id', 'group_id') as
    { id: number; group_id: number | null } | undefined;
  if (!site) return null;
  let groupIds: number[] = [];
  if (site.group_id != null) {
    const rows = await db('group_closure as gc')
      .join('monitor_groups as g', 'g.id', 'gc.ancestor_id')
      .where('gc.descendant_id', site.group_id)
      .where('g.tenant_id', tenantId)
      .select('gc.ancestor_id') as Array<{ ancestor_id: number }>;
    groupIds = rows.map((r) => Number(r.ancestor_id));
    if (!groupIds.includes(Number(site.group_id))) groupIds.push(Number(site.group_id));
  }
  const target: MaintenanceTarget = { siteId, groupIds };
  if (targetCache.size >= MAX_CACHED_SITES) targetCache.clear();
  targetCache.set(key, { at: Date.now(), target });
  return target;
}

// ── Service ──────────────────────────────────────────────────────────────────

export const maintenanceService = {
  /**
   * Whether a maintenance window covering the site (tenant, its group chain
   * or the site itself) is active at `now`. siteId null: a probe without a
   * site, covered by tenant windows only. Never throws (false on error).
   */
  async isSiteInMaintenance(tenantId: number, siteId: number | null, now: Date = new Date()): Promise<boolean> {
    try {
      const windows = await enabledWindows(tenantId);
      if (windows.length === 0) return false;
      // Tenant windows need no site lookup.
      if (windows.some((w) => w.scope === 'tenant' && isWindowActive(w, now))) return true;
      if (siteId === null) return false;
      const target = await siteTarget(tenantId, siteId);
      if (!target) return false;
      return activeWindowsFor(windows, target, now).length > 0;
    } catch (err) {
      warnLookup(err, tenantId);
      return false;
    }
  },

  /** The windows active now for the site (UI banner). [] when the site is not in the tenant. */
  async activeForSite(tenantId: number, siteId: number, now: Date = new Date()): Promise<MaintenanceWindow[]> {
    const target = await siteTarget(tenantId, siteId);
    if (!target) return [];
    const rows = await windowsQuery(tenantId).where('mw.enabled', true) as MaintenanceRow[];
    return rows
      .map((r) => rowToWindow(r, now))
      .filter((w) => w.active && windowCoversSite(w, target))
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  async list(tenantId: number): Promise<MaintenanceWindow[]> {
    const rows = await windowsQuery(tenantId).orderBy('mw.name', 'asc').orderBy('mw.id', 'asc') as MaintenanceRow[];
    const now = new Date();
    return rows.map((r) => rowToWindow(r, now));
  },

  async get(tenantId: number, id: number): Promise<MaintenanceWindow | null> {
    const row = await windowsQuery(tenantId).where('mw.id', id).first() as MaintenanceRow | undefined;
    return row ? rowToWindow(row) : null;
  },

  async create(tenantId: number, input: MaintenanceWindowInput, userId: number | null): Promise<MaintenanceWindow> {
    const data = normalizeInput(input);
    const [inserted] = await db('maintenance_windows')
      .insert({ ...inputColumns(data), tenant_id: tenantId, created_by: userId })
      .returning('id') as Array<{ id: number }>;
    invalidateMaintenanceCache(tenantId);
    const created = await this.get(tenantId, Number(inserted.id));
    if (!created) throw new Error('maintenance window vanished after insert');
    return created;
  },

  async update(tenantId: number, id: number, input: MaintenanceWindowInput): Promise<MaintenanceWindow | null> {
    const data = normalizeInput(input);
    const count = await db('maintenance_windows')
      .where({ id, tenant_id: tenantId })
      .update({ ...inputColumns(data), updated_at: new Date() });
    invalidateMaintenanceCache(tenantId);
    if (!count) return null;
    return this.get(tenantId, id);
  },

  async delete(tenantId: number, id: number): Promise<boolean> {
    const count = await db('maintenance_windows').where({ id, tenant_id: tenantId }).delete();
    invalidateMaintenanceCache(tenantId);
    return count > 0;
  },
};
