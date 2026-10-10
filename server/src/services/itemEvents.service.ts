import type { Knex } from 'knex';
import {
  ITEM_ALERT_MODES,
  ITEM_EVENT_KINDS,
  type ItemAlertMode,
  type ItemEventKind,
  type ItemEventsResult,
  type SiteItemEvent,
} from '@oblimap/shared';
import { db } from '../db';
import { logger } from '../utils/logger';
import { toDbId } from '../utils/dbId';

// Device event history (site_item_events, migration 052).
// Reference: Obliance server/src/services/changeEvent.service.ts (from / to /
// kinds, 30-day window cap, truncated flag, newest first).
//
// Writers: the scan pipeline (probe.service processDevices: discovered,
// ip_changed, offline, online, takeover, ip_reassigned — one batched insert
// per push), the manual device routes (site.controller: created, edited,
// deleted, with the acting user; never the notes text) and the stale device
// purge (deviceChecks/sweeper.ts: purged). A failed write is logged and never
// blocks the caller (alerts, pushes, API answers).
// Readers: GET /api/items/events and GET /api/items/:id/events
// (items.controller), limited to the sites the user may read.
// Retention: 180 days (deviceChecks/sweeper.ts, hourly).

/** Longest window one query covers (a wider one is cut to its last 30 days). */
export const ITEM_EVENTS_MAX_WINDOW_DAYS = 30;
const MAX_WINDOW_MS = ITEM_EVENTS_MAX_WINDOW_DAYS * 86_400_000;
/** Default window of the tenant / site history, and of one device's history. */
export const ITEM_EVENTS_DEFAULT_WINDOW_MS = 24 * 3_600_000;
export const ITEM_EVENTS_ITEM_DEFAULT_WINDOW_MS = MAX_WINDOW_MS;
export const ITEM_EVENTS_DEFAULT_LIMIT = 200;
export const ITEM_EVENTS_MAX_LIMIT = 500;
/** site_item_events rows older than this are deleted by the hourly retention. */
export const ITEM_EVENTS_RETENTION_DAYS = 180;
/** Rows per INSERT (a push of a /16 can change thousands of devices at once). */
export const ITEM_EVENTS_INSERT_CHUNK = 1000;
/** details larger than this (JSON) are replaced by a marker. */
const MAX_DETAILS_JSON = 2048;

// ─── Per-device alert mode ─────────────────────────────────────────

/** site_items.alert_mode → 'inherit' | 'always' | 'never' (absent or unknown: 'inherit'). */
export function itemAlertModeOf(v: unknown): ItemAlertMode {
  return typeof v === 'string' && (ITEM_ALERT_MODES as readonly string[]).includes(v) ? v as ItemAlertMode : 'inherit';
}

/**
 * Whether a device's offline / back-online event may raise a NEW live alert
 * or notification (pure; unit-tested), once notificationEnabled and the
 * event's notify* key allow it:
 *  - 'never': no;
 *  - 'always': yes, even when alertOnlyWatchedDevices is on;
 *  - 'inherit': unless alertOnlyWatchedDevices is on.
 * Resolving an existing offline alert never depends on it.
 */
export function deviceAlertAllowed(alertMode: unknown, alertOnlyWatchedDevices: boolean): boolean {
  const mode = itemAlertModeOf(alertMode);
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return !alertOnlyWatchedDevices;
}

// ─── Writing ──────────────────────────────────────────────────────────────────

export interface ItemEventInput {
  tenantId: number;
  siteId: number;
  itemId?: number | null;
  mac?: string | null;
  ip?: string | null;
  kind: ItemEventKind;
  details?: Record<string, unknown> | null;
  actorUserId?: number | null;
  probeId?: number | null;
  /** Event time (default: now). */
  at?: Date;
}

export interface ItemEventRow {
  tenant_id: number;
  site_id: number;
  item_id: number | null;
  mac: string | null;
  ip: string | null;
  kind: ItemEventKind;
  details: string | null;
  actor_user_id: number | null;
  probe_id: number | null;
  created_at: Date;
}

export function isItemEventKind(v: unknown): v is ItemEventKind {
  return typeof v === 'string' && (ITEM_EVENT_KINDS as readonly string[]).includes(v);
}

function shortText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

function detailsJson(details: Record<string, unknown> | null | undefined): string | null {
  if (!details || typeof details !== 'object') return null;
  let json: string;
  try {
    json = JSON.stringify(details);
  } catch {
    return null;
  }
  if (json === '{}') return null;
  return json.length <= MAX_DETAILS_JSON ? json : JSON.stringify({ truncated: true });
}

/**
 * site_item_events rows of the inputs (pure; unit-tested). Inputs with an
 * unknown kind or without a valid tenant / site are dropped; the other ids
 * must be valid or are stored as NULL; mac / ip are cut to their column size.
 */
export function toEventRows(inputs: readonly ItemEventInput[], now: Date = new Date()): ItemEventRow[] {
  const rows: ItemEventRow[] = [];
  for (const e of inputs) {
    const tenantId = toDbId(e?.tenantId);
    const siteId = toDbId(e?.siteId);
    if (tenantId === null || siteId === null || !isItemEventKind(e.kind)) continue;
    const at = e.at instanceof Date && Number.isFinite(e.at.getTime()) ? e.at : now;
    rows.push({
      tenant_id: tenantId,
      site_id: siteId,
      item_id: toDbId(e.itemId),
      mac: shortText(e.mac, 17),
      ip: shortText(e.ip, 45),
      kind: e.kind,
      details: detailsJson(e.details),
      actor_user_id: toDbId(e.actorUserId),
      probe_id: toDbId(e.probeId),
      created_at: at,
    });
  }
  return rows;
}

/** The rows in INSERT chunks (one chunk for up to ITEM_EVENTS_INSERT_CHUNK rows). */
export function chunkEventRows<T>(rows: readonly T[], size: number = ITEM_EVENTS_INSERT_CHUNK): T[][] {
  const chunks: T[][] = [];
  const n = Math.max(1, Math.floor(size));
  for (let i = 0; i < rows.length; i += n) chunks.push(rows.slice(i, i + n));
  return chunks;
}

export type ItemEventInserter = (rows: ItemEventRow[]) => Promise<void>;

// The table comes from migration 052: once seen it is never checked again;
// while it is missing it is re-checked at most once a minute, so a database
// without it never fails a push nor floods the log.
let eventsTableSeen: { at: number; exists: boolean } | null = null;
let eventsTableCheck: Promise<boolean> | null = null;

function hasEventsTable(): Promise<boolean> {
  const seen = eventsTableSeen;
  if (seen && (seen.exists || Date.now() - seen.at < 60_000)) return Promise.resolve(seen.exists);
  if (!eventsTableCheck) {
    eventsTableCheck = db.schema.hasTable('site_item_events')
      .then((exists) => {
        eventsTableSeen = { at: Date.now(), exists };
        return exists;
      })
      .catch((err: unknown) => {
        logger.warn({ err: (err as Error)?.message }, 'site_item_events lookup failed');
        return false;
      })
      .finally(() => { eventsTableCheck = null; });
  }
  return eventsTableCheck;
}

function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23503';
}

/**
 * Inserts the rows. A device, probe or user deleted between the event and
 * the insert (foreign key on item_id / probe_id / actor_user_id): the
 * references that no longer exist are set NULL (mac / ip kept), then the
 * insert is retried once.
 */
const defaultInserter: ItemEventInserter = async (rows) => {
  if (!(await hasEventsTable())) return;
  try {
    await db('site_item_events').insert(rows);
  } catch (err) {
    if (!isForeignKeyViolation(err)) throw err;
    const existingIds = async (table: string, ids: Array<number | null | undefined>): Promise<Set<number>> => {
      const wanted = [...new Set(ids.filter((id): id is number => id !== null && id !== undefined))];
      if (wanted.length === 0) return new Set<number>();
      const found = await db(table).whereIn('id', wanted).select('id') as Array<{ id: number }>;
      return new Set(found.map((r) => Number(r.id)));
    };
    const [items, probes, users] = await Promise.all([
      existingIds('site_items', rows.map((r) => r.item_id)),
      existingIds('probes', rows.map((r) => r.probe_id)),
      existingIds('users', rows.map((r) => r.actor_user_id)),
    ]);
    const keep = (id: number | null | undefined, set: Set<number>): number | null => (
      id !== null && id !== undefined && set.has(id) ? id : null
    );
    await db('site_item_events').insert(rows.map((r) => ({
      ...r,
      item_id: keep(r.item_id, items),
      probe_id: keep(r.probe_id, probes),
      actor_user_id: keep(r.actor_user_id, users),
    })));
  }
};

/**
 * Writes the events in one INSERT (chunks of ITEM_EVENTS_INSERT_CHUNK rows
 * beyond that). Never throws: a failure is logged and 0 returned. Returns the
 * number of rows written.
 */
export async function recordBatch(
  inputs: readonly ItemEventInput[],
  insert: ItemEventInserter = defaultInserter,
): Promise<number> {
  const rows = toEventRows(inputs);
  if (rows.length === 0) return 0;
  let written = 0;
  for (const chunk of chunkEventRows(rows)) {
    try {
      await insert(chunk);
      written += chunk.length;
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, count: chunk.length }, 'Device events not written');
    }
  }
  return written;
}

// ─── Reading ──────────────────────────────────────────────────────────────────

export interface ItemEventWindow {
  from: Date;
  to: Date;
  /** The requested window was wider than ITEM_EVENTS_MAX_WINDOW_DAYS. */
  capped: boolean;
}

/**
 * The window of a query (pure; unit-tested): `to` defaults to now, `from` to
 * `to` minus `defaultMs`; a window wider than 30 days keeps its last 30 days.
 * Null when from is after to.
 */
export function resolveEventWindow(
  from: Date | null | undefined,
  to: Date | null | undefined,
  now: Date = new Date(),
  defaultMs: number = ITEM_EVENTS_DEFAULT_WINDOW_MS,
): ItemEventWindow | null {
  const end = to ?? now;
  const start = from ?? new Date(end.getTime() - Math.min(defaultMs, MAX_WINDOW_MS));
  if (start.getTime() > end.getTime()) return null;
  if (end.getTime() - start.getTime() > MAX_WINDOW_MS) {
    return { from: new Date(end.getTime() - MAX_WINDOW_MS), to: end, capped: true };
  }
  return { from: start, to: end, capped: false };
}

/** An ISO date or epoch milliseconds → Date; null when absent, NaN-date when invalid. */
function parseTimestamp(v: unknown): Date | null | 'invalid' {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 40) return 'invalid';
  const d = /^\d{1,15}$/.test(v) ? new Date(Number(v)) : new Date(v);
  return Number.isFinite(d.getTime()) ? d : 'invalid';
}

/** A comma list or repeated parameter → trimmed non-empty strings. */
function listParam(v: unknown): string[] | 'invalid' {
  if (v === undefined || v === null || v === '') return [];
  const parts = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string') return 'invalid';
    for (const s of p.split(',')) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out.length > 50 ? 'invalid' : out;
}

export interface ItemEventsQuery {
  siteId?: number;
  groupId?: number;
  kinds: ItemEventKind[];
  from: Date;
  to: Date;
  limit: number;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Query string of the history routes (pure; unit-tested): siteId, groupId,
 * kinds (comma list or repeated), from / to (ISO or epoch ms), limit (1..500,
 * default 200). `defaultWindowMs` applies when from is absent.
 */
export function parseItemEventsQuery(
  query: Record<string, unknown>,
  now: Date = new Date(),
  defaultWindowMs: number = ITEM_EVENTS_DEFAULT_WINDOW_MS,
): ParseResult<ItemEventsQuery> {
  const value: Partial<ItemEventsQuery> = {};
  for (const key of ['siteId', 'groupId'] as const) {
    const raw = query[key];
    if (raw === undefined || raw === '') continue;
    const id = toDbId(raw);
    if (id === null) return { ok: false, error: `Invalid ${key}` };
    value[key] = id;
  }

  const kinds = listParam(query.kinds ?? query.kind);
  if (kinds === 'invalid') return { ok: false, error: 'Invalid kinds' };
  const unknown = kinds.find((k) => !isItemEventKind(k));
  if (unknown !== undefined) return { ok: false, error: 'Invalid kinds' };

  const from = parseTimestamp(query.from);
  const to = parseTimestamp(query.to);
  if (from === 'invalid') return { ok: false, error: 'Invalid from' };
  if (to === 'invalid') return { ok: false, error: 'Invalid to' };
  const window = resolveEventWindow(from, to, now, defaultWindowMs);
  if (!window) return { ok: false, error: 'from must be before to' };

  let limit = ITEM_EVENTS_DEFAULT_LIMIT;
  if (query.limit !== undefined && query.limit !== '') {
    const n = typeof query.limit === 'string' && /^\d{1,6}$/.test(query.limit) ? Number(query.limit) : NaN;
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'Invalid limit' };
    limit = Math.min(n, ITEM_EVENTS_MAX_LIMIT);
  }

  return {
    ok: true,
    value: {
      ...value,
      kinds: [...new Set(kinds)] as ItemEventKind[],
      from: window.from,
      to: window.to,
      limit,
    },
  };
}

export interface ItemEventsQueryOptions {
  tenantId: number;
  /** Sites the user may read (permissionService.getVisibleSiteIds). */
  visibleSiteIds: number[] | 'all';
  siteId?: number;
  /** The group and its sub-groups (closure table). */
  groupId?: number;
  itemId?: number;
  kinds?: readonly ItemEventKind[];
  from: Date;
  to: Date;
  limit: number;
}

/**
 * The SELECT of a history query (newest first, limit + 1 rows to detect a
 * truncation). Exported for the unit tests (toSQL only, never run there).
 */
export function buildEventQuery(opts: ItemEventsQueryOptions): Knex.QueryBuilder {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit)), ITEM_EVENTS_MAX_LIMIT);
  const q = db('site_item_events as e')
    .join('sites as s', function joinSite() {
      this.on('s.id', '=', 'e.site_id').andOn('s.tenant_id', '=', 'e.tenant_id');
    })
    .leftJoin('site_items as si', function joinItem() {
      this.on('si.id', '=', 'e.item_id').andOn('si.tenant_id', '=', 'e.tenant_id');
    })
    .leftJoin('probes as p', function joinProbe() {
      this.on('p.id', '=', 'e.probe_id').andOn('p.tenant_id', '=', 'e.tenant_id');
    })
    .leftJoin('users as u', 'u.id', 'e.actor_user_id')
    .where('e.tenant_id', opts.tenantId)
    .where('e.created_at', '>=', opts.from)
    .where('e.created_at', '<=', opts.to);
  if (opts.visibleSiteIds !== 'all') q.whereIn('e.site_id', opts.visibleSiteIds);
  if (opts.siteId !== undefined) q.where('e.site_id', opts.siteId);
  if (opts.groupId !== undefined) {
    // The group and its sub-groups (closure, depth >= 0), tenant's groups only.
    q.whereIn('s.group_id', db('group_closure as gc')
      .join('monitor_groups as g', 'g.id', 'gc.descendant_id')
      .where('gc.ancestor_id', opts.groupId)
      .where('g.tenant_id', opts.tenantId)
      .select('gc.descendant_id'));
  }
  if (opts.itemId !== undefined) q.where('e.item_id', opts.itemId);
  if (opts.kinds && opts.kinds.length > 0) q.whereIn('e.kind', [...opts.kinds]);
  return q
    .orderBy('e.created_at', 'desc')
    .orderBy('e.id', 'desc')
    .limit(limit + 1)
    .select(
      'e.id', 'e.site_id', 'e.item_id', 'e.mac', 'e.ip', 'e.kind', 'e.details',
      'e.actor_user_id', 'e.probe_id', 'e.created_at',
      's.name as site_name',
      'si.custom_name as item_custom_name', 'si.hostname as item_hostname', 'si.ip as item_ip',
      'p.name as probe_name', 'p.hostname as probe_hostname',
      'u.username as actor_username',
    );
}

function parseDetails(v: unknown): Record<string, unknown> | null {
  let parsed = v;
  if (typeof v === 'string') {
    try { parsed = JSON.parse(v); } catch { return null; }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

function iso(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
}

function nullableText(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** A history row (buildEventQuery's columns) → SiteItemEvent. */
export function rowToEvent(row: Record<string, unknown>): SiteItemEvent {
  const itemId = row.item_id != null ? Number(row.item_id) : null;
  const itemName = itemId !== null
    ? nullableText(row.item_custom_name) ?? nullableText(row.item_hostname) ?? nullableText(row.item_ip)
    : null;
  return {
    id: Number(row.id),
    siteId: Number(row.site_id),
    siteName: String(row.site_name ?? ''),
    itemId,
    itemName,
    mac: nullableText(row.mac),
    ip: nullableText(row.ip),
    kind: row.kind as ItemEventKind,
    details: parseDetails(row.details),
    actorUserId: row.actor_user_id != null ? Number(row.actor_user_id) : null,
    actorUsername: nullableText(row.actor_username),
    probeId: row.probe_id != null ? Number(row.probe_id) : null,
    probeName: row.probe_id != null ? nullableText(row.probe_name) ?? nullableText(row.probe_hostname) : null,
    createdAt: iso(row.created_at),
  };
}

/**
 * Events of the sites the user may read, newest first, within the window
 * (cut to its last 30 days), at most `limit` (≤ 500); truncated when more
 * matched (the oldest are left out).
 */
export async function query(opts: ItemEventsQueryOptions): Promise<ItemEventsResult> {
  const window = resolveEventWindow(opts.from, opts.to, opts.to) ?? { from: opts.to, to: opts.to, capped: false };
  const limit = Math.min(Math.max(1, Math.floor(opts.limit)), ITEM_EVENTS_MAX_LIMIT);
  const empty: ItemEventsResult = {
    events: [], truncated: false, from: window.from.toISOString(), to: window.to.toISOString(),
  };
  if (Array.isArray(opts.visibleSiteIds) && opts.visibleSiteIds.length === 0) return empty;
  if (opts.siteId !== undefined && Array.isArray(opts.visibleSiteIds) && !opts.visibleSiteIds.includes(opts.siteId)) {
    return empty;
  }
  if (!(await hasEventsTable())) return empty;
  const rows = await buildEventQuery({ ...opts, from: window.from, to: window.to, limit }) as Array<Record<string, unknown>>;
  const truncated = rows.length > limit;
  return {
    events: (truncated ? rows.slice(0, limit) : rows).map(rowToEvent),
    truncated,
    from: empty.from,
    to: empty.to,
  };
}

export const itemEventsService = {
  recordBatch,
  query,
  parseItemEventsQuery,
  resolveEventWindow,
};
