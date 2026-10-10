import type { Knex } from 'knex';
import { db } from '../db';
import { logger } from '../utils/logger';
import { permissionService } from './permission.service';

// Dashboard, modeled on Obliance device.service.ts
// getFleetSummary / getFleetTimeseries / snapshotFleetDaily.
//
// Every aggregate is limited to the sites the viewer may read
// (permissionService.getVisibleSiteIds: 'all' for full access, [] for a
// member without any team permission — zeros, never a 403). The history is
// a per-site daily snapshot (ipam_daily_snapshot, migration 047) so the
// timeseries and the deltas can be filtered the same way at query time.
// Probe KPIs are tenant-wide and only filled for 'probes.manage' holders.

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DashboardViewer {
  userId: number;
  tenantId: number;
  isPlatformAdmin: boolean;
}

export interface DashboardSummary {
  sites: { total: number };
  devices: { total: number; online: number; offline: number; reserved: number };
  newDevices24h: number;
  ipConflictsActive: number;
  ipInstabilityActive: number;
  /** null when the tenant has no enabled device-check rule. */
  checks: { ok: number; fail: number; error: number; alerting: number } | null;
  deviceTypes: Array<{ type: string; count: number }>;
  topSubnets: Array<{ siteId: number; siteName: string; subnet: string; used: number; usable: number; pct: number }>;
  /** ISO timestamp, max(site_items.last_seen_at) of the visible sites. */
  lastScanAt: string | null;
  /** Today vs yesterday's snapshot; null without a snapshot of yesterday. */
  deltas: { devicesOnline: number | null; newDevices: number | null };
  /** null unless the viewer holds 'probes.manage'. */
  probes: { total: number; online: number; offline: number; pending: number } | null;
  pendingProbes: number | null;
}

export interface DashboardTimeseriesPoint {
  day: string; // YYYY-MM-DD (UTC)
  hostsTotal: number;
  hostsOnline: number;
  newHosts: number;
  ipConflicts: number;
  failingChecks: number;
}

type VisibleSites = number[] | 'all';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Live-alert stable_key prefixes written by probe.service.ts. */
export const IP_TAKEOVER_KEY_PREFIX = 'ip-takeover:';
export const IP_INSTABILITY_KEY_PREFIX = 'ip-instability:';

export const TIMESERIES_DEFAULT_DAYS = 14;
export const TIMESERIES_MAX_DAYS = 90;
export const SNAPSHOT_RETENTION_DAYS = 400;
/** Usable host addresses of a /24. */
export const SUBNET24_USABLE = 254;
const TOP_SUBNETS = 5;

/** Dotted IPv4 (the SQL twin is IPV4_SQL_RE). */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_SQL_RE = '^[0-9]{1,3}(\\.[0-9]{1,3}){3}$';

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────

/** UTC calendar day (YYYY-MM-DD) of `date`. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The UTC day `offset` days after `day` (negative = before). */
export function addDays(day: string, offset: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS));
}

/**
 * Parses the ?days= query value: absent / empty → 14, an integer 1..90 → it,
 * anything else → null (400).
 */
export function parseTimeseriesDays(raw: unknown): number | null {
  if (raw === undefined || raw === '') return TIMESERIES_DEFAULT_DAYS;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= TIMESERIES_MAX_DAYS ? n : null;
}

/** "a.b.c.0/24" for a dotted IPv4, null for anything else (IPv6, garbage). */
export function subnet24(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const m = IPV4_RE.exec(ip.trim());
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/** Saturation of a /24 in percent (one decimal), capped at 100. */
export function subnetPct(used: number, usable = SUBNET24_USABLE): number {
  if (usable <= 0 || used <= 0) return 0;
  return Math.min(100, Math.round((used / usable) * 1000) / 10);
}

/**
 * Top /24 subnets by number of distinct addresses, from per-(site, subnet)
 * counts. Ties: higher usage first, then site name, then subnet.
 */
export function rankSubnets(
  rows: Array<{ siteId: number; siteName: string; subnet: string; used: number }>,
  limit = TOP_SUBNETS,
): DashboardSummary['topSubnets'] {
  return rows
    .filter((r) => r.used > 0)
    .slice()
    .sort((a, b) => b.used - a.used || a.siteName.localeCompare(b.siteName) || a.subnet.localeCompare(b.subnet))
    .slice(0, limit)
    .map((r) => ({ ...r, usable: SUBNET24_USABLE, pct: subnetPct(r.used) }));
}

/** current − previous, or null when there is nothing to compare with. */
export function delta(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return null;
  return current - previous;
}

/** Postgres count / sum results come back as strings: coerce to a safe int. */
export function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * One point per day from `today − (days − 1)` to `today` (both UTC days,
 * oldest first); days without a snapshot are zeros. Rows of the same day
 * (several sites) are summed.
 */
export function fillTimeseries(
  rows: Array<Partial<Omit<DashboardTimeseriesPoint, 'day'>> & { day: string }>,
  days: number,
  today: string,
): DashboardTimeseriesPoint[] {
  const byDay = new Map<string, DashboardTimeseriesPoint>();
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    const acc = byDay.get(day) ?? { day, hostsTotal: 0, hostsOnline: 0, newHosts: 0, ipConflicts: 0, failingChecks: 0 };
    acc.hostsTotal += toCount(r.hostsTotal);
    acc.hostsOnline += toCount(r.hostsOnline);
    acc.newHosts += toCount(r.newHosts);
    acc.ipConflicts += toCount(r.ipConflicts);
    acc.failingChecks += toCount(r.failingChecks);
    byDay.set(day, acc);
  }
  const out: DashboardTimeseriesPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    out.push(byDay.get(day) ?? { day, hostsTotal: 0, hostsOnline: 0, newHosts: 0, ipConflicts: 0, failingChecks: 0 });
  }
  return out;
}

/** The summary of a viewer who may read no site. */
export function emptySummary(): DashboardSummary {
  return {
    sites: { total: 0 },
    devices: { total: 0, online: 0, offline: 0, reserved: 0 },
    newDevices24h: 0,
    ipConflictsActive: 0,
    ipInstabilityActive: 0,
    checks: null,
    deviceTypes: [],
    topSubnets: [],
    lastScanAt: null,
    deltas: { devicesOnline: null, newDevices: null },
    probes: null,
    pendingProbes: null,
  };
}

// ─── Query helpers ──────────────────────────────────────────────────────────

/** Limits `q` to the visible sites (`column` holds the site id). */
function scopeSites<Q extends Knex.QueryBuilder>(q: Q, column: string, visible: VisibleSites): Q {
  if (visible !== 'all') q.whereIn(column, visible);
  return q;
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function viewerHoldsProbesManage(viewer: DashboardViewer): Promise<boolean> {
  if (viewer.isPlatformAdmin) return true;
  return permissionService.userHasTenantCapability(viewer.userId, viewer.tenantId, 'probes.manage');
}

async function probeCounts(tenantId: number): Promise<NonNullable<DashboardSummary['probes']>> {
  // Online = approved, heard from at least once and not declared offline by
  // the probe-offline job (offline_alerted_at). Refused and suspended probes
  // are left out, so total = online + offline + pending.
  const row = await db('probes')
    .where('tenant_id', tenantId)
    .whereIn('status', ['approved', 'pending'])
    .first(
      db.raw('count(*) as total'),
      db.raw(`count(*) filter (where status = 'approved' and offline_alerted_at is null and last_seen_at is not null) as online`),
      db.raw(`count(*) filter (where status = 'approved' and (offline_alerted_at is not null or last_seen_at is null)) as offline`),
      db.raw(`count(*) filter (where status = 'pending') as pending`),
    ) as Record<string, unknown> | undefined;
  return {
    total: toCount(row?.total),
    online: toCount(row?.online),
    offline: toCount(row?.offline),
    pending: toCount(row?.pending),
  };
}

// ─── Service ────────────────────────────────────────────────────────────────

let snapshotRunning = false;

export const dashboardService = {
  async visibleSites(viewer: DashboardViewer): Promise<VisibleSites> {
    return permissionService.getVisibleSiteIds(viewer.userId, viewer.tenantId, viewer.isPlatformAdmin);
  },

  async getSummary(viewer: DashboardViewer): Promise<DashboardSummary> {
    const { tenantId } = viewer;
    const [visible, probesManage] = await Promise.all([
      this.visibleSites(viewer),
      viewerHoldsProbesManage(viewer),
    ]);

    const summary = emptySummary();
    if (probesManage) {
      summary.probes = await probeCounts(tenantId);
      summary.pendingProbes = summary.probes.pending;
    }

    // A viewer who can read no site gets zeros and `checks: null` (it does not
    // learn whether the tenant has rules).
    if (visible !== 'all' && visible.length === 0) return summary;

    const hasRules = await db('device_check_rules')
      .where({ tenant_id: tenantId, enabled: true })
      .first('id');
    if (hasRules) summary.checks = { ok: 0, fail: 0, error: 0, alerting: 0 };

    const today = utcDay(new Date());
    const yesterday = addDays(today, -1);

    const [siteRow, deviceRow, typeRows, subnetRows, alertRow, checkRow, yesterdayRow] = await Promise.all([
      scopeSites(db('sites').where('tenant_id', tenantId), 'id', visible)
        .first(db.raw('count(*) as total')) as Promise<Record<string, unknown> | undefined>,

      scopeSites(db('site_items').where('tenant_id', tenantId), 'site_id', visible)
        .first(
          db.raw('count(*) as total'),
          db.raw(`count(*) filter (where status = 'online') as online`),
          db.raw(`count(*) filter (where status = 'offline') as offline`),
          db.raw(`count(*) filter (where status = 'reserved') as reserved`),
          db.raw(`count(*) filter (where first_seen_at >= now() - interval '24 hours') as new24h`),
          // Same window as the snapshot's new_hosts (since UTC midnight), for the delta.
          db.raw('count(*) filter (where first_seen_at >= ?::timestamptz) as new_today', [`${today}T00:00:00Z`]),
          db.raw('max(last_seen_at) as last_scan_at'),
        ) as Promise<Record<string, unknown> | undefined>,

      scopeSites(db('site_items').where('tenant_id', tenantId), 'site_id', visible)
        .groupBy('device_type')
        .select('device_type')
        .select(db.raw('count(*) as count'))
        .orderBy('count', 'desc') as Promise<Array<Record<string, unknown>>>,

      scopeSites(
        db('site_items as i')
          .join('sites as s', function joinSite() {
            this.on('s.id', '=', 'i.site_id').andOn('s.tenant_id', '=', 'i.tenant_id');
          })
          .where('i.tenant_id', tenantId)
          .whereRaw('i.ip ~ ?', [IPV4_SQL_RE]),
        'i.site_id',
        visible,
      )
        .groupBy('i.site_id', 's.name', db.raw(`regexp_replace(i.ip, '\\.[0-9]{1,3}$', '')`))
        .select('i.site_id', 's.name as site_name')
        .select(db.raw(`regexp_replace(i.ip, '\\.[0-9]{1,3}$', '') as prefix`))
        .select(db.raw('count(distinct i.ip) as used'))
        .orderBy('used', 'desc')
        .limit(50) as Promise<Array<Record<string, unknown>>>,

      scopeSites(
        db('live_alerts')
          .where('tenant_id', tenantId)
          .whereNull('resolved_at')
          .whereNotNull('site_id'),
        'site_id',
        visible,
      ).first(
        db.raw('count(*) filter (where stable_key like ?) as takeover', [`${IP_TAKEOVER_KEY_PREFIX}%`]),
        db.raw('count(*) filter (where stable_key like ?) as instability', [`${IP_INSTABILITY_KEY_PREFIX}%`]),
      ) as Promise<Record<string, unknown> | undefined>,

      hasRules
        ? scopeSites(
          db('device_check_state as st')
            .join('device_check_rules as r', function joinRule() {
              this.on('r.id', '=', 'st.rule_id').andOn('r.tenant_id', '=', 'st.tenant_id');
            })
            .where('st.tenant_id', tenantId)
            .where('r.enabled', true),
          'st.site_id',
          visible,
        ).first(
          db.raw(`count(*) filter (where st.status = 'ok') as ok`),
          db.raw(`count(*) filter (where st.status = 'fail') as fail`),
          db.raw(`count(*) filter (where st.status = 'error') as error`),
          db.raw(`count(*) filter (where st.alert_state = 'alerting') as alerting`),
        ) as Promise<Record<string, unknown> | undefined>
        : Promise.resolve(undefined),

      scopeSites(db('ipam_daily_snapshot').where({ tenant_id: tenantId, day: yesterday }), 'site_id', visible)
        .first(
          db.raw('count(*) as rows'),
          db.raw('coalesce(sum(hosts_online), 0) as hosts_online'),
          db.raw('coalesce(sum(new_hosts), 0) as new_hosts'),
        ) as Promise<Record<string, unknown> | undefined>,
    ]);

    summary.sites.total = toCount(siteRow?.total);
    summary.devices = {
      total: toCount(deviceRow?.total),
      online: toCount(deviceRow?.online),
      offline: toCount(deviceRow?.offline),
      reserved: toCount(deviceRow?.reserved),
    };
    summary.newDevices24h = toCount(deviceRow?.new24h);
    summary.lastScanAt = toIso(deviceRow?.last_scan_at);
    summary.ipConflictsActive = toCount(alertRow?.takeover);
    summary.ipInstabilityActive = toCount(alertRow?.instability);
    summary.deviceTypes = typeRows
      .map((r) => ({ type: String(r.device_type ?? 'unknown') || 'unknown', count: toCount(r.count) }))
      .filter((r) => r.count > 0);
    summary.topSubnets = rankSubnets(subnetRows.map((r) => ({
      siteId: Number(r.site_id),
      siteName: String(r.site_name ?? ''),
      subnet: `${String(r.prefix)}.0/24`,
      used: toCount(r.used),
    })));
    if (summary.checks && checkRow) {
      summary.checks = {
        ok: toCount(checkRow.ok),
        fail: toCount(checkRow.fail),
        error: toCount(checkRow.error),
        alerting: toCount(checkRow.alerting),
      };
    }
    const hasYesterday = toCount(yesterdayRow?.rows) > 0;
    summary.deltas = {
      devicesOnline: hasYesterday ? delta(summary.devices.online, toCount(yesterdayRow?.hosts_online)) : null,
      // Today's arrivals since UTC midnight vs yesterday's full-day snapshot
      // (like with like; newDevices24h stays the rolling KPI).
      newDevices: hasYesterday ? delta(toCount(deviceRow?.new_today), toCount(yesterdayRow?.new_hosts)) : null,
    };
    return summary;
  },

  /** `days` daily points (oldest first) summed over the visible sites. */
  async getTimeseries(viewer: DashboardViewer, days: number): Promise<DashboardTimeseriesPoint[]> {
    const today = utcDay(new Date());
    const visible = await this.visibleSites(viewer);
    if (visible !== 'all' && visible.length === 0) return fillTimeseries([], days, today);

    const rows = await scopeSites(
      db('ipam_daily_snapshot')
        .where('tenant_id', viewer.tenantId)
        .where('day', '>=', addDays(today, -(days - 1)))
        .where('day', '<=', today),
      'site_id',
      visible,
    )
      .groupBy('day')
      .select(db.raw(`to_char(day, 'YYYY-MM-DD') as day`))
      .select(db.raw('sum(hosts_total) as "hostsTotal"'))
      .select(db.raw('sum(hosts_online) as "hostsOnline"'))
      .select(db.raw('sum(new_hosts) as "newHosts"'))
      .select(db.raw('sum(ip_conflicts) as "ipConflicts"'))
      .select(db.raw('sum(failing_checks) as "failingChecks"')) as Array<{ day: string } & Record<string, unknown>>;

    return fillTimeseries(rows as Parameters<typeof fillTimeseries>[0], days, today);
  },

  /**
   * Writes today's (UTC) row of every site of `tenantId` in one aggregate
   * query. Idempotent: ON CONFLICT (site_id, day) DO UPDATE, so the hourly
   * runs and restarts keep one row per site and day, the last one winning.
   */
  async snapshotTenant(tenantId: number, day: string): Promise<number> {
    const dayStart = `${day}T00:00:00Z`;
    const result = await db.raw(
      `INSERT INTO ipam_daily_snapshot
         (tenant_id, site_id, day, hosts_total, hosts_online, new_hosts, ip_conflicts, failing_checks, subnets, created_at)
       SELECT s.tenant_id, s.id, ?::date,
              COALESCE(i.hosts_total, 0), COALESCE(i.hosts_online, 0), COALESCE(i.new_hosts, 0),
              COALESCE(a.ip_conflicts, 0), COALESCE(c.failing_checks, 0), COALESCE(i.subnets, 0), now()
         FROM sites s
         LEFT JOIN (
           SELECT site_id,
                  count(*) AS hosts_total,
                  count(*) FILTER (WHERE status = 'online') AS hosts_online,
                  count(*) FILTER (WHERE first_seen_at >= ?::timestamptz) AS new_hosts,
                  count(DISTINCT CASE WHEN ip ~ ? THEN regexp_replace(ip, '\\.[0-9]{1,3}$', '') END) AS subnets
             FROM site_items
            WHERE tenant_id = ?
            GROUP BY site_id
         ) i ON i.site_id = s.id
         LEFT JOIN (
           SELECT site_id, count(*) AS ip_conflicts
             FROM live_alerts
            WHERE tenant_id = ?
              AND resolved_at IS NULL
              AND site_id IS NOT NULL
              AND (stable_key LIKE ? OR stable_key LIKE ?)
            GROUP BY site_id
         ) a ON a.site_id = s.id
         LEFT JOIN (
           SELECT st.site_id, count(*) AS failing_checks
             FROM device_check_state st
             JOIN device_check_rules r ON r.id = st.rule_id AND r.tenant_id = st.tenant_id
             JOIN site_items si ON si.id = st.site_item_id AND si.site_id = st.site_id
            WHERE st.tenant_id = ?
              AND r.enabled = true
              AND st.status = 'fail'
            GROUP BY st.site_id
         ) c ON c.site_id = s.id
        WHERE s.tenant_id = ?
       ON CONFLICT (site_id, day) DO UPDATE SET
              tenant_id      = EXCLUDED.tenant_id,
              hosts_total    = EXCLUDED.hosts_total,
              hosts_online   = EXCLUDED.hosts_online,
              new_hosts      = EXCLUDED.new_hosts,
              ip_conflicts   = EXCLUDED.ip_conflicts,
              failing_checks = EXCLUDED.failing_checks,
              subnets        = EXCLUDED.subnets`,
      [
        day,
        dayStart,
        IPV4_SQL_RE,
        tenantId,
        tenantId,
        `${IP_TAKEOVER_KEY_PREFIX}%`,
        `${IP_INSTABILITY_KEY_PREFIX}%`,
        tenantId,
        tenantId,
      ],
    );
    return Number((result as { rowCount?: number }).rowCount ?? 0);
  },

  /**
   * Snapshot job (boot + hourly, server/src/index.ts): today's row of every
   * site of every tenant, then the purge of rows older than 400 days. A
   * failing tenant is logged and skipped; never throws; overlapping runs are
   * skipped.
   */
  async snapshotToday(): Promise<void> {
    if (snapshotRunning) return;
    snapshotRunning = true;
    try {
      const day = utcDay(new Date());
      const tenants = await db('tenants').select('id') as Array<{ id: number }>;
      let sites = 0;
      for (const t of tenants) {
        try {
          sites += await this.snapshotTenant(Number(t.id), day);
        } catch (err) {
          logger.error({ err, tenantId: t.id }, 'IPAM daily snapshot failed for tenant');
        }
      }
      const purged = await db('ipam_daily_snapshot')
        .where('day', '<', addDays(day, -SNAPSHOT_RETENTION_DAYS))
        .del();
      logger.info({ tenants: tenants.length, sites, purged, day }, 'IPAM daily snapshot complete');
    } catch (err) {
      logger.error(err, 'IPAM daily snapshot failed');
    } finally {
      snapshotRunning = false;
    }
  },
};
