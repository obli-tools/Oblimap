import { db } from '../db';
import type {
  ItemAlertMode,
  Site,
  SiteItem,
  IpReservation,
  IpReservationState,
  DeviceType,
  DeviceCheckAlertState,
  DeviceCheckStatus,
  DeviceCheckSummary,
  DeviceCheckValue,
} from '@oblimap/shared';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import {
  invalidateTenantCaches,
  pushConfigToAffectedProbes,
  rowToRuleRecord,
  type RuleRecord,
} from './deviceChecks/config.service';
import { buildCheckSummary } from './deviceChecks/eval';
import { isLocallyAdministered } from './deviceClassification';
import { itemAlertModeOf } from './itemEvents.service';

// Every method takes the tenant and filters on it. Writes that reference
// another row (a site's group, an item's or reservation's site) verify that
// the row belongs to the same tenant first.

// Strict dotted quad (no octet above 255, no leading zero): only such values
// are cast to inet when sorting — one bad legacy value must not make the
// whole device list fail.
export const IPV4_SORTABLE_RE = '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])[.]){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$';

async function assertSiteInTenant(tenantId: number, siteId: number): Promise<void> {
  const site = await db('sites').where({ id: siteId, tenant_id: tenantId }).first('id');
  if (!site) throw new AppError(404, 'Site not found');
}

async function assertGroupInTenant(tenantId: number, groupId: number | null | undefined): Promise<void> {
  if (groupId === null || groupId === undefined) return;
  const group = await db('monitor_groups').where({ id: groupId, tenant_id: tenantId }).first('id');
  if (!group) throw new AppError(400, 'Group not found');
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/** Changes of one site within this delay are pushed to its probes together. */
const CHECKS_REFRESH_DELAY_MS = 2_000;
const pendingChecksRefresh = new Set<string>();

/**
 * Re-sends the Device Checks assignment to the connected probes of a site
 * after a change of which devices its rules target: the site moved to another
 * group (other group rules cover it), or a device was added, re-typed or
 * removed. Without it the probes would keep checking — and sending stored
 * credentials to — the old targets until their next scan. Probes in HTTP mode
 * get it with their next push. Coalesced per site and delay (a burst of edits
 * is one push, built from the state after the last one); never throws.
 */
function refreshDeviceChecks(tenantId: number, siteId: number, delayMs = CHECKS_REFRESH_DELAY_MS): void {
  const key = `${tenantId}:${siteId}:${delayMs}`;
  if (pendingChecksRefresh.has(key)) return;
  pendingChecksRefresh.add(key);
  const timer = setTimeout(() => {
    pendingChecksRefresh.delete(key);
    pushConfigToAffectedProbes(tenantId, [siteId]).catch((err: unknown) =>
      logger.warn({ err: (err as Error)?.message, tenantId, siteId }, 'Device checks config push after a site change failed'));
  }, delayMs);
  timer.unref?.();
}

/**
 * After a site delete. Its probes lost their site (site_id SET NULL), so
 * pushConfigToAffectedProbes, which selects probes by site, no longer finds
 * them: they are sent their new config directly — no site, hence an empty
 * Device Checks assignment — and stop checking the site's devices (and drop
 * its stored credentials) now rather than at their next scan. The site's
 * rules and credentials went with it (cascade): the tenant's cached rules
 * are dropped too. Not awaited; never throws.
 */
function refreshDetachedProbes(tenantId: number, probeIds: number[]): void {
  invalidateTenantCaches(tenantId);
  if (probeIds.length === 0) return;
  // Lazy import, as config.service does: probe.service loads the probe hub.
  import('./probe.service')
    .then(({ probeService }) => probeService.pushConfigToProbes(tenantId, probeIds))
    .catch((err: unknown) =>
      logger.warn({ err: (err as Error)?.message, tenantId }, 'Config push to the probes of a deleted site failed'));
}

// ─── Row helpers ──────────────────────────────────────────────────────────────

/**
 * Site with its list counters. onlineProbeCount (approved probes whose
 * offline alert is not raised) is only filled by the site list.
 */
export type SiteWithCounts = Site & { onlineProbeCount?: number };

function rowToSite(row: Record<string, unknown>): SiteWithCounts {
  return {
    id: row.id as number,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    groupId: (row.group_id as number | null) ?? null,
    tenantId: row.tenant_id as number,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    itemCount: row.item_count != null ? Number(row.item_count) : undefined,
    onlineCount: row.online_count != null ? Number(row.online_count) : undefined,
    offlineCount: row.offline_count != null ? Number(row.offline_count) : undefined,
    probeCount: row.probe_count != null ? Number(row.probe_count) : undefined,
    onlineProbeCount: row.online_probe_count != null ? Number(row.online_probe_count) : undefined,
  };
}

/** A probe of a site as GET /sites/:id/probes reads it (no uuid, key or token). */
export interface SiteProbeRow {
  id: number;
  name: string | null;
  hostname: string | null;
  status: string;
  ip: string | null;
  ips: unknown;
  mac: string | null;
  probe_version: string | null;
  is_primary: boolean | null;
  last_seen_at: Date | string | null;
  offline_alerted_at: Date | string | null;
  /** Command queued for the probe's next contact (HTTP fallback / offline). */
  pending_command: string | null;
}

/**
 * Whether site_items.device_type_source exists (migration 048). Checked once:
 * until the migration has run, a manual type change only writes device_type.
 */
let deviceTypeSourceColumn: Promise<boolean> | null = null;
function hasDeviceTypeSource(): Promise<boolean> {
  if (!deviceTypeSourceColumn) {
    deviceTypeSourceColumn = db.schema.hasColumn('site_items', 'device_type_source').catch((err: unknown) => {
      // Retried on the next call.
      deviceTypeSourceColumn = null;
      logger.warn({ err: (err as Error)?.message }, 'site_items.device_type_source lookup failed');
      return false;
    });
  }
  return deviceTypeSourceColumn;
}

/**
 * Whether site_items.alert_mode exists (migration 052). Checked once (re-checked
 * on the next call after an error): until it has run, alertMode is not written.
 */
let alertModeColumn: Promise<boolean> | null = null;
function hasAlertModeColumn(): Promise<boolean> {
  if (!alertModeColumn) {
    alertModeColumn = db.schema.hasColumn('site_items', 'alert_mode').catch((err: unknown) => {
      alertModeColumn = null;
      logger.warn({ err: (err as Error)?.message }, 'site_items.alert_mode lookup failed');
      return false;
    });
  }
  return alertModeColumn;
}

/** A site_items row → SiteItem (exported for the tenant-wide item routes). */
export function rowToItem(row: Record<string, unknown>): SiteItem {
  return {
    id: row.id as number,
    siteId: row.site_id as number,
    tenantId: row.tenant_id as number,
    ip: row.ip as string,
    mac: (row.mac as string | null) ?? null,
    hostname: (row.hostname as string | null) ?? null,
    customName: (row.custom_name as string | null) ?? null,
    deviceType: (row.device_type as DeviceType) ?? 'unknown',
    vendor: (row.vendor as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    status: (row.status as SiteItem['status']) ?? 'unknown',
    isManual: Boolean(row.is_manual),
    discoveredByProbeId: (row.discovered_by_probe_id as number | null) ?? null,
    firstSeenAt: (row.first_seen_at as Date).toISOString(),
    lastSeenAt: (row.last_seen_at as Date).toISOString(),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    openPorts: row.open_ports != null
      ? (typeof row.open_ports === 'string' ? JSON.parse(row.open_ports) : row.open_ports)
      : null,
    // Migration 048: undefined before it has run.
    deviceTypeSource: (row.device_type_source as string | null | undefined) ?? null,
    macRandomized: Boolean(row.mac_randomized),
    // Migration 052: 'inherit' before it has run.
    alertMode: itemAlertModeOf(row.alert_mode),
  };
}

// ─── Device check summaries (SiteItem.checks) ─────────────────────────────────

/** Checks listed per device row, worst first. */
const MAX_ITEM_CHECKS = 3;

const CHECK_STATUSES: readonly DeviceCheckStatus[] = ['pending', 'ok', 'fail', 'error'];
const ALERT_STATES: readonly DeviceCheckAlertState[] = ['ok', 'pending', 'alerting', 'suppressed'];

/**
 * Row order of a device's checks: alerting, failing, in error, then the ones
 * whose current state is unknown (pending, or no recent result), then OK.
 */
function checkSeverity(c: DeviceCheckSummary): number {
  if (c.alertState === 'alerting') return 0;
  if (c.status === 'fail') return 1;
  if (c.status === 'error') return 2;
  if (c.status === 'pending' || c.alertState === 'pending' || c.stale) return 3;
  return 4;
}

function jsonRecord(v: unknown): Record<string, DeviceCheckValue> {
  let parsed = v;
  if (typeof v === 'string') {
    try { parsed = JSON.parse(v); } catch { return {}; }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, DeviceCheckValue> : {};
}

function dateOrNull(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Latest device-check summaries of a site's devices (enabled rules of the
 * tenant), by item id: at most MAX_ITEM_CHECKS per item, worst first.
 * Sensitive field values never reach a summary (buildCheckSummary leaves
 * them out of the primary / secondary / badge slots); staleness is computed
 * now (no result for max(3 × interval, 180 s)).
 */
async function loadItemChecks(tenantId: number, siteId: number): Promise<Map<number, DeviceCheckSummary[]>> {
  const rows = await db('device_check_state as s')
    .join('device_check_rules as r', function joinRule() {
      this.on('r.id', '=', 's.rule_id').andOn('r.tenant_id', '=', 's.tenant_id');
    })
    .where('s.tenant_id', tenantId)
    .where('s.site_id', siteId)
    .where('r.tenant_id', tenantId)
    .where('r.enabled', true)
    // A rule suspended by the accountability gate is assigned to no probe:
    // its last state would only turn stale.
    .whereNull('r.suspended_reason')
    .select('s.id', 's.rule_id', 's.site_item_id', 's.status', 's.alert_state', 's.values',
      's.last_checked_at', 's.last_error_code',
      'r.tenant_id as r_tenant_id', 'r.name as r_name', 'r.enabled as r_enabled', 'r.spec as r_spec',
      'r.revision as r_revision')
    .orderBy([{ column: 's.site_item_id', order: 'asc' }, { column: 's.rule_id', order: 'asc' }]) as Array<Record<string, unknown>>;

  const now = new Date();
  const rules = new Map<number, RuleRecord | null>();
  const byItem = new Map<number, DeviceCheckSummary[]>();
  for (const r of rows) {
    const ruleId = Number(r.rule_id);
    if (!rules.has(ruleId)) {
      // null when the stored spec no longer validates: not displayed.
      rules.set(ruleId, rowToRuleRecord({
        id: ruleId, tenant_id: r.r_tenant_id, name: r.r_name, enabled: r.r_enabled, spec: r.r_spec, revision: r.r_revision,
      }));
    }
    const rule = rules.get(ruleId);
    if (!rule) continue;
    const status = CHECK_STATUSES.includes(r.status as DeviceCheckStatus) ? r.status as DeviceCheckStatus : 'pending';
    const alertState = ALERT_STATES.includes(r.alert_state as DeviceCheckAlertState) ? r.alert_state as DeviceCheckAlertState : 'ok';
    const summary = buildCheckSummary({
      stateId: Number(r.id),
      ruleId,
      ruleName: rule.name,
      spec: rule.spec,
      status,
      alertState,
      values: jsonRecord(r.values),
      lastCheckedAt: dateOrNull(r.last_checked_at),
      lastErrorCode: (r.last_error_code as string | null) ?? null,
    }, now);
    const itemId = Number(r.site_item_id);
    const list = byItem.get(itemId);
    if (list) list.push(summary);
    else byItem.set(itemId, [summary]);
  }

  for (const [itemId, list] of byItem) {
    // Stable sort: equal severities keep the rule id order.
    byItem.set(itemId, list.sort((a, b) => checkSeverity(a) - checkSeverity(b)).slice(0, MAX_ITEM_CHECKS));
  }
  return byItem;
}

function rowToReservation(row: Record<string, unknown>): IpReservation {
  return {
    id: row.id as number,
    siteId: row.site_id as number,
    tenantId: row.tenant_id as number,
    ip: row.ip as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    deviceType: (row.device_type as DeviceType | null) ?? null,
    createdBy: (row.created_by as number | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    isOccupied: row.is_occupied != null ? Boolean(row.is_occupied) : undefined,
    occupiedByMac: (row.occupied_by_mac as string | null) ?? null,
    reservedMac: (row.reserved_mac as string | null) ?? null,
    itemId: row.item_id != null ? Number(row.item_id) : null,
  };
}

// ─── Reservation state ────────────────────────────────────────────────────────

/** The owner of a reservation: the device it was made for. */
export interface ReservationOwner {
  reservedMac: string | null;
  itemId: number | null;
}

/** A site item on the reservation's IP. */
export interface ReservationIpItem {
  id: number;
  mac: string | null;
  status: string;
}

/**
 * An item "holds" the IP unless it is offline — the same rule as the
 * reservation's isOccupied ('unknown' manual devices and 'reserved' rows
 * count as holders, as they always did).
 */
function holdsIp(item: ReservationIpItem): boolean {
  return item.status !== 'offline';
}

function sameMac(a: string | null, b: string | null): boolean {
  return a != null && b != null && a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** True when the item is the reservation's owner (its MAC, or its item). */
export function isReservationOwner(reservation: ReservationOwner, item: ReservationIpItem): boolean {
  return sameMac(reservation.reservedMac, item.mac)
    || (reservation.itemId != null && reservation.itemId === item.id);
}

/**
 * State of a reservation against the site items on its IP (pure):
 * - conflict: an online item other than the owner holds the IP — any
 *   online item when no owner is defined (the behaviour before owners);
 * - held: the owner is online on the IP and nobody else holds it;
 * - owner_offline: nobody holds the IP and the owner is known but offline —
 *   on the IP, or (`ownerElsewhere`: site items on other IPs) on another IP
 *   with no online owner row anywhere (e.g. after a DHCP change);
 * - free: nobody holds the IP and the owner is unknown or online elsewhere.
 */
export function reservationState(
  reservation: ReservationOwner,
  itemsOnIp: readonly ReservationIpItem[],
  ownerElsewhere: readonly ReservationIpItem[] = [],
): IpReservationState {
  const hasOwner = reservation.reservedMac != null || reservation.itemId != null;
  const holders = itemsOnIp.filter(holdsIp);
  if (!hasOwner) return holders.length > 0 ? 'conflict' : 'free';
  if (holders.some((i) => !isReservationOwner(reservation, i))) return 'conflict';
  if (holders.length > 0) return 'held';
  if (itemsOnIp.some((i) => isReservationOwner(reservation, i))) return 'owner_offline';
  const ownerRows = ownerElsewhere.filter((i) => isReservationOwner(reservation, i));
  if (ownerRows.length > 0 && !ownerRows.some(holdsIp)) return 'owner_offline';
  return 'free';
}

/**
 * Whether a device row is flagged as conflicting with the reservation on its
 * IP: the reservation is in conflict and this item is one of the intruders
 * (online, not the owner).
 */
function itemConflictsWithReservation(
  reservation: ReservationOwner,
  state: IpReservationState,
  item: ReservationIpItem,
): boolean {
  return state === 'conflict' && holdsIp(item) && !isReservationOwner(reservation, item);
}

function toReservationIpItem(row: Record<string, unknown>): ReservationIpItem {
  return {
    id: Number(row.id),
    mac: (row.mac as string | null) ?? null,
    status: String(row.status ?? 'unknown'),
  };
}

function toReservationOwner(row: Record<string, unknown>): ReservationOwner {
  return {
    reservedMac: (row.reserved_mac as string | null) ?? null,
    itemId: row.item_id != null ? Number(row.item_id) : null,
  };
}

/**
 * The site item a reservation is made for: an item of the same site and
 * tenant, else 400. Returns its MAC (to prefill reserved_mac).
 */
async function loadReservationItem(
  tenantId: number,
  siteId: number,
  itemId: number,
): Promise<{ mac: string | null }> {
  const item = await db('site_items')
    .where({ id: itemId, site_id: siteId, tenant_id: tenantId })
    .first('mac') as { mac: string | null } | undefined;
  if (!item) throw new AppError(400, 'Device not found on this site');
  return { mac: item.mac ?? null };
}

/**
 * 409 of a manual device whose MAC, or IP without MAC, is already known on
 * the site. message = the error code; existingId names the existing device.
 */
export class DuplicateItemError extends AppError {
  constructor(public existingId: number) {
    super(409, 'duplicate_item');
    this.name = 'DuplicateItemError';
  }
}

// ─── Site Service ─────────────────────────────────────────────────────────────

class SiteService {
  // ── Sites ─────────────────────────────────────────────────────────────────

  /**
   * Sites of the tenant. siteIds (permissionService.getVisibleSiteIds) limits
   * the list to the sites the user may read; 'all' / absent: no limit.
   */
  async getSites(
    tenantId: number,
    opts?: { groupId?: number; includeDescendants?: boolean; ungrouped?: boolean; siteIds?: number[] | 'all' },
  ): Promise<SiteWithCounts[]> {
    const siteIds = opts?.siteIds;
    if (Array.isArray(siteIds) && siteIds.length === 0) return [];
    const groupId = opts?.groupId;
    const rows = await db('sites as s')
      .where('s.tenant_id', tenantId)
      .modify((q) => {
        if (groupId !== undefined) {
          if (opts?.includeDescendants) {
            // The group and every group under it (closure table, depth >= 0),
            // limited to the tenant's groups.
            q.whereIn('s.group_id', db('group_closure as gc')
              .join('monitor_groups as g', 'g.id', 'gc.descendant_id')
              .where('gc.ancestor_id', groupId)
              .where('g.tenant_id', tenantId)
              .select('gc.descendant_id'));
          } else {
            // Default (sidebar, group tree): direct children only.
            q.where('s.group_id', groupId);
          }
        }
        if (opts?.ungrouped) q.whereNull('s.group_id');
        if (Array.isArray(siteIds)) q.whereIn('s.id', siteIds);
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
      .leftJoin(
        // Online = approved, has reported, offline alert not raised (the
        // probe-offline job maintains offline_alerted_at).
        db('probes')
          .select('site_id')
          .count('* as online_probe_count')
          .where({ tenant_id: tenantId, status: 'approved' })
          .whereNotNull('site_id')
          .whereNotNull('last_seen_at')
          .whereNull('offline_alerted_at')
          .groupBy('site_id')
          .as('opc'),
        's.id', 'opc.site_id',
      )
      .select(
        's.*',
        db.raw('COALESCE(ic.item_count, 0) as item_count'),
        db.raw('COALESCE(oc.online_count, 0) as online_count'),
        db.raw('COALESCE(ofc.offline_count, 0) as offline_count'),
        db.raw('COALESCE(pc.probe_count, 0) as probe_count'),
        db.raw('COALESCE(opc.online_probe_count, 0) as online_probe_count'),
      )
      .orderBy('s.name', 'asc');

    return rows.map(rowToSite);
  }

  async getSite(tenantId: number, id: number): Promise<Site | null> {
    const rows = await db('sites as s')
      .where({ 's.id': id, 's.tenant_id': tenantId })
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
        's.*',
        db.raw('COALESCE(ic.item_count, 0) as item_count'),
        db.raw('COALESCE(oc.online_count, 0) as online_count'),
        db.raw('COALESCE(ofc.offline_count, 0) as offline_count'),
        db.raw('COALESCE(pc.probe_count, 0) as probe_count'),
      )
      .first();

    return rows ? rowToSite(rows) : null;
  }

  async createSite(
    tenantId: number,
    data: { name: string; description?: string | null; groupId?: number | null },
  ): Promise<Site> {
    await assertGroupInTenant(tenantId, data.groupId);
    const [row] = await db('sites')
      .insert({
        name: data.name,
        description: data.description ?? null,
        group_id: data.groupId ?? null,
        tenant_id: tenantId,
      })
      .returning('*');
    return rowToSite(row);
  }

  async updateSite(
    tenantId: number,
    id: number,
    data: Partial<{ name: string; description: string | null; groupId: number | null }>,
  ): Promise<Site | null> {
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.description !== undefined) patch.description = data.description;
    let updated: number;
    let groupChanged = false;
    if (data.groupId === undefined) {
      updated = await db('sites').where({ id, tenant_id: tenantId }).update(patch);
    } else {
      const groupId = data.groupId;
      await assertGroupInTenant(tenantId, groupId);
      patch.group_id = groupId;
      // Old group read under the row lock: of two concurrent moves, the second
      // sees the first one's group, so every actual change is noticed.
      updated = await db.transaction(async (trx): Promise<number> => {
        const current = await trx('sites').where({ id, tenant_id: tenantId }).forUpdate().first('group_id') as
          { group_id: number | null } | undefined;
        if (!current) return 0;
        groupChanged = (current.group_id ?? null) !== groupId;
        return Number(await trx('sites').where({ id, tenant_id: tenantId }).update(patch)) || 0;
      });
    }

    if (updated && groupChanged) {
      // The push drops the cached site settings too (invalidateTenantCaches):
      // the new group's inherited deviceChecksEnabled / businessHours apply.
      refreshDeviceChecks(tenantId, id);
    }
    return this.getSite(tenantId, id);
  }

  /** Returns false when the site is not in the tenant. */
  async deleteSite(tenantId: number, id: number): Promise<boolean> {
    let probeIds: number[] = [];
    const deleted = await db.transaction(async (trx) => {
      // Read before the delete detaches them (probes.site_id ON DELETE SET NULL).
      probeIds = (await trx('probes').where({ site_id: id, tenant_id: tenantId }).pluck('id') as unknown[])
        .map((p) => Number(p));
      const count = await trx('sites').where({ id, tenant_id: tenantId }).delete();
      if (count === 0) return false;
      // team_permissions, settings and notification_bindings scope_id have no
      // FK: drop the grants, the site-level settings and the site-level
      // channel bindings of this site.
      await trx('team_permissions').where({ scope: 'site', scope_id: id }).delete();
      await trx('settings').where({ scope: 'site', scope_id: id, tenant_id: tenantId }).delete();
      await trx('notification_bindings').where({ scope: 'site', scope_id: id, tenant_id: tenantId }).delete();
      return true;
    });
    if (deleted) refreshDetachedProbes(tenantId, probeIds);
    return deleted;
  }

  // ── Site probes ───────────────────────────────────────────────────────────

  /**
   * The approved probes assigned to the site (primary first, then by name).
   * Raw rows: the caller maps them to the public shape and decides whether
   * the network identity (ip / ips / mac) is shown. Never the uuid, the API
   * key or the identity token.
   */
  async getSiteProbeRows(tenantId: number, siteId: number): Promise<SiteProbeRow[]> {
    return db('probes')
      .where({ site_id: siteId, tenant_id: tenantId, status: 'approved' })
      .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'id', order: 'asc' }])
      .select('id', 'name', 'hostname', 'status', 'ip', 'ips', 'mac', 'probe_version',
        'is_primary', 'last_seen_at', 'offline_alerted_at', 'pending_command') as Promise<SiteProbeRow[]>;
  }

  /**
   * Queues 'rescan' for an approved probe of the site, only when no other
   * command is queued: a site rescan (site write, no probes.manage) never
   * replaces an 'uninstall' / 'update' queued by a probes.manage holder.
   * Conditional write, so a command queued meanwhile is never overwritten.
   * False when the probe has another command queued (or left the site).
   */
  async queueSiteRescan(tenantId: number, siteId: number, probeId: number): Promise<boolean> {
    const count = await db('probes')
      .where({ id: probeId, tenant_id: tenantId, site_id: siteId, status: 'approved' })
      .where((q) => { q.whereNull('pending_command').orWhere('pending_command', 'rescan'); })
      .update({ pending_command: 'rescan', updated_at: new Date() });
    return count > 0;
  }

  /** Clears a queued 'rescan' once delivered over the WS (never another command). */
  async clearDeliveredRescan(tenantId: number, probeId: number): Promise<void> {
    await db('probes')
      .where({ id: probeId, tenant_id: tenantId, pending_command: 'rescan' })
      .update({ pending_command: null });
  }

  // ── Site Items ────────────────────────────────────────────────────────────

  async getItems(tenantId: number, siteId: number): Promise<SiteItem[]> {
    // Cross-reference reservations to mark conflicts
    const items = await db('site_items')
      .where({ site_id: siteId, tenant_id: tenantId })
      // ip::inet casts to PostgreSQL's inet type for proper numeric sort (1,2,...,10,11,...,100)
      // instead of lexicographic (1,10,100,...,11,...). Only valid IPv4
      // values are cast; anything else sorts last, lexicographically.
      .orderByRaw('CASE WHEN ip ~ ? THEN ip::inet END ASC NULLS LAST, ip ASC', [IPV4_SORTABLE_RE]);

    const reservations = await db('ip_reservations')
      .where({ site_id: siteId, tenant_id: tenantId })
      .select('ip', 'reserved_mac', 'item_id') as Array<Record<string, unknown>>;

    // Items by IP, then the state of each reservation: a device is flagged
    // only when it intrudes on a reservation in conflict.
    const itemsByIp = new Map<string, ReservationIpItem[]>();
    for (const row of items) {
      const list = itemsByIp.get(row.ip as string);
      if (list) list.push(toReservationIpItem(row));
      else itemsByIp.set(row.ip as string, [toReservationIpItem(row)]);
    }
    const reservationByIp = new Map<string, { owner: ReservationOwner; state: IpReservationState }>();
    for (const r of reservations) {
      const owner = toReservationOwner(r);
      reservationByIp.set(r.ip as string, {
        owner,
        state: reservationState(owner, itemsByIp.get(r.ip as string) ?? []),
      });
    }

    // Load probes assigned to this site so we can identify their own device entry
    const siteProbes = await db('probes')
      .where({ site_id: siteId, tenant_id: tenantId })
      .select('id', 'ip', 'mac', 'ips') as { id: number; ip: string | null; mac: string | null; ips: string[] | string | null }[];

    // Build lookup maps: ip → probeId  and  mac → probeId
    const probeByIp = new Map<string, number>();
    const probeByMac = new Map<string, number>();
    for (const p of siteProbes) {
      if (p.ip) probeByIp.set(p.ip, p.id);
      if (p.mac) probeByMac.set(p.mac, p.id);
      // Register ALL probe IPs from the ips JSON array (multi-homed probes)
      const allIps = p.ips != null
        ? (typeof p.ips === 'string' ? JSON.parse(p.ips) : p.ips) as string[]
        : [];
      for (const ip of allIps) {
        if (!probeByIp.has(ip)) probeByIp.set(ip, p.id);
      }
    }

    // Device check summaries: the device list never fails because of them.
    let checksByItem = new Map<number, DeviceCheckSummary[]>();
    try {
      checksByItem = await loadItemChecks(tenantId, siteId);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, siteId }, 'Device check summaries not loaded for the device list');
    }

    return items.map((row) => {
      const itemIp = row.ip as string;
      const itemMac = (row.mac as string | null) ?? null;
      const probeId = probeByMac.get(itemMac ?? '') ?? probeByIp.get(itemIp) ?? null;
      const checks = checksByItem.get(row.id as number);
      const reservation = reservationByIp.get(itemIp);
      return {
        ...rowToItem(row),
        hasReservationConflict: reservation
          ? itemConflictsWithReservation(reservation.owner, reservation.state, toReservationIpItem(row))
          : false,
        isProbe: probeId !== null,
        probeId,
        ...(checks ? { checks } : {}),
      };
    });
  }

  async createManualItem(
    tenantId: number,
    siteId: number,
    data: {
      ip: string;
      mac?: string | null;
      customName?: string | null;
      deviceType?: DeviceType;
      notes?: string | null;
    },
  ): Promise<SiteItem> {
    await assertSiteInTenant(tenantId, siteId);
    const now = new Date();
    const mac = data.mac ?? null;
    // Duplicate guard, application level only: IP takeover rows
    // legitimately share an IP, so there is no unique index. Refused: a MAC
    // already known on the site, or an IP already known on the site when one
    // of the two rows has no MAC (the probe's IP fallback could not tell them
    // apart). Manual creates of one site are serialised by an advisory lock.
    const row = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`oblimap:site-manual-item:${siteId}`]);
      const existing = await trx('site_items')
        .where({ site_id: siteId, tenant_id: tenantId })
        .where((q) => {
          if (mac) {
            q.where('mac', mac)
              .orWhere((q2) => { q2.where('ip', data.ip).whereNull('mac'); });
          } else {
            q.where('ip', data.ip);
          }
        })
        .orderBy('id', 'asc')
        .first('id') as { id: number } | undefined;
      if (existing) throw new DuplicateItemError(Number(existing.id));

      // Migration 048 columns, written only once they exist.
      const tracking: Record<string, unknown> = await hasDeviceTypeSource()
        ? {
          device_type_source: data.deviceType && data.deviceType !== 'unknown' ? 'manual' : null,
          mac_randomized: isLocallyAdministered(mac),
        }
        : {};
      const [inserted] = await trx('site_items')
        .insert({
          ...tracking,
          site_id: siteId,
          tenant_id: tenantId,
          ip: data.ip,
          mac,
          custom_name: data.customName ?? null,
          device_type: data.deviceType ?? 'unknown',
          notes: data.notes ?? null,
          status: 'unknown',
          is_manual: true,
          first_seen_at: now,
          last_seen_at: now,
          created_at: now,
          updated_at: now,
        })
        .returning('*');
      return inserted as Record<string, unknown>;
    });
    // A rule may match it (MAC prefix, device type).
    refreshDeviceChecks(tenantId, siteId);
    return rowToItem(row);
  }

  async updateItem(
    tenantId: number,
    siteId: number,
    itemId: number,
    data: Partial<{
      customName: string | null;
      deviceType: DeviceType;
      notes: string | null;
      status: SiteItem['status'];
      alertMode: ItemAlertMode;
    }>,
  ): Promise<SiteItem | null> {
    const patch: Record<string, unknown> = { updated_at: new Date() };
    // Migration 052: refused (400) until it has run, rather than silently dropped.
    if (data.alertMode !== undefined) {
      if (!(await hasAlertModeColumn())) throw new AppError(400, 'Device alert mode is not available yet (database migration pending)');
      patch.alert_mode = data.alertMode;
    }
    if (data.customName !== undefined) patch.custom_name = data.customName;
    if (data.deviceType !== undefined) {
      patch.device_type = data.deviceType;
      // A type chosen by a person: automatic classification (vendor rules,
      // ports) never overwrites it (migration 048, when it has run). Only an
      // actual change pins it: re-sending the current type (rename, notes)
      // keeps the source. SET expressions read the old row's values. Set back
      // to 'unknown', the source is cleared so the device is classified again.
      if (await hasDeviceTypeSource()) {
        patch.device_type_source = db.raw(
          data.deviceType === 'unknown'
            ? 'CASE WHEN device_type IS DISTINCT FROM ? THEN NULL ELSE device_type_source END'
            : "CASE WHEN device_type IS DISTINCT FROM ? THEN 'manual' ELSE device_type_source END",
          [data.deviceType],
        );
      }
    }
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.status !== undefined) patch.status = data.status;

    // Device checks match on the device type: a change may add or remove targets.
    const before = data.deviceType !== undefined
      ? await db('site_items')
        .where({ id: itemId, site_id: siteId, tenant_id: tenantId })
        .first('device_type') as { device_type: string | null } | undefined
      : undefined;

    await db('site_items')
      .where({ id: itemId, site_id: siteId, tenant_id: tenantId })
      .update(patch);

    const row = await db('site_items')
      .where({ id: itemId, site_id: siteId, tenant_id: tenantId })
      .first();
    if (row && before && before.device_type !== row.device_type) refreshDeviceChecks(tenantId, siteId);
    return row ? rowToItem(row) : null;
  }

  /** Returns false when no such item exists on the tenant's site. */
  async deleteItem(tenantId: number, siteId: number, itemId: number): Promise<boolean> {
    const count = await db('site_items')
      .where({ id: itemId, site_id: siteId, tenant_id: tenantId })
      .delete();
    if (count > 0) refreshDeviceChecks(tenantId, siteId);
    return count > 0;
  }

  /**
   * Delete all devices in a site whose IP starts with the given /24 prefix.
   * @param prefix e.g. "192.168.1" — matches all IPs 192.168.1.*
   */
  async deleteItemsBySubnet(
    tenantId: number,
    siteId: number,
    prefix: string,
  ): Promise<Array<{ id: number; ip: string; mac: string | null; name: string | null }>> {
    const rows = await db('site_items')
      .where({ site_id: siteId, tenant_id: tenantId })
      .andWhere('ip', 'like', `${prefix}.%`)
      .delete()
      .returning(['id', 'ip', 'mac', 'custom_name', 'hostname']) as Array<{
        id: number; ip: string; mac: string | null; custom_name: string | null; hostname: string | null;
      }>;
    if (rows.length > 0) refreshDeviceChecks(tenantId, siteId);
    return rows.map((r) => ({
      id: Number(r.id),
      ip: r.ip,
      mac: r.mac ?? null,
      name: (r.custom_name && r.custom_name.trim()) || (r.hostname && r.hostname.trim()) || r.ip || null,
    }));
  }

  // ── IP Reservations ───────────────────────────────────────────────────────

  async getReservations(tenantId: number, siteId: number): Promise<IpReservation[]> {
    const reservations = await db('ip_reservations')
      .where({ site_id: siteId, tenant_id: tenantId })
      .orderBy('ip', 'asc');
    return this.withReservationState(tenantId, siteId, reservations);
  }

  /**
   * Reservation rows → API objects with isOccupied / occupiedByMac / state,
   * computed against the site's current items (used by the list and by the
   * create / update responses, so a client never needs a refetch).
   */
  private async withReservationState(
    tenantId: number,
    siteId: number,
    reservations: Array<Record<string, unknown>>,
  ): Promise<IpReservation[]> {
    if (reservations.length === 0) return [];

    // Devices on the reserved IPs (offline ones too: an offline owner is
    // 'owner_offline'). Deterministic order: the occupant shown is stable.
    const ipRows = await db('site_items')
      .where({ site_id: siteId, tenant_id: tenantId })
      .whereIn('ip', reservations.map((r) => r.ip as string))
      .orderBy('id', 'asc')
      .select('id', 'ip', 'mac', 'status') as Array<Record<string, unknown>>;

    const itemsByIp = new Map<string, ReservationIpItem[]>();
    for (const r of ipRows) {
      const list = itemsByIp.get(r.ip as string);
      if (list) list.push(toReservationIpItem(r));
      else itemsByIp.set(r.ip as string, [toReservationIpItem(r)]);
    }

    // Owner rows wherever they are on the site (an owner that moved to
    // another IP and went offline is still 'owner_offline').
    const owners = reservations.map(toReservationOwner);
    const ownerIds = owners.map((o) => o.itemId).filter((v): v is number => v != null);
    const ownerMacs = [...new Set(owners
      .map((o) => o.reservedMac?.trim().toUpperCase())
      .filter((v): v is string => !!v))];
    const ownerRows = ownerIds.length === 0 && ownerMacs.length === 0 ? [] : await db('site_items')
      .where({ site_id: siteId, tenant_id: tenantId })
      .where((q) => {
        if (ownerIds.length > 0) q.orWhereIn('id', ownerIds);
        if (ownerMacs.length > 0) q.orWhereIn(db.raw('upper(mac)') as unknown as string, ownerMacs);
      })
      .select('id', 'mac', 'status') as Array<Record<string, unknown>>;
    const ownerItems = ownerRows.map(toReservationIpItem);

    return reservations.map((row, idx) => {
      const owner = owners[idx];
      const onIp = itemsByIp.get(row.ip as string) ?? [];
      const holders = onIp.filter(holdsIp);
      // occupiedByMac: an intruder first (what a conflict is about), else the holder.
      const shown = holders.find((i) => !isReservationOwner(owner, i)) ?? holders[0];
      return {
        ...rowToReservation(row),
        isOccupied: holders.length > 0,
        occupiedByMac: shown?.mac ?? null,
        state: reservationState(owner, onIp, ownerItems),
      };
    });
  }

  async createReservation(
    tenantId: number,
    siteId: number,
    data: {
      ip: string;
      name: string;
      description?: string | null;
      deviceType?: DeviceType | null;
      reservedMac?: string | null;
      itemId?: number | null;
      createdBy?: number;
    },
  ): Promise<IpReservation> {
    await assertSiteInTenant(tenantId, siteId);
    let reservedMac = data.reservedMac ?? null;
    if (data.itemId != null) {
      const item = await loadReservationItem(tenantId, siteId, data.itemId);
      // Reserved for a device row: its MAC is the owner MAC unless one was given.
      if (reservedMac === null) reservedMac = item.mac;
    }
    try {
      const [row] = await db('ip_reservations')
        .insert({
          site_id: siteId,
          tenant_id: tenantId,
          ip: data.ip,
          name: data.name,
          description: data.description ?? null,
          device_type: data.deviceType ?? null,
          reserved_mac: reservedMac,
          item_id: data.itemId ?? null,
          created_by: data.createdBy ?? null,
        })
        .returning('*');
      const [reservation] = await this.withReservationState(tenantId, siteId, [row]);
      return reservation;
    } catch (err) {
      // unique (site_id, ip)
      if (isUniqueViolation(err)) throw new AppError(409, 'This IP is already reserved on this site');
      throw err;
    }
  }

  async updateReservation(
    tenantId: number,
    siteId: number,
    resId: number,
    data: Partial<{
      name: string;
      description: string | null;
      deviceType: DeviceType | null;
      reservedMac: string | null;
      itemId: number | null;
    }>,
  ): Promise<IpReservation | null> {
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.description !== undefined) patch.description = data.description;
    if (data.deviceType !== undefined) patch.device_type = data.deviceType;
    if (data.reservedMac !== undefined) patch.reserved_mac = data.reservedMac;
    if (data.itemId !== undefined) {
      patch.item_id = data.itemId;
      if (data.itemId !== null) {
        const item = await loadReservationItem(tenantId, siteId, data.itemId);
        // Bound to another device row: its MAC follows unless one was given.
        if (data.reservedMac === undefined) patch.reserved_mac = item.mac;
      }
    }

    await db('ip_reservations')
      .where({ id: resId, site_id: siteId, tenant_id: tenantId })
      .update(patch);

    const row = await db('ip_reservations')
      .where({ id: resId, site_id: siteId, tenant_id: tenantId })
      .first();
    if (!row) return null;
    const [reservation] = await this.withReservationState(tenantId, siteId, [row]);
    return reservation;
  }

  /** Returns the deleted reservation, or null when none matched. */
  async deleteReservation(tenantId: number, siteId: number, resId: number): Promise<IpReservation | null> {
    const row = await db('ip_reservations')
      .where({ id: resId, site_id: siteId, tenant_id: tenantId })
      .first();
    if (!row) return null;
    await db('ip_reservations')
      .where({ id: resId, site_id: siteId, tenant_id: tenantId })
      .delete();
    return rowToReservation(row);
  }
}

export const siteService = new SiteService();
