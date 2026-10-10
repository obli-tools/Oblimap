import type { Knex } from 'knex';
import type { DeviceCheckAlertState, ResolvedSettings } from '@oblimap/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { appConfigService } from '../appConfig.service';
import { auditService } from '../audit.service';
import { liveAlertService } from '../liveAlert.service';
import { settingsService } from '../settings.service';
import { emitSiteUpdated } from '../realtime.service';
import { ITEM_EVENTS_RETENTION_DAYS, recordBatch as recordItemEvents } from '../itemEvents.service';
import { getSiteCheckSettings, pushConfigToAffectedProbes, rowToRuleRecord, type RuleRecord } from './config.service';
import {
  actionEventRows,
  alertColumns,
  alertContextFor,
  deviceNameOf,
  emitAlertChange,
  runAlertSideEffects,
  type EventBase,
} from './ingest.service';
import {
  alertStateChanged,
  closeSilently,
  effectiveIntervalSeconds,
  isStale,
  notePolicyMinIntervalSeconds,
  stepAlert,
  toAlertState,
  type AlertAction,
  type AlertContext,
  type AlertState,
} from './eval';

// Device Checks background work:
//  - every 60 s, the alert state machine steps with {kind:'tick'} on the
//    alerting / pending / suppressed rows, so that a business-hours window
//    that opens or closes, or a debounce that elapses, resolves even when no
//    result arrives. A tick on a stale check (no recent result) never opens
//    an alert nor sends a reminder. The rows of a check that no longer runs
//    close silently and go back to 'ok': rule disabled, suspended or with a
//    stored spec that no longer validates (reason rule_disabled), Device
//    Checks disabled on the site (reason checks_disabled);
//  - every hour, retention: value_changed events after valueEventRetentionDays,
//    other events after eventRetentionDays, audit_logs after 365 days,
//    notification_log after 30 days, network_flows not seen for 400 days,
//    item_ip_history not seen for 365 days, site_item_events (device history)
//    after 180 days, tunnels closed for 30 days, password_reset_tokens
//    expired for a day, live_alerts read or resolved for 30 days (never an
//    unread unresolved one: dedup guard), and the stale device purge (site_items offline longer
//    than the site's staleDeviceDays, when > 0; one 'purged' history event
//    per device).
// Started by index.ts (startDeviceCheckSweeper) and stopped on shutdown.

const TICK_MS = 60_000;
const RETENTION_MS = 60 * 60_000;
const FIRST_RETENTION_DELAY_MS = 5 * 60_000;
/** Rows looked at per tick (most only need an in-memory dry run). */
const MAX_ROWS_PER_TICK = 50_000;
const BATCH = 1_000;
const DELETE_BATCH = 10_000;
const AUDIT_RETENTION_DAYS = 365;
/** notification_log rows (channel delivery log) are kept 30 days. */
export const NOTIFICATION_LOG_RETENTION_DAYS = 30;
/** network_flows not seen for 400 days are dropped (the starmap's longest period is 1 year). */
export const NETWORK_FLOW_RETENTION_DAYS = 400;
/** item_ip_history pairs not seen for 365 days are dropped. */
export const IP_HISTORY_RETENTION_DAYS = 365;
/** tunnels rows closed (status closed / error) for 30 days are dropped. */
export const CLOSED_TUNNEL_RETENTION_DAYS = 30;
/** password_reset_tokens expired for a day are dropped (used ones expire 1 h after creation too). */
export const RESET_TOKEN_RETENTION_DAYS = 1;
/** live_alerts read or resolved for 30 days are dropped (liveAlertService.cleanup). */
export const LIVE_ALERT_RETENTION_DAYS = 30;
/** Upper bound of the staleDeviceDays setting (shared SETTINGS_DEFINITIONS). */
const STALE_DEVICE_DAYS_MAX = 3650;

interface SweepRow {
  id: number;
  tenant_id: number;
  rule_id: number;
  site_item_id: number;
  site_id: number;
  probe_id: number | null;
  status: string;
  values: unknown;
  assertions: unknown;
  last_error_code: string | null;
  last_error: string | null;
}

function jsonValue<T>(v: unknown, fallback: T): T {
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }
  return (v ?? fallback) as T;
}

function dateOrNull(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}

type Step = { next: AlertState; actions: AlertAction[] };

// Rows are read in id order, BATCH at a time, at most MAX_ROWS_PER_TICK per
// tick; a sweep that stops at the cap resumes after the last id at the next
// tick (no row starves behind the others).
let sweepCursor = 0;

/**
 * One sweep over the rows whose alert state can change without a new result
 * (alerting / pending / suppressed). Returns the number of rows changed.
 */
export async function sweepAlertStates(now: Date = new Date()): Promise<number> {
  // Staleness uses the interval probes run: the spec's raised to the policy
  // minimum (cached 60 s). Noted for the summaries built elsewhere too.
  const { minIntervalSeconds: policyMinIntervalSeconds } = await appConfigService.getDeviceChecksPolicy();
  notePolicyMinIntervalSeconds(policyMinIntervalSeconds);
  let changed = 0;
  let seen = 0;
  while (seen < MAX_ROWS_PER_TICK) {
    const rows = await db('device_check_state as s')
      .join('device_check_rules as r', function joinRule() {
        this.on('r.id', '=', 's.rule_id').andOn('r.tenant_id', '=', 's.tenant_id');
      })
      .whereIn('s.alert_state', ['alerting', 'pending', 'suppressed'])
      .where('s.id', '>', sweepCursor)
      .select('s.*', 'r.id as r_id', 'r.tenant_id as r_tenant_id', 'r.name as r_name', 'r.enabled as r_enabled',
        'r.suspended_reason as r_suspended_reason', 'r.group_id as r_group_id', 'r.site_id as r_site_id',
        'r.spec as r_spec', 'r.revision as r_revision', 'r.created_by as r_created_by', 'r.updated_by as r_updated_by')
      .orderBy('s.id', 'asc')
      .limit(BATCH) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      sweepCursor = 0;
      break;
    }
    changed += await sweepBatch(rows, now, policyMinIntervalSeconds);
    seen += rows.length;
    sweepCursor = Number(rows[rows.length - 1].id);
    if (rows.length < BATCH) {
      sweepCursor = 0;
      break;
    }
  }
  return changed;
}

async function sweepBatch(rows: Array<Record<string, unknown>>, now: Date, policyMinIntervalSeconds: number): Promise<number> {
  // Devices and sites of the rows, loaded once
  const itemIds = [...new Set(rows.map((r) => Number(r.site_item_id)))];
  const siteIds = [...new Set(rows.map((r) => Number(r.site_id)))];
  const items = new Map((await db('site_items').whereIn('id', itemIds)
    .select('id', 'tenant_id', 'ip', 'mac', 'hostname', 'custom_name', 'status') as Array<Record<string, unknown>>)
    .map((i) => [Number(i.id), i]));
  const sites = new Map((await db('sites').whereIn('id', siteIds)
    .select('id', 'tenant_id', 'name', 'group_id') as Array<Record<string, unknown>>)
    .map((s) => [Number(s.id), s]));

  const rules = new Map<number, RuleRecord | null>();
  let changed = 0;

  for (const row of rows) {
    const ruleId = Number(row.rule_id);
    if (!rules.has(ruleId)) {
      rules.set(ruleId, rowToRuleRecord({
        id: row.r_id, tenant_id: row.r_tenant_id, name: row.r_name, enabled: row.r_enabled,
        suspended_reason: row.r_suspended_reason, group_id: row.r_group_id, site_id: row.r_site_id,
        spec: row.r_spec, revision: row.r_revision, created_by: row.r_created_by, updated_by: row.r_updated_by,
      }));
    }
    // null: the stored spec no longer validates (the check cannot run).
    const rule = rules.get(ruleId) ?? null;
    const tenantId = Number(row.tenant_id);
    const siteId = Number(row.site_id);
    const item = items.get(Number(row.site_item_id));
    const site = sites.get(siteId);
    if (!item || !site || Number(item.tenant_id) !== tenantId || Number(site.tenant_id) !== tenantId) continue;

    try {
      // A check that no longer runs closes silently (no probe sends results
      // for it any more); otherwise the state machine ticks. Steps are
      // computed from a state row (staleness from its last_checked_at).
      let stepOf: (stateRow: Record<string, unknown>) => Step;
      if (!rule || !rule.enabled || rule.suspendedReason !== null) {
        stepOf = (stateRow) => closeSilently(toAlertState(stateRow), 'rule_disabled');
      } else if (!(await getSiteCheckSettings(tenantId, siteId)).enabled) {
        stepOf = (stateRow) => closeSilently(toAlertState(stateRow), 'checks_disabled');
      } else {
        const alerting = rule.spec.alerting;
        const interval = effectiveIntervalSeconds(rule.spec.schedule.intervalSeconds, policyMinIntervalSeconds);
        const ctx: AlertContext = await alertContextFor(tenantId, siteId, item.status as string, now, alerting.window);
        stepOf = (stateRow) => stepAlert(toAlertState(stateRow), { kind: 'tick' }, alerting, {
          ...ctx,
          stale: isStale(dateOrNull(stateRow.last_checked_at), interval, now),
        });
      }

      // Cheap check on the snapshot first; the locked re-read below decides.
      const snapshot = toAlertState(row);
      const dry = stepOf(row);
      if (dry.actions.length === 0 && !alertStateChanged(snapshot, dry.next)) continue;

      const outcome = await db.transaction(async (trx) => {
        // The rule was read before this transaction: re-read it under FOR
        // SHARE (as applyResult does; lock order: rule, then state row), so
        // a disable / suspension / edit either committed already (seen here)
        // or waits for this step. A rule that is no longer active closes the
        // row silently — a tick never opens an alert for it; a rule edited
        // meanwhile (new revision) is left to the next tick and its new spec.
        const current = await trx('device_check_rules')
          .where({ id: ruleId, tenant_id: tenantId })
          .forShare()
          .first('enabled', 'suspended_reason', 'revision') as Record<string, unknown> | undefined;
        if (!current) return null; // deleted: its state rows cascade
        const active = current.enabled === true
          && (current.suspended_reason === null || current.suspended_reason === undefined);
        let decide = stepOf;
        if (!active) decide = (stateRow) => closeSilently(toAlertState(stateRow), 'rule_disabled');
        else if (Number(current.revision) !== Number(row.r_revision)) return null;

        const fresh = await trx('device_check_state')
          .where({ id: row.id, tenant_id: tenantId })
          .forUpdate()
          .first() as Record<string, unknown> | undefined;
        if (!fresh) return null;
        const prev = toAlertState(fresh);
        const step = decide(fresh);
        if (step.actions.length === 0 && !alertStateChanged(prev, step.next)) return null;
        await trx('device_check_state').where({ id: row.id }).update({ ...alertColumns(step.next), updated_at: new Date() });
        const base: EventBase = {
          tenant_id: tenantId,
          rule_id: ruleId,
          site_item_id: Number(row.site_item_id),
          site_id: siteId,
          probe_id: (fresh.probe_id as number | null) ?? null,
        };
        const events = actionEventRows(base, prev.alert_state, step.next.alert_state, step.actions, {
          errorCode: (fresh.last_error_code as string | null) ?? null,
        });
        if (events.length > 0) await trx('device_check_events').insert(events);
        return { prevState: prev.alert_state as DeviceCheckAlertState, step, fresh };
      });
      if (!outcome) continue;
      changed++;

      const { prevState, step, fresh } = outcome;
      if (step.next.alert_state !== prevState) {
        emitAlertChange(tenantId, {
          siteId, itemId: Number(row.site_item_id), ruleId, from: prevState, to: step.next.alert_state,
        });
      }
      // Silent closes have no side effect; a rule whose spec no longer
      // validates has nothing to render them with anyway.
      if (rule && step.actions.some((a) => a.type !== 'close' || a.notify)) {
        const r = fresh as unknown as SweepRow;
        const status = (['ok', 'fail', 'error', 'pending'].includes(r.status) ? r.status : 'pending') as 'ok' | 'fail' | 'error' | 'pending';
        void runAlertSideEffects({
          tenantId,
          stateId: Number(row.id),
          probeId: r.probe_id ?? null,
          rule: { id: rule.id, name: rule.name, spec: rule.spec },
          site: { id: Number(site.id), name: String(site.name ?? ''), groupId: (site.group_id as number | null) ?? null },
          item: {
            id: Number(item.id),
            ip: String(item.ip),
            mac: (item.mac as string | null) ?? null,
            name: deviceNameOf(item as { ip: string; hostname?: string | null; custom_name?: string | null }),
          },
          actions: step.actions,
          status,
          values: jsonValue(r.values, {}),
          assertions: jsonValue(r.assertions, null),
          error: r.last_error_code ? { code: r.last_error_code, message: r.last_error ?? '' } : null,
          alertSince: step.next.alert_since,
          at: now,
        });
      }
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, stateId: row.id }, 'Device check sweep failed for a state row');
    }
  }
  return changed;
}

/** Deletes matching rows in batches (no long lock on a big table). Returns the count. */
async function deleteInBatches(build: () => Knex.QueryBuilder, table = 'device_check_events'): Promise<number> {
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const ids = build().select('id').limit(DELETE_BATCH);
    const deleted = Number(await db(table).whereIn('id', ids).delete()) || 0;
    total += deleted;
    if (deleted < DELETE_BATCH) break;
  }
  return total;
}

/**
 * Hourly retention, plus the other append-only tables of the platform
 * (notification delivery log, network flows, IP history).
 */
export async function runDeviceCheckRetention(now: Date = new Date()): Promise<void> {
  // Each step is independent: one failing table never skips the others.
  const step = async (name: string, run: () => Promise<number>): Promise<number> => {
    try {
      return await run();
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, step: name }, 'Retention step failed');
      return 0;
    }
  };
  const daysAgo = (days: number): Date => new Date(now.getTime() - days * 86_400_000);
  const policy = await appConfigService.getDeviceChecksPolicy().catch((err: unknown) => {
    logger.warn({ err: (err as Error)?.message, step: 'policy' }, 'Retention step failed');
    return null;
  });
  const values = policy ? await step('device_check_events.values', () => deleteInBatches(() => db('device_check_events')
    .where('kind', 'value_changed')
    .where('created_at', '<', daysAgo(policy.valueEventRetentionDays)))) : 0;
  const others = policy ? await step('device_check_events', () => deleteInBatches(() => db('device_check_events')
    .whereNot('kind', 'value_changed')
    .where('created_at', '<', daysAgo(policy.eventRetentionDays)))) : 0;
  const audit = await step('audit_logs', () => auditService.purgeOlderThan(AUDIT_RETENTION_DAYS));
  const notificationLog = await step('notification_log', () => deleteInBatches(() => db('notification_log')
    .where('created_at', '<', daysAgo(NOTIFICATION_LOG_RETENTION_DAYS)), 'notification_log'));
  const flows = await step('network_flows', () => deleteInBatches(() => db('network_flows')
    .where('last_seen_at', '<', daysAgo(NETWORK_FLOW_RETENTION_DAYS)), 'network_flows'));
  const ipHistory = await step('item_ip_history', () => deleteInBatches(() => db('item_ip_history')
    .where('last_seen_at', '<', daysAgo(IP_HISTORY_RETENTION_DAYS)), 'item_ip_history'));
  const itemEvents = await step('site_item_events', () => deleteInBatches(() => db('site_item_events')
    .where('created_at', '<', daysAgo(ITEM_EVENTS_RETENTION_DAYS)), 'site_item_events'));
  // Finished tunnels only: an 'opening' / 'active' row is a live tunnel (the
  // probe's data WS upgrade looks it up), closed_at is set on every close.
  const tunnels = await step('tunnels', () => deleteInBatches(() => db('tunnels')
    .whereIn('status', ['closed', 'error'])
    .where('closed_at', '<', daysAgo(CLOSED_TUNNEL_RETENTION_DAYS)), 'tunnels'));
  // A reset token lives 1 h (passwordReset TOKEN_EXPIRY_MS) and is only
  // usable before expires_at, so "expired for a day" also covers the used
  // ones, whatever the column variant (used / used_at) of the database.
  const resetTokens = await step('password_reset_tokens', () => deleteInBatches(() => db('password_reset_tokens')
    .where('expires_at', '<', daysAgo(RESET_TOKEN_RETENTION_DAYS)), 'password_reset_tokens'));
  const liveAlerts = await step('live_alerts', () => liveAlertService.cleanup(LIVE_ALERT_RETENTION_DAYS));
  const staleDevices = await step('site_items.stale', () => purgeStaleDevices(now));
  if (values + others + audit + notificationLog + flows + ipHistory + itemEvents + tunnels + resetTokens
    + liveAlerts + staleDevices > 0) {
    logger.info({
      valueEvents: values, events: others, auditLogs: audit, notificationLog, networkFlows: flows, ipHistory,
      itemEvents, tunnels, resetTokens, liveAlerts, staleDevices,
    }, 'Retention');
  }
}

/** staleDeviceDays as resolved for a site: 0 (disabled) when unset or invalid. */
export function staleDaysFrom(resolved: Partial<ResolvedSettings> | null | undefined): number {
  const v = resolved?.staleDeviceDays?.value;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(STALE_DEVICE_DAYS_MAX, Math.floor(n));
}

/**
 * Stale device purge, hourly with the retention: on every site
 * whose resolved staleDeviceDays is > 0, the discovered devices offline and
 * not seen for that many days are deleted — never a manual device, never
 * one holding a reservation of the site (on its IP, as the reservation's
 * owner item_id, or through reserved_mac). Only tenants that set the key
 * somewhere are looked at (the default, 0, disables it). One audit entry
 * 'site_item.purged' per site with the count; the site's Device Checks
 * assignment is refreshed (the device-offline alerts of the deleted rows are
 * resolved by the self-healing job) and the site's readers get SITE_UPDATED.
 * Returns the number of devices deleted.
 */
export async function purgeStaleDevices(now: Date = new Date()): Promise<number> {
  const tenantRows = await db('settings')
    .where({ key: 'staleDeviceDays' })
    .whereNotNull('tenant_id')
    .distinct('tenant_id') as Array<{ tenant_id: number }>;
  const tenantIds = tenantRows.map((r) => Number(r.tenant_id)).filter((id) => Number.isInteger(id) && id > 0);
  if (tenantIds.length === 0) return 0;

  // Sites holding at least one candidate (offline, discovered, not seen for a day).
  const siteRows = await db('site_items')
    .whereIn('tenant_id', tenantIds)
    .where({ status: 'offline', is_manual: false })
    .where('last_seen_at', '<', new Date(now.getTime() - 86_400_000))
    .distinct('site_id', 'tenant_id') as Array<{ site_id: number; tenant_id: number }>;

  let total = 0;
  for (const row of siteRows) {
    const siteId = Number(row.site_id);
    const tenantId = Number(row.tenant_id);
    try {
      const days = staleDaysFrom(await settingsService.resolveForSite(tenantId, siteId));
      if (days <= 0) continue;
      const cutoff = new Date(now.getTime() - days * 86_400_000);
      let deleted = 0;
      for (let i = 0; i < 100; i++) {
        const ids = db('site_items as si')
          .where({ 'si.site_id': siteId, 'si.tenant_id': tenantId, 'si.status': 'offline', 'si.is_manual': false })
          .where('si.last_seen_at', '<', cutoff)
          .whereNotExists(function reserved() {
            this.select(db.raw('1')).from('ip_reservations as r')
              .whereRaw('r.site_id = si.site_id')
              .whereRaw('r.tenant_id = si.tenant_id')
              .whereRaw('(r.ip = si.ip OR r.item_id = si.id OR (r.reserved_mac IS NOT NULL AND upper(r.reserved_mac) = upper(si.mac)))');
          })
          .select('si.id')
          .limit(DELETE_BATCH);
        const removed = await db('site_items').where({ site_id: siteId, tenant_id: tenantId }).whereIn('id', ids)
          .delete()
          .returning(['id', 'ip', 'mac', 'custom_name', 'hostname']) as Array<{
            id: number; ip: string; mac: string | null; custom_name: string | null; hostname: string | null;
          }>;
        const n = removed.length;
        deleted += n;
        // Device history: one 'purged' event per device (the rows are gone: ids in details).
        if (n > 0) {
          await recordItemEvents(removed.map((r) => ({
            tenantId,
            siteId,
            kind: 'purged' as const,
            itemId: null,
            mac: r.mac ?? null,
            ip: r.ip,
            details: {
              itemId: Number(r.id),
              name: (r.custom_name && r.custom_name.trim()) || (r.hostname && r.hostname.trim()) || r.ip || null,
              staleDeviceDays: days,
            },
            at: now,
          })));
        }
        if (n < DELETE_BATCH) break;
      }
      if (deleted === 0) continue;
      total += deleted;
      void auditService.log({
        tenantId,
        action: 'site_item.purged',
        resourceType: 'site',
        resourceId: siteId,
        details: { count: deleted, staleDeviceDays: days },
      });
      emitSiteUpdated(tenantId, siteId);
      await pushConfigToAffectedProbes(tenantId, [siteId]).catch((err: unknown) =>
        logger.warn({ err: (err as Error)?.message, tenantId, siteId }, 'Device checks config push after a stale purge failed'));
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, tenantId, siteId }, 'Stale device purge failed for a site');
    }
  }
  return total;
}

/**
 * Starts the 60 s alert sweep and the hourly retention. Returns the stop
 * function (clears every timer). Runs never overlap.
 */
export function startDeviceCheckSweeper(): () => void {
  let sweeping = false;
  let purging = false;

  const tick = (): void => {
    if (sweeping) return;
    sweeping = true;
    sweepAlertStates()
      .catch((err: unknown) => logger.warn({ err: (err as Error)?.message }, 'Device checks sweep failed'))
      .finally(() => { sweeping = false; });
  };
  const retention = (): void => {
    if (purging) return;
    purging = true;
    runDeviceCheckRetention()
      .catch((err: unknown) => logger.warn({ err: (err as Error)?.message }, 'Device checks retention failed'))
      .finally(() => { purging = false; });
  };

  const tickTimer = setInterval(tick, TICK_MS);
  const retentionTimer = setInterval(retention, RETENTION_MS);
  const firstRetention = setTimeout(retention, FIRST_RETENTION_DELAY_MS);
  tickTimer.unref?.();
  retentionTimer.unref?.();
  firstRetention.unref?.();

  return () => {
    clearInterval(tickTimer);
    clearInterval(retentionTimer);
    clearTimeout(firstRetention);
  };
}
