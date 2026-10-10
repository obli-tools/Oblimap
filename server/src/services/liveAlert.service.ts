import type { Server as SocketIOServer } from 'socket.io';
import type { Knex } from 'knex';
import { db } from '../db';
import { SOCKET_EVENTS, type LiveAlertParams } from '@oblimap/shared';
import { logger } from '../utils/logger';
import { permissionService } from './permission.service';
import { TENANT_CAPABILITIES, type TenantCapability } from './permissionSet.service';

let _io: SocketIOServer | null = null;

export function setLiveAlertIO(io: SocketIOServer): void {
  _io = io;
}

export interface LiveAlertRow {
  id: number;
  tenantId: number;
  tenantName?: string;
  severity: 'down' | 'up' | 'warning' | 'info';
  title: string;
  message: string;
  navigateTo: string | null;
  stableKey: string | null;
  read: boolean;
  createdAt: string; // ISO
  /** ISO time the problem ended, null while it lasts. */
  resolvedAt: string | null;
  /** Site the alert is about (null: tenant-wide alert). */
  siteId: number | null;
  /** Machine-readable kind (shared LIVE_ALERT_KINDS); null on older rows. */
  kind: string | null;
  /** Parameters of the kind (names, IPs, MACs…); null on older rows. */
  params: LiveAlertParams | null;
}

/**
 * Sites of one tenant a viewer may read (permissionService.getVisibleSiteIds):
 * 'all', or the ids. Alerts without a site are listed for every member.
 */
export type AlertSiteVisibility = 'all' | readonly number[];

/**
 * Tenant capabilities of a viewer (viewerAlertCapabilities): 'all' (full
 * access: platform admin, or every capability — tenant admins), or those held.
 */
export type AlertCapabilities = 'all' | readonly TenantCapability[];

// ── Alerts about an admin page ───────────────────────────────────────────────
// An alert whose navigateTo is an admin page ('/manage/…': probe offline
// without a site, probe API key mismatch / identity token rejected, probe
// update checksum mismatch, device check suspended) is only for the members
// who may open that page: the page's tenant capability. Any other admin page:
// full access only. Derived from navigate_to, so rows written before this
// rule are covered too. Site alerts ('/sites/…') are not concerned.
//
// Admin pages moved from /admin/… to /manage/… (the reverse-proxy honeypot
// bans any IP requesting a path starting with /admin). Rows written before
// the move still hold '/admin/…': they are matched here under both prefixes
// and handed out rewritten to '/manage/…' (rowToAlert → toPagePath), so a
// click never loads an /admin URL. Never write '/admin/…' again.

const ADMIN_PAGE_PREFIX = '/manage/';
const LEGACY_ADMIN_PAGE_PREFIX = '/admin/';

/** Legacy '/admin/…' page link → '/manage/…'; anything else unchanged. */
export function toPagePath(navigateTo: string | null): string | null {
  return typeof navigateTo === 'string' && navigateTo.startsWith(LEGACY_ADMIN_PAGE_PREFIX)
    ? ADMIN_PAGE_PREFIX + navigateTo.slice(LEGACY_ADMIN_PAGE_PREFIX.length)
    : navigateTo;
}

const ADMIN_PAGE_CAPABILITIES: ReadonlyArray<readonly [page: string, capability: TenantCapability]> = [
  // Probe pages open with 'probes.read' (probes.manage / probes.approve imply it).
  ['/manage/probes', 'probes.read'],
  ['/manage/device-checks', 'deviceChecks.manage'],
  // Legacy rows (before the /admin → /manage move).
  ['/admin/probes', 'probes.read'],
  ['/admin/device-checks', 'deviceChecks.manage'],
];

/**
 * What a viewer needs to receive / list an alert, from its navigateTo: null
 * (nothing: not an admin page), a tenant capability, or 'all' (full access).
 */
export function alertRequiredCapability(navigateTo: string | null | undefined): TenantCapability | 'all' | null {
  if (typeof navigateTo !== 'string'
    || !(navigateTo.startsWith(ADMIN_PAGE_PREFIX) || navigateTo.startsWith(LEGACY_ADMIN_PAGE_PREFIX))) return null;
  for (const [page, capability] of ADMIN_PAGE_CAPABILITIES) {
    if (navigateTo === page || navigateTo.startsWith(`${page}/`) || navigateTo.startsWith(`${page}?`)) return capability;
  }
  return 'all';
}

/** True when a viewer holding `held` may see an alert needing `required`. */
export function holdsAlertCapability(held: AlertCapabilities, required: TenantCapability | 'all' | null): boolean {
  if (required === null || held === 'all') return true;
  return required !== 'all' && held.includes(required);
}

/** The viewer's AlertCapabilities in a tenant (permissionService, cached 10 s). */
export async function viewerAlertCapabilities(userId: number, tenantId: number, isPlatformAdmin: boolean): Promise<AlertCapabilities> {
  if (isPlatformAdmin) return 'all';
  const held = await permissionService.listUserTenantCapabilities(userId, tenantId);
  return held.length >= TENANT_CAPABILITIES.length ? 'all' : held;
}

/** List filter on navigate_to: what alertRequiredCapability lets `held` see. */
function applyAdminPageAudience(q: Knex.QueryBuilder, column: string, held: readonly TenantCapability[]): void {
  q.whereNull(column).orWhere((b) => b
    .where(column, 'not like', `${ADMIN_PAGE_PREFIX}%`)
    .andWhere(column, 'not like', `${LEGACY_ADMIN_PAGE_PREFIX}%`));
  for (const [page, capability] of ADMIN_PAGE_CAPABILITIES) {
    if (!held.includes(capability)) continue;
    q.orWhere(column, page).orWhere(column, 'like', `${page}/%`).orWhere(column, 'like', `${page}?%`);
  }
}

export interface AlertListOptions {
  /** Also list resolved alerts (default: active ones only). */
  includeResolved?: boolean;
}

function toIso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** A stored params value (jsonb, or JSON text) → flat params; null when absent or malformed. */
export function alertParamsOf(v: unknown): LiveAlertParams | null {
  let parsed = v;
  if (typeof v === 'string') {
    try { parsed = JSON.parse(v); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return sanitizeAlertParams(parsed as LiveAlertParams);
}

/**
 * Params as stored and sent (pure; unit-tested): keys of 1–32 word
 * characters starting with a letter, string / finite number / null values
 * only, strings cut to 255 characters, at most 20 keys. Null when empty.
 */
export function sanitizeAlertParams(params: LiveAlertParams | null | undefined): LiveAlertParams | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const out: LiveAlertParams = {};
  let n = 0;
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (n >= 20) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 255);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (value === null) out[key] = null;
    else continue;
    n++;
  }
  return n > 0 ? out : null;
}

/** A kind as stored: 1–64 characters of [a-z0-9_.-], else null. */
export function sanitizeAlertKind(kind: unknown): string | null {
  return typeof kind === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(kind) ? kind : null;
}

function rowToAlert(row: Record<string, unknown>): LiveAlertRow {
  const siteId = row.site_id != null ? Number(row.site_id) : null;
  return {
    id: row.id as number,
    tenantId: row.tenant_id as number,
    tenantName: row.tenant_name as string | undefined,
    severity: row.severity as LiveAlertRow['severity'],
    title: row.title as string,
    message: row.message as string,
    navigateTo: toPagePath(row.navigate_to as string | null),
    stableKey: row.stable_key as string | null,
    read: row.read_at != null,
    createdAt: (row.created_at as Date).toISOString(),
    resolvedAt: toIso(row.resolved_at),
    siteId: siteId !== null && Number.isInteger(siteId) && siteId > 0 ? siteId : null,
    kind: sanitizeAlertKind(row.kind),
    params: alertParamsOf(row.params),
  };
}

// live_alerts.kind / params come from migration 052: written only once they
// exist (once seen they are never checked again; while missing, re-checked at
// most once a minute).
let structuredColumns: { at: number; exists: boolean } | null = null;
let structuredColumnsCheck: Promise<boolean> | null = null;

function hasStructuredColumns(): Promise<boolean> {
  const seen = structuredColumns;
  if (seen && (seen.exists || Date.now() - seen.at < 60_000)) return Promise.resolve(seen.exists);
  if (!structuredColumnsCheck) {
    structuredColumnsCheck = Promise.all([
      db.schema.hasColumn('live_alerts', 'kind'),
      db.schema.hasColumn('live_alerts', 'params'),
    ])
      .then(([kind, params]) => {
        structuredColumns = { at: Date.now(), exists: kind && params };
        return kind && params;
      })
      .catch((err: unknown) => {
        logger.warn({ err: (err as Error)?.message }, 'live_alerts columns lookup failed');
        return false;
      })
      .finally(() => { structuredColumnsCheck = null; });
  }
  return structuredColumnsCheck;
}

/** Site filter of a list query: alerts without a site, or on a visible site. */
function applySiteVisibility(q: Knex.QueryBuilder, column: string, sites: readonly number[]): void {
  q.whereNull(column);
  if (sites.length > 0) q.orWhereIn(column, [...sites]);
}

// ── Socket delivery ──────────────────────────────────────────────────────────
//
// NOTIFICATION_NEW goes to `tenant:${id}:notifications` (the tenant's members
// and the users currently working in it). An alert about a site (siteId) goes
// only to the sockets of users who may read that site —
// permissionService.getVisibleSiteIds, what the list endpoints enforce too:
// platform and tenant admins, and members with a team permission on it. Each
// user's readable sites are cached 30 s (a revoked permission stops the
// alerts within 30 s). An alert about an admin page (alertRequiredCapability)
// goes only to the sockets of users holding that page's capability. A
// tenant's deliveries go out in order (one queue per tenant): a resolution
// never overtakes the alert it resolves.
//
// A resolution is sent as NOTIFICATION_NEW too, with the same id and
// resolvedAt set: clients update the alert they hold (older clients ignore an
// id they already have).

const READ_CACHE_TTL_MS = 30_000;
const MAX_READ_CACHE = 10_000;
const readableSitesCache = new Map<string, { at: number; sites: 'all' | ReadonlySet<number> }>();

async function socketUserCanReadSite(userId: number, isPlatformAdmin: boolean, tenantId: number, siteId: number): Promise<boolean> {
  if (isPlatformAdmin) return true;
  const key = `${tenantId}:${userId}`;
  const now = Date.now();
  let entry = readableSitesCache.get(key);
  if (!entry || now - entry.at >= READ_CACHE_TTL_MS) {
    try {
      const visible = await permissionService.getVisibleSiteIds(userId, tenantId, false);
      entry = { at: now, sites: visible === 'all' ? 'all' : new Set(visible) };
    } catch (err) {
      // Fail closed, not cached.
      logger.warn({ err: (err as Error)?.message, tenantId }, 'Live alert: site permission lookup failed');
      return false;
    }
    if (readableSitesCache.size >= MAX_READ_CACHE) readableSitesCache.clear();
    readableSitesCache.set(key, entry);
  }
  return entry.sites === 'all' || entry.sites.has(siteId);
}

/**
 * Forgets cached readable sites: every entry without an argument, else the
 * entries of that user (any tenant). Called when permissions change.
 */
export function clearReadableSitesCache(userId?: number): void {
  if (userId === undefined) {
    readableSitesCache.clear();
    return;
  }
  const suffix = `:${userId}`;
  for (const key of [...readableSitesCache.keys()]) {
    if (key.endsWith(suffix)) readableSitesCache.delete(key);
  }
}

interface SocketUserData {
  user?: { id?: unknown; role?: unknown };
}

async function socketUserHoldsCapability(
  userId: number,
  isPlatformAdmin: boolean,
  tenantId: number,
  required: TenantCapability | 'all' | null,
): Promise<boolean> {
  if (required === null || isPlatformAdmin) return true;
  try {
    return holdsAlertCapability(await viewerAlertCapabilities(userId, tenantId, false), required);
  } catch (err) {
    // Fail closed.
    logger.warn({ err: (err as Error)?.message, tenantId }, 'Live alert: capability lookup failed');
    return false;
  }
}

async function deliver(alert: LiveAlertRow): Promise<void> {
  const io = _io;
  if (!io) return;
  const room = `tenant:${alert.tenantId}:notifications`;
  const required = alertRequiredCapability(alert.navigateTo);
  if (alert.siteId === null && required === null) {
    io.to(room).emit(SOCKET_EVENTS.NOTIFICATION_NEW, alert);
    return;
  }
  const sockets = await io.in(room).fetchSockets();
  const ids: string[] = [];
  for (const s of sockets) {
    const data = (s.data ?? {}) as SocketUserData;
    const userId = Number(data.user?.id);
    if (!Number.isInteger(userId) || userId <= 0) continue;
    const isPlatformAdmin = data.user?.role === 'admin';
    if (!(await socketUserHoldsCapability(userId, isPlatformAdmin, alert.tenantId, required))) continue;
    if (alert.siteId !== null && !(await socketUserCanReadSite(userId, isPlatformAdmin, alert.tenantId, alert.siteId))) continue;
    ids.push(s.id);
  }
  if (ids.length > 0) io.to(ids).emit(SOCKET_EVENTS.NOTIFICATION_NEW, alert);
}

const deliveryQueues = new Map<number, Promise<void>>();

/** Queues the alert for the sockets that may see it (never throws). */
function emitAlert(alert: LiveAlertRow): void {
  if (!_io) return;
  const tenantId = alert.tenantId;
  const prev = deliveryQueues.get(tenantId) ?? Promise.resolve();
  const next = prev
    .then(() => deliver(alert))
    .catch((err: unknown) => logger.warn({ err: (err as Error)?.message, tenantId }, 'Live alert socket event not delivered'));
  deliveryQueues.set(tenantId, next);
  void next.then(() => {
    if (deliveryQueues.get(tenantId) === next) deliveryQueues.delete(tenantId);
  });
}

async function tenantName(tenantId: number): Promise<string> {
  const row = await db('tenants').where({ id: tenantId }).select('name').first() as { name: string } | undefined;
  return row?.name ?? '';
}

/** Announces resolved rows (enriched with their tenant name). */
async function announceResolved(rows: Array<Record<string, unknown>>): Promise<LiveAlertRow[]> {
  const names = new Map<number, string>();
  const out: LiveAlertRow[] = [];
  for (const row of rows) {
    const alert = rowToAlert(row);
    if (!names.has(alert.tenantId)) names.set(alert.tenantId, await tenantName(alert.tenantId));
    const enriched: LiveAlertRow = { ...alert, tenantName: names.get(alert.tenantId) ?? '' };
    emitAlert(enriched);
    out.push(enriched);
  }
  return out;
}

const SITE_PATH_RE = /^\/sites\/([1-9]\d{0,8})(?:[/?#]|$)/;

/**
 * The alert's site: `siteId` when given (null: none), else the site its
 * navigateTo points at ('/sites/<id>…'). Only a site of the tenant counts.
 */
async function resolveAlertSite(tenantId: number, siteId: number | null | undefined, navigateTo: string | null | undefined): Promise<number | null> {
  let candidate: number | null = null;
  if (siteId !== undefined) {
    candidate = siteId;
  } else if (typeof navigateTo === 'string') {
    const m = SITE_PATH_RE.exec(navigateTo);
    if (m) candidate = Number(m[1]);
  }
  if (candidate === null || !Number.isInteger(candidate) || candidate <= 0 || candidate > 2_147_483_647) return null;
  const site = await db('sites').where({ id: candidate, tenant_id: tenantId }).first('id');
  return site ? candidate : null;
}

/**
 * stable_key patterns (SQL LIKE) of the alert kinds that are resolved when
 * their problem ends: probe.service deviceOfflineKey / probeOfflineKey. The
 * other kinds (IP conflicts, probe key mismatch…) never are.
 */
const RESOLVABLE_KEY_PATTERNS: readonly string[] = ['device-offline:%', 'probe-offline:%'];
/**
 * stable_key regex (SQL ~) of the device-check open alerts
 * (ingest.service deviceCheckAlertKey 'devcheck:<stateId>:<epoch>'), resolved
 * when the alert closes. Their recovery / closed alerts
 * ('…:recovered' / '…:closed') are never resolved and do not match.
 */
const RESOLVABLE_KEY_REGEX = '^devcheck:[0-9]+:[0-9]+$';

export interface AddLiveAlertOptions {
  severity: 'down' | 'up' | 'warning' | 'info';
  title: string;
  message: string;
  /**
   * Page the alert links to. An admin page ('/manage/…') also restricts who
   * receives and lists it to the members who may open that page
   * (alertRequiredCapability).
   */
  navigateTo?: string | null;
  stableKey?: string | null;
  /**
   * Site the alert is about: only the members who may read it receive it.
   * Omitted: taken from navigateTo ('/sites/<id>…'); null: tenant-wide.
   */
  siteId?: number | null;
  /**
   * Machine-readable kind (shared LIVE_ALERT_KINDS) and its parameters:
   * clients render a translated, anonymized text from them. title / message
   * stay the English text (channels, older clients). Stored once migration
   * 052 has run.
   */
  kind?: string | null;
  params?: LiveAlertParams | null;
}

export const liveAlertService = {
  /**
   * Add a new live alert. If stableKey is provided, the insert is skipped when
   * an unread, unresolved alert with the same (tenant_id, stable_key) already
   * exists (a resolved one never blocks a new occurrence).
   * Returns the inserted row, or null if dedup skipped it.
   * After insert, emits NOTIFICATION_NEW via Socket.io.
   */
  async add(tenantId: number, opts: AddLiveAlertOptions): Promise<LiveAlertRow | null> {
    if (opts.stableKey) {
      const existing = await db('live_alerts')
        .where({ tenant_id: tenantId, stable_key: opts.stableKey })
        .whereNull('read_at')
        .whereNull('resolved_at')
        .first('id');
      if (existing) return null;
    }

    const siteId = await resolveAlertSite(tenantId, opts.siteId, opts.navigateTo);

    const kind = sanitizeAlertKind(opts.kind);
    const params = sanitizeAlertParams(opts.params);
    const structured = (kind !== null || params !== null) && await hasStructuredColumns()
      ? { kind, params: params ? JSON.stringify(params) : null }
      : {};

    const [row] = await db('live_alerts')
      .insert({
        tenant_id: tenantId,
        severity: opts.severity,
        title: opts.title,
        message: opts.message,
        navigate_to: opts.navigateTo ?? null,
        stable_key: opts.stableKey ?? null,
        site_id: siteId,
        ...structured,
      })
      .returning('*');

    // Keep only the newest 200 alerts per tenant. An active alert of a kind
    // that gets resolved (RESOLVABLE_KEY_PATTERNS) is kept first: the
    // resolved history of a flapping device never pushes out a problem that
    // still lasts. The other kinds are never resolved, so they are trimmed by
    // age like the resolved ones (old warnings never fill the cap).
    await db.raw(
      `DELETE FROM live_alerts WHERE tenant_id = ? AND id NOT IN (
         SELECT id FROM live_alerts WHERE tenant_id = ?
          ORDER BY (resolved_at IS NULL AND (${RESOLVABLE_KEY_PATTERNS.map(() => 'stable_key LIKE ?').join(' OR ')} OR stable_key ~ ?)) IS TRUE DESC,
                   created_at DESC, id DESC
          LIMIT 200
       )`,
      [tenantId, tenantId, ...RESOLVABLE_KEY_PATTERNS, RESOLVABLE_KEY_REGEX],
    );

    const alert = rowToAlert(row);
    const enriched: LiveAlertRow = { ...alert, tenantName: await tenantName(tenantId) };
    emitAlert(enriched);
    return enriched;
  },

  /**
   * The problem is over: resolves the tenant's active alerts with this stable
   * key (or any of these keys) and sends the update to the clients. Nothing
   * is inserted — a "back to normal" message only goes to the notification
   * channels. Returns the resolved alerts. Internal callers only.
   */
  async resolve(tenantId: number, stableKey: string | readonly string[]): Promise<LiveAlertRow[]> {
    const keys = [...new Set(typeof stableKey === 'string' ? [stableKey] : stableKey)].filter((k) => k.length > 0);
    if (keys.length === 0) return [];
    const rows = await db('live_alerts')
      .where({ tenant_id: tenantId })
      .whereIn('stable_key', keys)
      .whereNull('resolved_at')
      .update({ resolved_at: new Date() })
      .returning('*') as Array<Record<string, unknown>>;
    return announceResolved(rows);
  },

  /**
   * Resolves active alerts by id, in any tenant (self-healing sweeps that
   * found alerts whose problem no longer exists). Internal callers only,
   * never with ids taken from a request.
   */
  async resolveByIds(ids: readonly number[]): Promise<LiveAlertRow[]> {
    const unique = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
    if (unique.length === 0) return [];
    const rows = await db('live_alerts')
      .whereIn('id', unique)
      .whereNull('resolved_at')
      .update({ resolved_at: new Date() })
      .returning('*') as Array<Record<string, unknown>>;
    return announceResolved(rows);
  },

  /**
   * Alerts of a single tenant (newest first): active ones, resolved ones too
   * with includeResolved. `sites`: the viewer's readable sites of the tenant
   * (alerts about another site are left out); `capabilities`: the viewer's
   * (alerts about an admin page they may not open are left out).
   */
  async getForTenant(
    tenantId: number,
    limit = 100,
    opts: AlertListOptions & { sites?: AlertSiteVisibility; capabilities?: AlertCapabilities } = {},
  ): Promise<LiveAlertRow[]> {
    const q = db('live_alerts').where({ tenant_id: tenantId });
    if (!opts.includeResolved) q.whereNull('resolved_at');
    const sites = opts.sites ?? 'all';
    if (sites !== 'all') q.where((b) => applySiteVisibility(b, 'site_id', sites));
    const caps = opts.capabilities ?? 'all';
    if (caps !== 'all') q.where((b) => applyAdminPageAudience(b, 'navigate_to', caps));
    const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit);
    return rows.map(rowToAlert);
  },

  /**
   * Fetch alerts for all of the given tenants, enriched with tenant name.
   * Used for the multi-tenant notification panel. `sitesByTenant` /
   * `capabilitiesByTenant`: the viewer's readable sites and capabilities per
   * tenant (missing tenant: 'all').
   */
  async getForTenants(
    tenantIds: number[],
    limit = 200,
    opts: AlertListOptions & {
      sitesByTenant?: ReadonlyMap<number, AlertSiteVisibility>;
      capabilitiesByTenant?: ReadonlyMap<number, AlertCapabilities>;
    } = {},
  ): Promise<LiveAlertRow[]> {
    if (tenantIds.length === 0) return [];
    const q = db('live_alerts')
      .join('tenants', 'live_alerts.tenant_id', 'tenants.id')
      .whereIn('live_alerts.tenant_id', tenantIds);
    if (!opts.includeResolved) q.whereNull('live_alerts.resolved_at');
    const byTenant = opts.sitesByTenant;
    const capsByTenant = opts.capabilitiesByTenant;
    const restricted = (tid: number): boolean =>
      (byTenant?.get(tid) ?? 'all') !== 'all' || (capsByTenant?.get(tid) ?? 'all') !== 'all';
    if (tenantIds.some(restricted)) {
      q.where((outer) => {
        for (const tid of tenantIds) {
          const sites = byTenant?.get(tid) ?? 'all';
          const caps = capsByTenant?.get(tid) ?? 'all';
          outer.orWhere((inner) => {
            inner.where('live_alerts.tenant_id', tid);
            if (sites !== 'all') inner.where((b) => applySiteVisibility(b, 'live_alerts.site_id', sites));
            if (caps !== 'all') inner.where((b) => applyAdminPageAudience(b, 'live_alerts.navigate_to', caps));
          });
        }
      });
    }
    const rows = await q
      .orderBy('live_alerts.created_at', 'desc')
      .orderBy('live_alerts.id', 'desc')
      .limit(limit)
      .select('live_alerts.*', 'tenants.name as tenant_name');
    return rows.map(rowToAlert);
  },

  async markRead(id: number, tenantId: number): Promise<void> {
    await db('live_alerts').where({ id, tenant_id: tenantId }).update({ read_at: new Date() });
  },

  async markAllRead(tenantId: number): Promise<void> {
    await db('live_alerts')
      .where({ tenant_id: tenantId })
      .whereNull('read_at')
      .update({ read_at: new Date() });
  },

  async deleteAlert(id: number, tenantId: number): Promise<boolean> {
    const count = await db('live_alerts').where({ id, tenant_id: tenantId }).delete();
    return count > 0;
  },

  async clearAll(tenantId: number): Promise<void> {
    await db('live_alerts').where({ tenant_id: tenantId }).delete();
  },

  /**
   * Periodic cleanup (hourly retention of the Device Checks sweeper): removes
   * the alerts older than daysOld, in batches. An alert still unread AND
   * unresolved is kept whatever its age: it is the dedup guard of add() (its
   * stable_key blocks a new identical alert), dropping it would re-fire the
   * alert and its notification. Returns the number of rows deleted.
   */
  async cleanup(daysOld = 30): Promise<number> {
    const cutoff = new Date(Date.now() - daysOld * 86_400_000);
    const BATCH = 5_000;
    let total = 0;
    for (let i = 0; i < 200; i++) {
      const ids = db('live_alerts')
        .where('created_at', '<', cutoff)
        .where((q) => q.whereNotNull('read_at').orWhereNotNull('resolved_at'))
        .select('id')
        .limit(BATCH);
      const deleted = Number(await db('live_alerts').whereIn('id', ids).delete()) || 0;
      total += deleted;
      if (deleted < BATCH) break;
    }
    return total;
  },
};
