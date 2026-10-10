import type { Knex } from 'knex';
import { db } from '../db';
import {
  DEVICE_TYPES,
  type DeviceType,
  type IpReservation,
  type ItemIpHistory,
  type ItemStatus,
  type SiteItem,
} from '@oblimap/shared';
import { logger } from '../utils/logger';
import { toDbId } from '../utils/dbId';
import { SITE_ITEM_STATUSES } from '../validators/site.schema';
import { isIPv4 } from '../validators/probe.schema';
import { flowService } from './flow.service';
import {
  isReservationOwner, reservationState, type ReservationIpItem, type ReservationOwner,
} from './site.service';
import { pushConfigToAffectedProbes } from './deviceChecks/config.service';
import { itemAlertModeOf, recordBatch as recordItemEvents } from './itemEvents.service';

// Tenant-wide device (site item) queries: GET /api/items (search / filters /
// facets / paging), the item detail, its IP history and the bulk actions
// (items.controller.ts). Every query filters on the tenant; the caller passes
// the sites the user may read (permissionService.getVisibleSiteIds, 'all' for
// full access) and every list is limited to them.
// Search pattern: Obliance server/src/services/device.service.ts listDevices.

// ─── Limits ───────────────────────────────────────────────────────────────────

export const ITEM_SEARCH_MAX_LENGTH = 100;
export const ITEM_PAGE_SIZE_DEFAULT = 50;
export const ITEM_PAGE_SIZE_MAX = 200;
/** Highest page number accepted (offset = (page - 1) × pageSize). */
export const ITEM_PAGE_MAX = 10_000;
export const ITEM_STALE_DAYS_MAX = 3650;
export const ITEM_BULK_MAX_IDS = 1000;
/** Rows of the IP history / other sites returned for one item. */
const IP_HISTORY_LIMIT = 500;
const OTHER_SITES_LIMIT = 50;

export const ITEM_SORT_KEYS = ['ip', 'name', 'lastSeen', 'firstSeen', 'site'] as const;
export type ItemSortKey = (typeof ITEM_SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

// Strict dotted quad: only such values are cast to inet when sorting (one bad
// legacy value must not make the whole list fail). Same expression as
// site.service.ts getItems.
const IPV4_SORTABLE_RE = '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])[.]){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$';

// ─── SQL fragments (alias si = site_items) ────────────────────────────────────

/**
 * The device intrudes on a reservation of its IP: it holds the IP (not
 * offline) and is not the reservation's owner (reserved MAC, or item) — the
 * same rule as site.service itemConflictsWithReservation.
 */
const RESERVATION_CONFLICT_SQL = `EXISTS (
  SELECT 1 FROM ip_reservations r
   WHERE r.tenant_id = si.tenant_id
     AND r.site_id = si.site_id
     AND r.ip = si.ip
     AND si.status <> 'offline'
     AND NOT (r.reserved_mac IS NOT NULL AND si.mac IS NOT NULL
              AND upper(btrim(r.reserved_mac)) = upper(btrim(si.mac)))
     AND r.item_id IS DISTINCT FROM si.id)`;

/** An unresolved IP takeover alert names the device's IP on its site. */
const TAKEOVER_ALERT_SQL = `EXISTS (
  SELECT 1 FROM live_alerts la
   WHERE la.tenant_id = si.tenant_id
     AND la.resolved_at IS NULL
     AND starts_with(la.stable_key, 'ip-takeover:' || si.site_id::text || ':' || si.ip || ':'))`;

/** A check of an enabled rule currently fails on the device. */
const FAILING_CHECK_SQL = `EXISTS (
  SELECT 1 FROM device_check_state st
    JOIN device_check_rules dr ON dr.id = st.rule_id AND dr.tenant_id = st.tenant_id
   WHERE st.tenant_id = si.tenant_id
     AND st.site_item_id = si.id
     AND st.status = 'fail'
     AND dr.enabled = true)`;

/** No name given, type unknown and no reservation on the IP. */
const UNDOCUMENTED_SQL = `((si.custom_name IS NULL OR btrim(si.custom_name) = '')
  AND si.device_type = 'unknown'
  AND NOT EXISTS (
    SELECT 1 FROM ip_reservations r
     WHERE r.tenant_id = si.tenant_id AND r.site_id = si.site_id AND r.ip = si.ip))`;

// ─── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Escapes the LIKE wildcards (% _) and the escape character itself. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** MAC separators (: - . and spaces) removed: "AA:BB:CC" → "AABBCC". */
export function stripMacSeparators(s: string): string {
  return s.replace(/[\s:.-]/g, '');
}

export interface ItemSearch {
  /** ILIKE pattern over ip, mac, hostname, custom_name, vendor, notes. */
  pattern: string;
  /**
   * ILIKE pattern over the MAC without separators, when the search is made of
   * hex digits once separators are removed ("aabbcc", "aa-bb-cc", "AABB.CC").
   */
  macPattern: string | null;
}

/**
 * The search text: trimmed, control characters removed, internal blanks
 * collapsed. null when empty. The caller checks the length limit first.
 */
export function normalizeSearch(q: string): ItemSearch | null {
  // eslint-disable-next-line no-control-regex
  const text = q.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const hex = stripMacSeparators(text);
  // Digits and dots only is an IPv4 fragment ("10.0.0.1"), not a dotted MAC.
  const looksLikeIp = /^[\d.]+$/.test(text) && text.includes('.');
  // A MAC search needs at least 4 hex digits or a MAC separator: once the
  // separators are stripped on both sides, a short fragment such as "10" or
  // "192" would match across octet boundaries (A1:0B:�) and list unrelated
  // devices.
  const macLike = hex.length >= 4 || /[:-]/.test(text);
  const macPattern = !looksLikeIp && macLike && /^[0-9a-f]{2,12}$/i.test(hex) ? `%${hex.toUpperCase()}%` : null;
  return { pattern: `%${escapeLike(text)}%`, macPattern };
}

export interface ItemListFilters {
  search: ItemSearch | null;
  statuses: ItemStatus[];
  types: DeviceType[];
  /** ILIKE pattern over the vendor. */
  vendorPattern: string | null;
  siteId?: number;
  groupId?: number;
  /** first_seen_at >= newSince. */
  newSince?: Date;
  conflict: boolean;
  failingChecks: boolean;
  undocumented: boolean;
  /** last_seen_at < staleBefore. */
  staleBefore?: Date;
  sort: ItemSortKey;
  dir: SortDir;
  page: number;
  pageSize: number;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A query value as a list: "a,b", ["a", "b"] or status[]=a&status[]=b. */
export function queryList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const raw: unknown[] = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    for (const part of entry.split(',')) {
      const s = part.trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** A single query value: the string, the first entry of a repeated parameter, else undefined. */
function queryOne(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

function queryFlag(v: unknown): boolean {
  const s = queryOne(v);
  return s === '1' || s === 'true';
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * ?new=: "24h", "7d" (any N h / N d up to ITEM_STALE_DAYS_MAX days) or an
 * ISO date / timestamp (a "new since my last visit" marker). The lower bound
 * of first_seen_at.
 */
export function parseNewSince(v: string, now: Date): Date | null {
  const rel = /^(\d{1,5})([hd])$/.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const hours = rel[2] === 'h' ? n : n * 24;
    if (n < 1 || hours > ITEM_STALE_DAYS_MAX * 24) return null;
    return new Date(now.getTime() - hours * 3_600_000);
  }
  if (!ISO_DATE_RE.test(v)) return null;
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return null;
  const year = d.getUTCFullYear();
  return year >= 1970 && year <= 9999 ? d : null;
}

function parsePositiveInt(v: string | undefined, max: number): number | null {
  if (v === undefined || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= max ? n : null;
}

/**
 * GET /api/items query string → filters. Invalid values answer 400 (error
 * text); page / pageSize are clamped. Pure: `now` anchors the relative dates.
 */
export function parseItemListQuery(query: Record<string, unknown>, now: Date = new Date()): ParseResult<ItemListFilters> {
  const q = queryOne(query.q);
  if (q !== undefined && q.length > ITEM_SEARCH_MAX_LENGTH) {
    return { ok: false, error: `q is limited to ${ITEM_SEARCH_MAX_LENGTH} characters` };
  }

  const statuses = queryList(query.status);
  for (const s of statuses) {
    if (!(SITE_ITEM_STATUSES as readonly string[]).includes(s)) return { ok: false, error: `Invalid status: ${s.slice(0, 32)}` };
  }
  const types = queryList(query.type);
  for (const t of types) {
    if (!(DEVICE_TYPES as readonly string[]).includes(t)) return { ok: false, error: `Invalid type: ${t.slice(0, 32)}` };
  }
  if (statuses.length > SITE_ITEM_STATUSES.length || types.length > DEVICE_TYPES.length) {
    return { ok: false, error: 'Too many filter values' };
  }

  const vendor = queryOne(query.vendor)?.trim();
  if (vendor !== undefined && vendor.length > ITEM_SEARCH_MAX_LENGTH) {
    return { ok: false, error: `vendor is limited to ${ITEM_SEARCH_MAX_LENGTH} characters` };
  }

  const filters: ItemListFilters = {
    search: q !== undefined ? normalizeSearch(q) : null,
    statuses: statuses as ItemStatus[],
    types: types as DeviceType[],
    vendorPattern: vendor ? `%${escapeLike(vendor)}%` : null,
    conflict: queryFlag(query.conflict),
    failingChecks: queryOne(query.checks) === 'failing',
    undocumented: queryFlag(query.undocumented),
    sort: 'ip',
    dir: 'asc',
    page: 1,
    pageSize: ITEM_PAGE_SIZE_DEFAULT,
  };

  const checks = queryOne(query.checks);
  if (checks !== undefined && checks !== '' && checks !== 'failing') return { ok: false, error: 'checks must be "failing"' };

  for (const key of ['siteId', 'groupId'] as const) {
    const raw = queryOne(query[key]);
    if (raw === undefined || raw === '') continue;
    const id = toDbId(raw);
    if (id === null) return { ok: false, error: `Invalid ${key}` };
    filters[key] = id;
  }

  const newRaw = queryOne(query.new);
  if (newRaw !== undefined && newRaw !== '') {
    const since = parseNewSince(newRaw, now);
    if (!since) return { ok: false, error: 'new must be 24h, 7d or an ISO date' };
    filters.newSince = since;
  }

  const staleRaw = queryOne(query.stale);
  if (staleRaw !== undefined && staleRaw !== '') {
    const days = parsePositiveInt(staleRaw, ITEM_STALE_DAYS_MAX);
    if (days === null) return { ok: false, error: `stale must be a number of days (1-${ITEM_STALE_DAYS_MAX})` };
    filters.staleBefore = new Date(now.getTime() - days * 86_400_000);
  }

  const sort = queryOne(query.sort);
  if (sort !== undefined && sort !== '') {
    if (!(ITEM_SORT_KEYS as readonly string[]).includes(sort)) return { ok: false, error: 'Invalid sort' };
    filters.sort = sort as ItemSortKey;
  }
  const dir = queryOne(query.dir);
  if (dir !== undefined && dir !== '') {
    if (dir !== 'asc' && dir !== 'desc') return { ok: false, error: 'dir must be asc or desc' };
    filters.dir = dir;
  }

  const pageRaw = queryOne(query.page);
  if (pageRaw !== undefined && pageRaw !== '') {
    if (!/^\d{1,9}$/.test(pageRaw)) return { ok: false, error: 'Invalid page' };
    filters.page = Math.min(ITEM_PAGE_MAX, Math.max(1, Number(pageRaw)));
  }
  const sizeRaw = queryOne(query.pageSize);
  if (sizeRaw !== undefined && sizeRaw !== '') {
    if (!/^\d{1,9}$/.test(sizeRaw)) return { ok: false, error: 'Invalid pageSize' };
    filters.pageSize = Math.min(ITEM_PAGE_SIZE_MAX, Math.max(1, Number(sizeRaw)));
  }

  return { ok: true, value: filters };
}

/**
 * Bulk ids: valid, unique, in request order. Invalid entries are refused
 * by the route schema; this only removes duplicates.
 */
export function uniqueIds(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

/** Reservation name for a device: its name, else its hostname, else its IP (varchar 128). */
export function reservationNameFor(item: { customName: string | null; hostname: string | null; ip: string }): string {
  const name = (item.customName?.trim() || item.hostname?.trim() || item.ip).slice(0, 128);
  return name || item.ip;
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

function iso(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
}

function openPortsOf(v: unknown): number[] | null {
  if (v === null || v === undefined) return null;
  let parsed = v;
  if (typeof v === 'string') {
    try { parsed = JSON.parse(v); } catch { return null; }
  }
  return Array.isArray(parsed) ? parsed.filter((p): p is number => typeof p === 'number') : null;
}

function rowToItem(row: Record<string, unknown>): SiteItem {
  return {
    id: Number(row.id),
    siteId: Number(row.site_id),
    tenantId: Number(row.tenant_id),
    ip: row.ip as string,
    mac: (row.mac as string | null) ?? null,
    hostname: (row.hostname as string | null) ?? null,
    customName: (row.custom_name as string | null) ?? null,
    deviceType: (row.device_type as DeviceType) ?? 'unknown',
    vendor: (row.vendor as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    status: (row.status as ItemStatus) ?? 'unknown',
    isManual: Boolean(row.is_manual),
    discoveredByProbeId: row.discovered_by_probe_id != null ? Number(row.discovered_by_probe_id) : null,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    openPorts: openPortsOf(row.open_ports),
    // Migration 048: undefined before it has run.
    deviceTypeSource: (row.device_type_source as string | null | undefined) ?? null,
    macRandomized: Boolean(row.mac_randomized),
    hasReservationConflict: Boolean(row.has_reservation_conflict),
    // Migration 052: 'inherit' before it has run.
    alertMode: itemAlertModeOf(row.alert_mode),
  };
}

/** A device of the tenant-wide list: the site item plus where it is. */
export type ItemListEntry = SiteItem & {
  siteName: string;
  groupId: number | null;
  /** A check of an enabled rule currently fails on it. */
  hasFailingCheck: boolean;
};

export interface ItemListResult {
  items: ItemListEntry[];
  total: number;
  page: number;
  pageSize: number;
  facets: { status: Record<string, number>; type: Record<string, number> };
}

export interface ItemDetail {
  item: ItemListEntry;
  site: { id: number; name: string; groupId: number | null };
  probe: { id: number; name: string } | null;
  reservation: IpReservation | null;
  otherSites: Array<{ siteId: number; siteName: string; itemId: number }>;
}

export type BulkAction = 'delete' | 'setType' | 'reserve';

export interface BulkResult {
  affected: number;
  ignored: number;
  /** reserve: devices skipped (IP already reserved, not IPv4, IP twice in the selection). */
  skipped?: number;
  /** delete: flows removed with the devices. */
  flowsDeleted?: number;
}

function rowToListEntry(row: Record<string, unknown>): ItemListEntry {
  return {
    ...rowToItem(row),
    siteName: String(row.site_name ?? ''),
    groupId: row.site_group_id != null ? Number(row.site_group_id) : null,
    hasFailingCheck: Boolean(row.has_failing_check),
  };
}

function rowToReservation(row: Record<string, unknown>): IpReservation {
  return {
    id: Number(row.id),
    siteId: Number(row.site_id),
    tenantId: Number(row.tenant_id),
    ip: row.ip as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    deviceType: (row.device_type as DeviceType | null) ?? null,
    createdBy: row.created_by != null ? Number(row.created_by) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    reservedMac: (row.reserved_mac as string | null) ?? null,
    itemId: row.item_id != null ? Number(row.item_id) : null,
  };
}

function toIpItem(row: Record<string, unknown>): ReservationIpItem {
  return { id: Number(row.id), mac: (row.mac as string | null) ?? null, status: String(row.status ?? 'unknown') };
}

/**
 * Whether site_items.device_type_source exists (migration 048). Checked once;
 * until the migration has run, a bulk type change only writes device_type.
 */
let deviceTypeSourceColumn: Promise<boolean> | null = null;
function hasDeviceTypeSource(): Promise<boolean> {
  if (!deviceTypeSourceColumn) {
    deviceTypeSourceColumn = db.schema.hasColumn('site_items', 'device_type_source').catch((err: unknown) => {
      deviceTypeSourceColumn = null;
      logger.warn({ err: (err as Error)?.message }, 'site_items.device_type_source lookup failed');
      return false;
    });
  }
  return deviceTypeSourceColumn;
}

/** Re-sends the Device Checks assignment of the site (targets changed). Never throws. */
function refreshDeviceChecks(tenantId: number, siteId: number): void {
  pushConfigToAffectedProbes(tenantId, [siteId]).catch((err: unknown) =>
    logger.warn({ err: (err as Error)?.message, tenantId, siteId }, 'Device checks config push after a bulk device change failed'));
}

// ─── Query building ───────────────────────────────────────────────────────────

type FacetName = 'status' | 'type';

/**
 * site_items si JOIN sites s of the tenant, limited to the visible sites and
 * to the filters, except the facet left out (facet counts ignore their own
 * filter, so the other values stay selectable).
 */
function filteredItems(
  tenantId: number,
  visible: number[] | 'all',
  f: ItemListFilters,
  omit?: FacetName,
): Knex.QueryBuilder {
  const q = db('site_items as si')
    .join('sites as s', function joinSite() {
      this.on('s.id', '=', 'si.site_id').andOn('s.tenant_id', '=', 'si.tenant_id');
    })
    .where('si.tenant_id', tenantId);
  if (visible !== 'all') q.whereIn('si.site_id', visible);
  if (f.siteId !== undefined) q.where('si.site_id', f.siteId);
  if (f.groupId !== undefined) {
    // The group and its sub-groups (closure table, depth >= 0), tenant's groups only.
    q.whereIn('s.group_id', db('group_closure as gc')
      .join('monitor_groups as g', 'g.id', 'gc.descendant_id')
      .where('gc.ancestor_id', f.groupId)
      .where('g.tenant_id', tenantId)
      .select('gc.descendant_id'));
  }
  if (f.search) {
    const { pattern, macPattern } = f.search;
    q.where(function search() {
      this.whereILike('si.ip', pattern)
        .orWhereILike('si.mac', pattern)
        .orWhereILike('si.hostname', pattern)
        .orWhereILike('si.custom_name', pattern)
        .orWhereILike('si.vendor', pattern)
        .orWhereILike('si.notes', pattern);
      if (macPattern) {
        this.orWhereRaw(`upper(regexp_replace(COALESCE(si.mac, ''), '[^0-9A-Fa-f]', '', 'g')) LIKE ?`, [macPattern]);
      }
    });
  }
  if (omit !== 'status' && f.statuses.length > 0) q.whereIn('si.status', f.statuses);
  if (omit !== 'type' && f.types.length > 0) q.whereIn('si.device_type', f.types);
  if (f.vendorPattern) q.whereILike('si.vendor', f.vendorPattern);
  if (f.newSince) q.where('si.first_seen_at', '>=', f.newSince);
  if (f.staleBefore) q.where('si.last_seen_at', '<', f.staleBefore);
  if (f.conflict) q.whereRaw(`(${RESERVATION_CONFLICT_SQL} OR ${TAKEOVER_ALERT_SQL})`);
  if (f.failingChecks) q.whereRaw(FAILING_CHECK_SQL);
  if (f.undocumented) q.whereRaw(UNDOCUMENTED_SQL);
  return q;
}

/** ORDER BY of the list; every order ends with si.id (stable paging). */
function applySort(q: Knex.QueryBuilder, sort: ItemSortKey, dir: SortDir): void {
  const d = dir === 'desc' ? 'DESC' : 'ASC';
  const ipOrder = `CASE WHEN si.ip ~ ? THEN si.ip::inet END ${d} NULLS LAST, si.ip ${d}`;
  switch (sort) {
    case 'ip':
      q.orderByRaw(ipOrder, [IPV4_SORTABLE_RE]);
      break;
    case 'name':
      q.orderByRaw(`lower(COALESCE(NULLIF(btrim(si.custom_name), ''), NULLIF(btrim(si.hostname), ''), si.ip)) ${d}`);
      break;
    case 'lastSeen':
      q.orderBy('si.last_seen_at', dir);
      break;
    case 'firstSeen':
      q.orderBy('si.first_seen_at', dir);
      break;
    case 'site':
      q.orderByRaw(`lower(s.name) ${d}`)
        .orderByRaw('CASE WHEN si.ip ~ ? THEN si.ip::inet END ASC NULLS LAST, si.ip ASC', [IPV4_SORTABLE_RE]);
      break;
  }
  q.orderBy('si.id', 'asc');
}

const LIST_COLUMNS = [
  'si.*',
  's.name as site_name',
  's.group_id as site_group_id',
];

function listSelect(q: Knex.QueryBuilder): Knex.QueryBuilder {
  return q.select(
    ...LIST_COLUMNS,
    db.raw(`${RESERVATION_CONFLICT_SQL} as has_reservation_conflict`),
    db.raw(`${FAILING_CHECK_SQL} as has_failing_check`),
  );
}

async function facetCounts(
  tenantId: number,
  visible: number[] | 'all',
  f: ItemListFilters,
  facet: FacetName,
): Promise<Record<string, number>> {
  const column = facet === 'status' ? 'si.status' : 'si.device_type';
  const rows = await filteredItems(tenantId, visible, f, facet)
    .groupBy(column)
    .select(`${column} as key`)
    .count('* as count') as Array<{ key: string | null; count: string | number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.key ?? 'unknown'] = (out[r.key ?? 'unknown'] ?? 0) + Number(r.count);
  return out;
}

/**
 * isProbe / probeId of the listed devices: a device whose MAC or one of whose
 * IPs is a probe of its site (site.service getItems does the same per site).
 */
async function markProbes(tenantId: number, items: ItemListEntry[]): Promise<void> {
  const siteIds = [...new Set(items.map((i) => i.siteId))];
  if (siteIds.length === 0) return;
  const probes = await db('probes')
    .where('tenant_id', tenantId)
    .whereIn('site_id', siteIds)
    .select('id', 'site_id', 'ip', 'mac', 'ips') as Array<{ id: number; site_id: number; ip: string | null; mac: string | null; ips: unknown }>;
  const byIp = new Map<string, number>();
  const byMac = new Map<string, number>();
  for (const p of probes) {
    const site = Number(p.site_id);
    if (p.mac) byMac.set(`${site}|${p.mac.toUpperCase()}`, Number(p.id));
    if (p.ip) byIp.set(`${site}|${p.ip}`, Number(p.id));
    let ips: unknown = p.ips;
    if (typeof ips === 'string') {
      try { ips = JSON.parse(ips); } catch { ips = []; }
    }
    if (Array.isArray(ips)) {
      for (const ip of ips) {
        if (typeof ip === 'string' && !byIp.has(`${site}|${ip}`)) byIp.set(`${site}|${ip}`, Number(p.id));
      }
    }
  }
  for (const item of items) {
    const probeId = (item.mac ? byMac.get(`${item.siteId}|${item.mac.toUpperCase()}`) : undefined)
      ?? byIp.get(`${item.siteId}|${item.ip}`)
      ?? null;
    item.isProbe = probeId !== null;
    item.probeId = probeId;
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const itemService = {
  /** GET /api/items: one page of the visible devices, the total and the facets. */
  async list(tenantId: number, visible: number[] | 'all', f: ItemListFilters): Promise<ItemListResult> {
    const empty: ItemListResult = {
      items: [], total: 0, page: f.page, pageSize: f.pageSize, facets: { status: {}, type: {} },
    };
    if (Array.isArray(visible) && visible.length === 0) return empty;

    const pageQuery = listSelect(filteredItems(tenantId, visible, f));
    applySort(pageQuery, f.sort, f.dir);
    pageQuery.limit(f.pageSize).offset((f.page - 1) * f.pageSize);

    const [rows, totalRow, status, type] = await Promise.all([
      pageQuery as Promise<Array<Record<string, unknown>>>,
      filteredItems(tenantId, visible, f).count('* as total').first() as Promise<{ total: string | number } | undefined>,
      facetCounts(tenantId, visible, f, 'status'),
      facetCounts(tenantId, visible, f, 'type'),
    ]);

    const items = rows.map(rowToListEntry);
    try {
      await markProbes(tenantId, items);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'Probe flags not loaded for the device list');
    }
    return {
      items,
      total: Number(totalRow?.total ?? 0),
      page: f.page,
      pageSize: f.pageSize,
      facets: { status, type },
    };
  },

  /** The item with its site (tenant-scoped), or null. The caller checks read access. */
  async getRow(tenantId: number, itemId: number): Promise<ItemListEntry | null> {
    const row = await listSelect(
      db('site_items as si')
        .join('sites as s', function joinSite() {
          this.on('s.id', '=', 'si.site_id').andOn('s.tenant_id', '=', 'si.tenant_id');
        })
        .where({ 'si.id': itemId, 'si.tenant_id': tenantId }),
    ).first() as Record<string, unknown> | undefined;
    return row ? rowToListEntry(row) : null;
  },

  /**
   * GET /api/items/:id body for an item the caller may read: its site, the
   * discovering probe, the reservation of its IP (with its state) and the
   * other visible sites where its MAC appears.
   */
  async getDetail(tenantId: number, item: ItemListEntry, visible: number[] | 'all'): Promise<ItemDetail> {
    const [probeRow, reservationRow, otherRows] = await Promise.all([
      item.discoveredByProbeId != null
        ? db('probes')
          .where({ id: item.discoveredByProbeId, tenant_id: tenantId })
          .first('id', 'name', 'hostname') as Promise<{ id: number; name: string | null; hostname: string | null } | undefined>
        : Promise.resolve(undefined),
      db('ip_reservations')
        .where({ site_id: item.siteId, tenant_id: tenantId, ip: item.ip })
        .first() as Promise<Record<string, unknown> | undefined>,
      item.mac && !(Array.isArray(visible) && visible.length === 0)
        ? db('site_items as si')
          .join('sites as s', function joinSite() {
            this.on('s.id', '=', 'si.site_id').andOn('s.tenant_id', '=', 'si.tenant_id');
          })
          .where('si.tenant_id', tenantId)
          // Plain column comparison (no upper()) so the (tenant_id, mac) index applies.
          .whereIn('si.mac', [...new Set([item.mac, item.mac.toUpperCase(), item.mac.toLowerCase()])])
          .whereNot('si.site_id', item.siteId)
          .modify((q) => { if (visible !== 'all') q.whereIn('si.site_id', visible); })
          .orderBy([{ column: 's.name', order: 'asc' }, { column: 'si.id', order: 'asc' }])
          .limit(OTHER_SITES_LIMIT * 4)
          .select('si.id', 'si.site_id', 's.name as site_name') as Promise<Array<Record<string, unknown>>>
        : Promise.resolve([] as Array<Record<string, unknown>>),
    ]);

    await markProbes(tenantId, [item]).catch((err: unknown) =>
      logger.warn({ err: (err as Error)?.message }, 'Probe flag not loaded for the device'));

    let reservation: IpReservation | null = null;
    if (reservationRow) {
      reservation = rowToReservation(reservationRow);
      const owner: ReservationOwner = { reservedMac: reservation.reservedMac ?? null, itemId: reservation.itemId ?? null };
      const onIp = (await db('site_items')
        .where({ site_id: item.siteId, tenant_id: tenantId, ip: item.ip })
        .orderBy('id', 'asc')
        .select('id', 'mac', 'status') as Array<Record<string, unknown>>).map(toIpItem);
      const ownerMac = owner.reservedMac?.trim().toUpperCase();
      const ownerRows = owner.itemId == null && !ownerMac ? [] : (await db('site_items')
        .where({ site_id: item.siteId, tenant_id: tenantId })
        .where((q) => {
          if (owner.itemId != null) q.orWhere('id', owner.itemId);
          if (ownerMac) q.orWhereRaw('upper(mac) = ?', [ownerMac]);
        })
        .select('id', 'mac', 'status') as Array<Record<string, unknown>>).map(toIpItem);
      const holders = onIp.filter((i) => i.status !== 'offline');
      reservation.isOccupied = holders.length > 0;
      // An intruder first (what a conflict is about), else the holder (as site.service).
      reservation.occupiedByMac = (holders.find((i) => !isReservationOwner(owner, i)) ?? holders[0])?.mac ?? null;
      reservation.state = reservationState(owner, onIp, ownerRows);
    }

    const otherSites: ItemDetail['otherSites'] = [];
    const seen = new Set<number>();
    for (const r of otherRows) {
      const siteId = Number(r.site_id);
      if (seen.has(siteId)) continue;
      seen.add(siteId);
      otherSites.push({ siteId, siteName: String(r.site_name ?? ''), itemId: Number(r.id) });
      if (otherSites.length >= OTHER_SITES_LIMIT) break;
    }

    return {
      item,
      site: { id: item.siteId, name: item.siteName, groupId: item.groupId },
      probe: probeRow
        ? { id: Number(probeRow.id), name: (probeRow.name && probeRow.name.trim()) || probeRow.hostname || `#${probeRow.id}` }
        : null,
      reservation,
      otherSites,
    };
  },

  /** item_ip_history of the item's MAC on its site, newest first. [] without a MAC. */
  async ipHistory(tenantId: number, item: Pick<SiteItem, 'siteId' | 'mac'>): Promise<ItemIpHistory[]> {
    if (!item.mac) return [];
    const rows = await db('item_ip_history')
      .where({ tenant_id: tenantId, site_id: item.siteId, mac: item.mac })
      .orderBy([{ column: 'last_seen_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(IP_HISTORY_LIMIT) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      mac: r.mac as string,
      siteId: Number(r.site_id),
      tenantId: Number(r.tenant_id),
      ip: r.ip as string,
      firstSeenAt: iso(r.first_seen_at),
      lastSeenAt: iso(r.last_seen_at),
    }));
  },

  /**
   * POST /api/items/bulk on one site (write access checked by the caller).
   * Only ids of that site and tenant are touched; the others are ignored.
   */
  async bulk(
    tenantId: number,
    siteId: number,
    ids: readonly number[],
    action: BulkAction,
    params: { deviceType?: DeviceType; description?: string | null },
    userId: number,
  ): Promise<BulkResult> {
    const requested = uniqueIds(ids);
    const owned = await db('site_items')
      .where({ site_id: siteId, tenant_id: tenantId })
      .whereIn('id', requested)
      .orderBy('id', 'asc')
      .select('id', 'ip', 'mac', 'hostname', 'custom_name', 'device_type') as Array<Record<string, unknown>>;
    const ownedIds = owned.map((r) => Number(r.id));
    const ignored = requested.length - ownedIds.length;
    if (ownedIds.length === 0) return { affected: 0, ignored, ...(action === 'reserve' ? { skipped: 0 } : {}) };

    if (action === 'delete') {
      const result = await db.transaction(async (trx) => {
        const deleted = await trx('site_items')
          .where({ site_id: siteId, tenant_id: tenantId })
          .whereIn('id', ownedIds)
          .del(['id', 'ip', 'mac', 'custom_name', 'hostname']) as Array<{
            id: number; ip: string; mac: string | null; custom_name: string | null; hostname: string | null;
          }>;
        const deletedIps = [...new Set(deleted.map((r) => r.ip))];
        // Flows of an IP another device of the site still holds are kept.
        const stillHeld = deletedIps.length === 0 ? [] : await trx('site_items')
          .where({ site_id: siteId, tenant_id: tenantId })
          .whereIn('ip', deletedIps)
          .distinct('ip')
          .pluck('ip') as string[];
        const held = new Set(stillHeld);
        const flowsDeleted = await flowService.clearFlowsForIps(
          tenantId, siteId, deletedIps.filter((ip) => !held.has(ip)), trx,
        );
        return { affected: deleted.length, flowsDeleted, deleted };
      });
      // Device history: one 'deleted' event per removed row (the rows are
      // gone: the id rides in details). Never throws (recordBatch logs).
      await recordItemEvents(result.deleted.map((r) => ({
        tenantId,
        siteId,
        actorUserId: userId,
        kind: 'deleted' as const,
        itemId: null,
        mac: r.mac ?? null,
        ip: r.ip ?? null,
        details: {
          itemId: Number(r.id),
          name: (r.custom_name && r.custom_name.trim()) || (r.hostname && r.hostname.trim()) || r.ip || null,
        },
      })));
      if (result.affected > 0) refreshDeviceChecks(tenantId, siteId);
      return { affected: result.affected, ignored, flowsDeleted: result.flowsDeleted };
    }

    if (action === 'setType') {
      const deviceType = params.deviceType as DeviceType;
      const patch: Record<string, unknown> = { device_type: deviceType, updated_at: new Date() };
      // A type chosen by a person: never reclassified automatically. Set back
      // to 'unknown', the device is classified again (as the single PATCH does).
      if (await hasDeviceTypeSource()) patch.device_type_source = deviceType === 'unknown' ? null : 'manual';
      const affected = await db('site_items')
        .where({ site_id: siteId, tenant_id: tenantId })
        .whereIn('id', ownedIds)
        .update(patch);
      if (affected > 0) {
        await recordItemEvents(owned.map((r) => ({
          tenantId,
          siteId,
          actorUserId: userId,
          kind: 'edited' as const,
          itemId: Number(r.id),
          mac: (r.mac as string | null) ?? null,
          ip: (r.ip as string | null) ?? null,
          details: { fields: ['deviceType'], deviceType },
        })));
        refreshDeviceChecks(tenantId, siteId);
      }
      return { affected, ignored };
    }

    // reserve: one reservation per device IP, owned by the device (its MAC
    // and item id); IPs already reserved on the site are skipped.
    const reserved = new Set(await db('ip_reservations')
      .where({ site_id: siteId, tenant_id: tenantId })
      .whereIn('ip', [...new Set(owned.map((r) => r.ip as string))])
      .pluck('ip') as string[]);
    const now = new Date();
    const rows: Array<Record<string, unknown>> = [];
    let skipped = 0;
    for (const r of owned) {
      const ip = r.ip as string;
      if (!isIPv4(ip) || reserved.has(ip)) { skipped++; continue; }
      reserved.add(ip);
      const deviceType = (r.device_type as string | null) ?? 'unknown';
      rows.push({
        site_id: siteId,
        tenant_id: tenantId,
        ip,
        name: reservationNameFor({
          customName: (r.custom_name as string | null) ?? null,
          hostname: (r.hostname as string | null) ?? null,
          ip,
        }),
        description: params.description ?? null,
        device_type: deviceType === 'unknown' ? null : deviceType,
        reserved_mac: (r.mac as string | null) ?? null,
        item_id: Number(r.id),
        created_by: userId,
        created_at: now,
        updated_at: now,
      });
    }
    let affected = 0;
    if (rows.length > 0) {
      // unique (site_id, ip): a reservation created meanwhile is skipped too.
      const inserted = await db('ip_reservations')
        .insert(rows)
        .onConflict(['site_id', 'ip'])
        .ignore()
        .returning('id') as unknown[];
      affected = inserted.length;
      skipped += rows.length - affected;
    }
    return { affected, ignored, skipped };
  },
};
