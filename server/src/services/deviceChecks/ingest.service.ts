import type { Knex } from 'knex';
import { SOCKET_EVENTS } from '@oblimap/shared';
import type {
  BusinessHours,
  DeviceCheckAlertState,
  DeviceCheckAssertionResult,
  DeviceCheckSpec,
  DeviceCheckStatus,
  DeviceCheckTraceStep,
  DeviceCheckValue,
} from '@oblimap/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { AppError } from '../../middleware/errorHandler';
import { isOpen, openSince } from '../../utils/businessHours';
import { renderTemplate, sanitizeTemplateValue, type TemplateVars } from '../../utils/templates';
import { appConfigService } from '../appConfig.service';
import { liveAlertService } from '../liveAlert.service';
import { notificationService } from '../notification.service';
import { emitToSiteReaders } from '../realtime.service';
import { probeCheckResultsBatchSchema, type ParsedProbeCheckResult } from '../../validators/deviceCheck.schema';
import {
  assignmentCache,
  deviceChecksIO,
  getSiteCheckSettings,
  type Assignment,
} from './config.service';
import {
  buildCheckSummary,
  coerceValues,
  computeStatus,
  displayedKeys,
  effectiveIntervalSeconds,
  evaluateAssertions,
  failedAssertionLabels,
  isStale,
  notePolicyMinIntervalSeconds,
  stepAlert,
  toAlertState,
  updateChangedAt,
  type AlertAction,
  type AlertContext,
  type AlertState,
} from './eval';

// Result ingestion and the side effects of the alert state
// machine: live alerts, notifications, socket events.
//
// Identity comes from the caller (the probe's WS connection or probeAuth),
// never from the payload. A result is accepted only for a current rule:item
// assignment of that probe, at the current rule revision; the state row is
// locked (FOR UPDATE) while it is updated, results older than the stored one
// (out-of-order HTTP flush) are dropped, and every side effect runs after the
// transaction committed.

export { setDeviceChecksIO } from './config.service';

// ── Socket events ────────────────────────────────────────────────────────────
//
// DEVICE_CHECK_UPDATED / DEVICE_CHECK_ALERT carry a site's device data
// (non-sensitive values, rule name, status). They go only to the sockets of
// the tenant whose user may read that site (realtime.service
// emitToSiteReaders: permissionService getVisibleSiteIds, what the REST reads
// of the same data enforce), never to the whole `tenant:${id}` room. These
// events are not emitted to the admin room separately, so the admin sockets
// are included (includeAdminRoom).

const SITE_READERS_AND_ADMINS = { includeAdminRoom: true } as const;

const UPDATE_MIN_INTERVAL_MS = 5_000;
const MAX_THROTTLES = 10_000;

interface UpdateThrottle {
  lastAt: number;
  pending: { siteId: number; payload: unknown } | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const updateThrottles = new Map<string, UpdateThrottle>();

function pruneThrottles(now: number): void {
  for (const [key, t] of updateThrottles) {
    if (!t.timer && now - t.lastAt > 60_000) updateThrottles.delete(key);
  }
}

/**
 * DEVICE_CHECK_UPDATED to the members who may read the site: at most one per
 * (rule, item) every 5 s — a newer summary within the window replaces the
 * waiting one and is sent when the window ends (never lost).
 */
export function emitCheckUpdated(
  tenantId: number,
  payload: { siteId: number; itemId: number; ruleId: number; summary: unknown },
): void {
  if (!deviceChecksIO()) return;
  const key = `${tenantId}:${payload.itemId}:${payload.ruleId}`;
  const now = Date.now();
  let t = updateThrottles.get(key);
  if (!t) {
    if (updateThrottles.size >= MAX_THROTTLES) pruneThrottles(now);
    t = { lastAt: 0, pending: null, timer: null };
    updateThrottles.set(key, t);
  }
  if (!t.timer && now - t.lastAt >= UPDATE_MIN_INTERVAL_MS) {
    t.lastAt = now;
    emitToSiteReaders(tenantId, payload.siteId, SOCKET_EVENTS.DEVICE_CHECK_UPDATED, payload, SITE_READERS_AND_ADMINS);
    return;
  }
  t.pending = { siteId: payload.siteId, payload };
  if (!t.timer) {
    const entry = t;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const p = entry.pending;
      entry.pending = null;
      if (!p) return;
      entry.lastAt = Date.now();
      emitToSiteReaders(tenantId, p.siteId, SOCKET_EVENTS.DEVICE_CHECK_UPDATED, p.payload, SITE_READERS_AND_ADMINS);
    }, Math.max(0, entry.lastAt + UPDATE_MIN_INTERVAL_MS - now));
    entry.timer.unref?.();
  }
}

/** DEVICE_CHECK_ALERT {siteId, itemId, ruleId, from, to} to the members who may read the site. */
export function emitAlertChange(
  tenantId: number,
  payload: { siteId: number; itemId: number; ruleId: number; from: DeviceCheckAlertState; to: DeviceCheckAlertState },
): void {
  emitToSiteReaders(tenantId, payload.siteId, SOCKET_EVENTS.DEVICE_CHECK_ALERT, payload, SITE_READERS_AND_ADMINS);
}

// ── Alert context ────────────────────────────────────────────────────────────

/**
 * Business-hours window of the site at `at` + the device's IPAM status. The
 * site settings are only read when the rule alerts during business hours
 * (`window` 'businessHours').
 */
export async function alertContextFor(
  tenantId: number,
  siteId: number,
  itemStatus: string | null | undefined,
  at: Date,
  window: 'always' | 'businessHours' = 'businessHours',
): Promise<AlertContext> {
  let windowOpen = true;
  let since: Date | null = null;
  if (window === 'always') return { now: at, windowOpen, openSince: since, itemOffline: itemStatus === 'offline' };
  try {
    const { businessHours } = await getSiteCheckSettings(tenantId, siteId);
    const bh = businessHours as BusinessHours | string | null;
    windowOpen = isOpen(bh, at);
    since = windowOpen ? openSince(bh, at) : null;
  } catch (err) {
    // An invalid stored schedule never silences alerts: treated as always open.
    logger.warn({ err: (err as Error)?.message, siteId }, 'Device checks: business hours unreadable — treated as always open');
    windowOpen = true;
    since = null;
  }
  return { now: at, windowOpen, openSince: since, itemOffline: itemStatus === 'offline' };
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface EventBase {
  tenant_id: number;
  rule_id: number | null;
  site_item_id: number | null;
  site_id: number | null;
  probe_id: number | null;
}

/** Plain, single-line text of at most `max` characters (also bounds varchar columns). */
function shortText(v: unknown, max = 200): string | null {
  if (v === null || v === undefined) return null;
  // neutralizeMentions may add a few characters: cut again.
  const s = sanitizeTemplateValue(v, max).slice(0, max);
  return s === '' ? null : s;
}

/** device_check_events rows for the actions of one stepAlert. */
export function actionEventRows(
  base: EventBase,
  prevAlertState: DeviceCheckAlertState,
  nextAlertState: DeviceCheckAlertState,
  actions: readonly AlertAction[],
  extra: { failed?: string[]; errorCode?: string | null } = {},
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const a of actions) {
    switch (a.type) {
      case 'open':
        rows.push({
          ...base, kind: 'alert_opened', from_status: prevAlertState, to_status: 'alerting',
          details: JSON.stringify({
            failed: (extra.failed ?? []).slice(0, 5).map((l) => shortText(l, 100)),
            errorCode: extra.errorCode ?? null,
          }),
        });
        break;
      case 'close':
        rows.push({
          ...base, kind: 'alert_closed', from_status: 'alerting', to_status: nextAlertState,
          details: JSON.stringify({ reason: a.reason, notify: a.notify }),
        });
        break;
      case 'reminder':
        rows.push({ ...base, kind: 'alert_reminder', from_status: 'alerting', to_status: 'alerting', details: null });
        break;
      case 'suppress':
        rows.push({ ...base, kind: 'alert_suppressed', from_status: prevAlertState, to_status: 'suppressed', details: null });
        break;
      default:
        break;
    }
  }
  return rows;
}

/** The alerting columns of AlertState as a device_check_state update. */
export function alertColumns(s: AlertState): Record<string, unknown> {
  return {
    alert_state: s.alert_state,
    alert_since: s.alert_since,
    last_notified_at: s.last_notified_at,
    consecutive_bad: s.consecutive_bad,
    consecutive_ok: s.consecutive_ok,
    bad_since: s.bad_since,
    ok_since: s.ok_since,
  };
}

// ── Side effects ──────────────────────────────────────────────────────

export interface CheckTarget {
  tenantId: number;
  stateId: number;
  probeId: number | null;
  rule: { id: number; name: string; spec: DeviceCheckSpec };
  site: { id: number; name: string; groupId: number | null };
  item: { id: number; ip: string; mac: string | null; name: string };
}

export interface SideEffectInput extends CheckTarget {
  actions: AlertAction[];
  status: DeviceCheckStatus;
  values: Record<string, DeviceCheckValue>;
  assertions: DeviceCheckAssertionResult[] | null;
  error: { code: string; message: string } | null;
  /** alert_since after the step (the alert just opened, or still open). */
  alertSince: Date | null;
  at: Date;
}

const DEFAULT_TITLE = '{{rule}}: {{device}} ({{site}})';
const DEFAULT_MESSAGE = '{{failedAssertion}}{{error}}';

/** Non-sensitive values only (templates, notifications). */
function publicValues(spec: DeviceCheckSpec, values: Record<string, DeviceCheckValue>): Record<string, DeviceCheckValue> {
  const out: Record<string, DeviceCheckValue> = {};
  for (const f of spec.fields) {
    if (f.sensitive) continue;
    if (Object.prototype.hasOwnProperty.call(values, f.key)) out[f.key] = values[f.key];
  }
  return out;
}

function checkValuesOf(spec: DeviceCheckSpec, values: Record<string, DeviceCheckValue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(publicValues(spec, values)).slice(0, 12)) {
    out[k] = v === null ? '' : sanitizeTemplateValue(v);
  }
  return out;
}

function epochSeconds(d: Date | null): number {
  return d ? Math.floor(d.getTime() / 1000) : 0;
}

function templateVars(i: SideEffectInput, since: Date | null): TemplateVars {
  const failed = failedAssertionLabels(i.assertions).slice(0, 3).join(', ');
  const error = i.status === 'error' && i.error ? (i.error.message || i.error.code) : '';
  return {
    rule: i.rule.name,
    site: i.site.name,
    device: i.item.name,
    ip: i.item.ip,
    mac: i.item.mac ?? '',
    status: i.status,
    failedAssertion: failed,
    error,
    since: since ? since.toISOString() : '',
    values: publicValues(i.rule.spec, i.values),
  };
}

async function recordNotifyFailures(
  i: SideEffectInput,
  action: AlertAction['type'],
  results: Array<{ channelId: number; ok: boolean; error?: string }>,
): Promise<void> {
  const failed = results.filter((r) => !r.ok).slice(0, 20);
  if (failed.length === 0) return;
  await db('device_check_events').insert(failed.map((r) => ({
    tenant_id: i.tenantId,
    rule_id: i.rule.id,
    site_item_id: i.item.id,
    site_id: i.site.id,
    probe_id: i.probeId,
    kind: 'notify_failed',
    details: JSON.stringify({ channelId: r.channelId, action, error: shortText(r.error ?? 'Delivery failed', 100) }),
  }))).catch((err: unknown) => logger.warn({ err: (err as Error)?.message }, 'notify_failed events not written'));
}

async function notify(
  i: SideEffectInput,
  action: AlertAction['type'],
  oldStatus: 'up' | 'down',
  newStatus: 'up' | 'down',
  message: string,
): Promise<void> {
  // The site's notificationEnabled master switch also silences device checks.
  if (!(await getSiteCheckSettings(i.tenantId, i.site.id)).notificationsEnabled) return;
  const results = await notificationService.sendForSite(i.tenantId, i.site.groupId, {
    monitorName: sanitizeTemplateValue(`${i.rule.name} — ${i.item.name} @ ${i.site.name}`, 300),
    oldStatus,
    newStatus,
    message,
    timestamp: i.at.toISOString(),
    isIpamNotification: true,
    siteName: i.site.name,
    siteId: i.site.id,
    deviceIp: i.item.ip,
    deviceMac: i.item.mac,
    deviceName: i.item.name,
    eventType: 'device_check',
    ruleName: i.rule.name,
    checkValues: checkValuesOf(i.rule.spec, i.values),
  }, i.site.id);
  await recordNotifyFailures(i, action, results);
}

/** stable_key of the live alert of a device-check alert that opened at `since`. */
export function deviceCheckAlertKey(stateId: number, since: Date | null): string {
  return `devcheck:${stateId}:${epochSeconds(since)}`;
}

/**
 * Resolves the live alert of a closed device-check alert (`alertSince` = the
 * alert's start, the open key). Also for callers that close alerts outside
 * runAlertSideEffects (rule disabled). Never throws.
 */
export async function resolveDeviceCheckLiveAlert(tenantId: number, stateId: number, alertSince: Date | null): Promise<void> {
  if (!alertSince) return;
  try {
    await liveAlertService.resolve(tenantId, deviceCheckAlertKey(stateId, alertSince));
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, stateId }, 'Device check live alert not resolved');
  }
}

/**
 * Live alerts and notifications for the actions of one step. Never throws
 * (each delivery failure is logged; per-channel failures become notify_failed
 * events).
 */
export async function runAlertSideEffects(i: SideEffectInput): Promise<void> {
  const al = i.rule.spec.alerting;
  const navigateTo = `/sites/${i.site.id}?device=${i.item.id}&check=${i.rule.id}`;
  // Structured live alerts (kind + params: translated, anonymized client
  // side) only when the rule keeps the default title: a custom title template
  // is the rule author's text, shown as it is (IPs / MACs masked by the
  // client in anonymous mode).
  const structured = (kind: 'device_check_open' | 'device_check_recovered', detail?: string) => (
    al.titleTemplate
      ? {}
      : {
        kind,
        params: {
          ruleName: i.rule.name,
          deviceName: i.item.name,
          ip: i.item.ip,
          siteName: i.site.name,
          // A custom message template is the rule author's text: not passed
          // as a param (the client shows the English message, regex-masked).
          ...(detail && !al.messageTemplate ? { detail } : {}),
        },
      }
  );
  // The site's notificationEnabled master switch silences the live alerts of
  // device checks too (notify() checks it for the channels). Read once, lazily.
  let liveAlertsOn: boolean | null = null;
  const liveAlertsEnabled = async (): Promise<boolean> => {
    if (liveAlertsOn === null) liveAlertsOn = (await getSiteCheckSettings(i.tenantId, i.site.id)).notificationsEnabled;
    return liveAlertsOn;
  };

  for (const action of i.actions) {
    try {
      if (action.type === 'open') {
        const vars = templateVars(i, action.at);
        const title = renderTemplate(al.titleTemplate || DEFAULT_TITLE, vars) || renderTemplate(DEFAULT_TITLE, vars);
        const message = renderTemplate(al.messageTemplate || DEFAULT_MESSAGE, vars) || 'The device check is failing.';
        if (al.liveAlert && await liveAlertsEnabled()) {
          await liveAlertService.add(i.tenantId, {
            severity: al.severity,
            title,
            message,
            navigateTo,
            stableKey: deviceCheckAlertKey(i.stateId, action.at),
            ...structured('device_check_open', message),
          });
        }
        if (al.notify) await notify(i, 'open', 'up', 'down', message);
      } else if (action.type === 'close') {
        // The alert is over, whatever the reason and whether the closing is
        // announced: its live alert is resolved (same key as at the open).
        await resolveDeviceCheckLiveAlert(i.tenantId, i.stateId, action.alertSince);
        if (!action.notify) continue;
        const vars = templateVars(i, action.alertSince);
        const baseTitle = renderTemplate(al.titleTemplate || DEFAULT_TITLE, vars) || renderTemplate(DEFAULT_TITLE, vars);
        const recovered = action.reason === 'recovered';
        const title = recovered ? `Recovered: ${baseTitle}` : `Alert closed (outside business hours): ${baseTitle}`;
        const message = recovered
          ? `${sanitizeTemplateValue(i.item.name)} (${i.item.ip}): the check passes again.`
          : `${sanitizeTemplateValue(i.item.name)} (${i.item.ip}): the alert was closed at the end of business hours.`;
        if (al.liveAlert && await liveAlertsEnabled()) {
          await liveAlertService.add(i.tenantId, {
            severity: 'up',
            title,
            message,
            navigateTo,
            stableKey: `devcheck:${i.stateId}:${epochSeconds(action.alertSince)}:${recovered ? 'recovered' : 'closed'}`,
            // The closing at the end of business hours has no kind of its own.
            ...(recovered ? structured('device_check_recovered') : {}),
          });
        }
        if (al.notify) await notify(i, 'close', 'down', 'up', message);
      } else if (action.type === 'reminder') {
        if (!al.notify) continue;
        const vars = templateVars(i, action.alertSince);
        const message = renderTemplate(al.messageTemplate || DEFAULT_MESSAGE, vars) || 'The device check is still failing.';
        await notify(i, 'reminder', 'down', 'down', `Still failing: ${message}`);
      }
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, ruleId: i.rule.id, itemId: i.item.id, action: action.type }, 'Device check alert side effect failed');
    }
  }
}

// ── Rejections (rate-limited event) ──────────────────────────────────────────

const REJECT_EVENT_WINDOW_MS = 60 * 60_000;
const rejections = new Map<number, { lastEventAt: number; count: number }>();

async function noteRejection(
  probe: { id: number; tenant_id: number; site_id: number | null },
  r: Pick<ParsedProbeCheckResult, 'ruleId' | 'itemId' | 'ruleRev'>,
  reason: 'not_assigned' | 'stale_revision' | 'unknown_item',
): Promise<void> {
  const now = Date.now();
  let entry = rejections.get(probe.id);
  if (!entry) {
    if (rejections.size >= MAX_THROTTLES) rejections.clear();
    entry = { lastEventAt: 0, count: 0 };
    rejections.set(probe.id, entry);
  }
  entry.count++;
  if (now - entry.lastEventAt < REJECT_EVENT_WINDOW_MS) return;
  const dropped = entry.count;
  entry.lastEventAt = now;
  entry.count = 0;
  logger.info({ probeId: probe.id, reason, ruleId: r.ruleId, itemId: r.itemId, dropped }, 'Device check results rejected');
  await db('device_check_events').insert({
    tenant_id: probe.tenant_id,
    site_id: probe.site_id,
    probe_id: probe.id,
    kind: 'result_rejected',
    details: JSON.stringify({ reason, ruleId: r.ruleId, itemId: r.itemId, ruleRev: r.ruleRev, rejectedSinceLastEvent: dropped }),
  }).catch((err: unknown) => logger.warn({ err: (err as Error)?.message }, 'result_rejected event not written'));
}

// ── Ingestion ────────────────────────────────────────────────────────────────

const MAX_TRACE_BYTES = 8 * 1024;

/** The trace to store (≤ 8 KiB, never a body), or undefined to keep the previous one. */
function capTrace(trace: DeviceCheckTraceStep[] | undefined): DeviceCheckTraceStep[] | undefined {
  if (!trace) return undefined;
  const out: DeviceCheckTraceStep[] = [];
  let size = 2;
  for (const s of trace) {
    const step: DeviceCheckTraceStep = {
      step: sanitizeTemplateValue(s.step, 64),
      status: s.status,
      ms: s.ms,
      ...(s.detail ? { detail: sanitizeTemplateValue(s.detail, 200) } : {}),
    };
    size += JSON.stringify(step).length + 1;
    if (size > MAX_TRACE_BYTES) break;
    out.push(step);
  }
  return out;
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}

function jsonObject<T>(v: unknown, fallback: T): T {
  let parsed = v;
  if (typeof v === 'string') {
    try { parsed = JSON.parse(v); } catch { return fallback; }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : fallback;
}

interface ItemInfo {
  id: number;
  ip: string;
  mac: string | null;
  hostname: string | null;
  custom_name: string | null;
  status: string;
}

export function deviceNameOf(item: { ip: string; hostname?: string | null; custom_name?: string | null }): string {
  return item.custom_name || item.hostname || item.ip;
}

interface Applied {
  stateId: number;
  prevStatus: string;
  status: DeviceCheckStatus;
  prevAlertState: DeviceCheckAlertState;
  next: AlertState;
  actions: AlertAction[];
  values: Record<string, DeviceCheckValue>;
  assertions: DeviceCheckAssertionResult[] | null;
  displayChanged: boolean;
}

async function applyResult(
  trx: Knex.Transaction,
  tenantId: number,
  probeId: number,
  a: Assignment,
  r: ParsedProbeCheckResult,
  at: Date,
  alertCtx: AlertContext,
  policyMinIntervalSeconds: number,
): Promise<Applied | null> {
  // The assignment was read before this transaction (and may come from the
  // cache): re-read the rule under FOR SHARE, so a disable / suspension /
  // edit either committed already (the result is dropped here) or waits for
  // this transaction (and then closes what it stored). A result in flight can
  // never reopen an alert of a rule that was just disabled. Lock order: rule,
  // then state row.
  const current = await trx('device_check_rules')
    .where({ id: a.ruleId, tenant_id: tenantId })
    .forShare()
    .first('enabled', 'suspended_reason', 'revision') as Record<string, unknown> | undefined;
  if (
    !current
    || current.enabled !== true
    || (current.suspended_reason !== null && current.suspended_reason !== undefined)
    || Number(current.revision) !== r.ruleRev
  ) {
    return null;
  }

  await trx('device_check_state')
    .insert({
      tenant_id: tenantId,
      rule_id: a.ruleId,
      site_item_id: a.itemId,
      site_id: a.siteId,
      probe_id: probeId,
      rule_revision: r.ruleRev,
      status: 'pending',
    })
    .onConflict(['rule_id', 'site_item_id'])
    .ignore();
  const prev = await trx('device_check_state')
    .where({ rule_id: a.ruleId, site_item_id: a.itemId, tenant_id: tenantId })
    .forUpdate()
    .first() as Record<string, unknown> | undefined;
  if (!prev) return null;

  const prevChecked = asDate(prev.last_checked_at);
  if (prevChecked && at.getTime() <= prevChecked.getTime()) return null; // out of order

  const spec = a.rule.spec;
  const prevValues = jsonObject<Record<string, unknown>>(prev.values, {});
  const prevChangedAt = jsonObject<Record<string, string>>(prev.values_changed_at, {});

  let values: Record<string, DeviceCheckValue>;
  let changedAt: Record<string, string>;
  let changedKeys: string[] = [];
  let assertions: DeviceCheckAssertionResult[] | null;
  if (r.status === 'ok') {
    values = coerceValues(spec.fields, r.values);
    ({ changedAt, changedKeys } = updateChangedAt(prevValues, prevChangedAt, values, at));
    assertions = evaluateAssertions(spec, values, r.regex, changedAt, at);
  } else {
    // A failed run keeps the last values seen (alerts show the "last title").
    values = coerceValues(spec.fields, prevValues);
    changedAt = Object.fromEntries(Object.entries(prevChangedAt).filter(([k]) => k in values));
    assertions = null;
  }
  const status = computeStatus(r, assertions);
  const prevState = toAlertState(prev);
  const { next, actions } = stepAlert(prevState, { kind: 'result', status, errorCode: r.error?.code ?? null }, spec.alerting, alertCtx);
  const trace = capTrace(r.trace);

  await trx('device_check_state').where({ id: prev.id }).update({
    ...alertColumns(next),
    status,
    values: JSON.stringify(values),
    values_changed_at: JSON.stringify(changedAt),
    assertions: assertions ? JSON.stringify(assertions) : null,
    variant_id: r.variantId,
    ...(trace !== undefined ? { last_trace: JSON.stringify(trace) } : {}),
    last_error_code: r.error?.code ?? null,
    last_error: r.error ? shortText(r.error.message, 200) : null,
    last_checked_at: at,
    probe_id: probeId,
    rule_revision: r.ruleRev,
    site_id: a.siteId,
    updated_at: new Date(),
  });

  const base: EventBase = { tenant_id: tenantId, rule_id: a.ruleId, site_item_id: a.itemId, site_id: a.siteId, probe_id: probeId };
  const events: Array<Record<string, unknown>> = [];
  const prevStatus = String(prev.status ?? 'pending');
  if (status !== prevStatus) {
    events.push({
      ...base, kind: 'status_changed', from_status: prevStatus.slice(0, 16), to_status: status,
      details: r.error ? JSON.stringify({ errorCode: r.error.code }) : null,
    });
  }
  const fields = new Map(spec.fields.map((f) => [f.key, f]));
  for (const key of changedKeys) {
    const f = fields.get(key);
    if (!f?.historize) continue;
    events.push({
      ...base, kind: 'value_changed',
      details: JSON.stringify({ field: key, value: f.sensitive ? '[sensitive]' : values[key] === null ? null : shortText(values[key], 200) }),
    });
  }
  events.push(...actionEventRows(base, prevState.alert_state, next.alert_state, actions, {
    failed: failedAssertionLabels(assertions),
    errorCode: r.error?.code ?? null,
  }));
  if (events.length > 0) await trx('device_check_events').insert(events);

  const shown = displayedKeys(spec);
  const displayChanged = status !== prevStatus
    || next.alert_state !== prevState.alert_state
    || changedKeys.some((k) => shown.includes(k))
    || String(prev.last_error_code ?? '') !== String(r.error?.code ?? '')
    // Staleness against the interval the probe runs (policy minimum applied).
    || isStale(prevChecked, effectiveIntervalSeconds(spec.schedule.intervalSeconds, policyMinIntervalSeconds), at);

  return {
    stateId: Number(prev.id),
    prevStatus,
    status,
    prevAlertState: prevState.alert_state,
    next,
    actions,
    values,
    assertions,
    displayChanged,
  };
}

/**
 * Ingests a batch of check results from probe `ctx.probeId` of tenant
 * `ctx.tenantId` (identity from the WS connection or probeAuth). Throws
 * AppError(400) for a malformed batch. Results that are not for a current
 * assignment of this probe, carry an old rule revision or are older than the
 * stored state are rejected (counted, one event per hour per probe); so are
 * results whose rule was disabled, suspended or edited meanwhile (re-checked
 * inside the transaction).
 */
export async function ingest(
  ctx: { probeId: number; tenantId: number },
  raw: unknown,
): Promise<{ accepted: number; rejected: number }> {
  const parsed = probeCheckResultsBatchSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, 'Invalid check results');
  const batch = parsed.data;
  const total = batch.results.length;
  if (total === 0) return { accepted: 0, rejected: 0 };

  const probe = await db('probes').where({ id: ctx.probeId, tenant_id: ctx.tenantId }).first() as Record<string, unknown> | undefined;
  if (!probe || probe.status !== 'approved' || !probe.site_id) return { accepted: 0, rejected: total };
  const probeRef = { id: Number(probe.id), tenant_id: ctx.tenantId, site_id: Number(probe.site_id) };

  const assigned = await assignmentCache.getOrBuild(probe);
  // Staleness uses the effective interval (policy minimum): cached 60 s.
  const { minIntervalSeconds: policyMinIntervalSeconds } = await appConfigService.getDeviceChecksPolicy();
  notePolicyMinIntervalSeconds(policyMinIntervalSeconds);

  const now = Date.now();
  const skew = Math.max(-600_000, Math.min(600_000, now - Date.parse(batch.sentAt)));

  // Items and site of the batch, loaded once
  const itemIds = [...new Set(batch.results.map((r) => r.itemId))];
  const itemRows = await db('site_items')
    .where({ tenant_id: ctx.tenantId })
    .whereIn('id', itemIds)
    .select('id', 'ip', 'mac', 'hostname', 'custom_name', 'status') as ItemInfo[];
  const items = new Map(itemRows.map((i) => [Number(i.id), i]));
  const siteRow = await db('sites').where({ id: probeRef.site_id, tenant_id: ctx.tenantId }).first('id', 'name', 'group_id') as
    { id: number; name: string; group_id: number | null } | undefined;

  let accepted = 0;
  let rejected = 0;
  for (const r of batch.results) {
    const a = assigned.byKey.get(`${r.ruleId}:${r.itemId}`);
    if (!a || a.revision !== r.ruleRev) {
      rejected++;
      await noteRejection(probeRef, r, !a ? 'not_assigned' : 'stale_revision');
      continue;
    }
    const item = items.get(r.itemId);
    if (!item || !siteRow || a.siteId !== probeRef.site_id) {
      rejected++;
      await noteRejection(probeRef, r, 'unknown_item');
      continue;
    }

    const started = Date.parse(r.startedAt);
    const at = new Date(Math.min(now, started + skew));
    try {
      const alertCtx = await alertContextFor(ctx.tenantId, a.siteId, item.status, at, a.rule.spec.alerting.window);
      const applied = await db.transaction((trx) => applyResult(trx, ctx.tenantId, probeRef.id, a, r, at, alertCtx, policyMinIntervalSeconds));
      if (!applied) {
        rejected++;
        continue;
      }
      accepted++;
      afterCommit(ctx.tenantId, probeRef.id, a, item, siteRow, r, at, applied, policyMinIntervalSeconds);
    } catch (err) {
      rejected++;
      logger.warn({ err: (err as Error)?.message, probeId: probeRef.id, ruleId: r.ruleId, itemId: r.itemId }, 'Device check result not stored');
    }
  }
  return { accepted, rejected };
}

/** Socket events and alert side effects of one stored result (not awaited by ingest). */
function afterCommit(
  tenantId: number,
  probeId: number,
  a: Assignment,
  item: ItemInfo,
  site: { id: number; name: string; group_id: number | null },
  r: ParsedProbeCheckResult,
  at: Date,
  applied: Applied,
  policyMinIntervalSeconds: number,
): void {
  const rule = a.rule;
  if (applied.displayChanged) {
    emitCheckUpdated(tenantId, {
      siteId: a.siteId,
      itemId: a.itemId,
      ruleId: a.ruleId,
      summary: buildCheckSummary({
        stateId: applied.stateId,
        ruleId: rule.id,
        ruleName: rule.name,
        spec: rule.spec,
        status: applied.status,
        alertState: applied.next.alert_state,
        values: applied.values,
        lastCheckedAt: at,
        lastErrorCode: r.error?.code ?? null,
        policyMinIntervalSeconds,
      }, new Date()),
    });
  }
  if (applied.next.alert_state !== applied.prevAlertState) {
    emitAlertChange(tenantId, {
      siteId: a.siteId, itemId: a.itemId, ruleId: a.ruleId, from: applied.prevAlertState, to: applied.next.alert_state,
    });
  }
  if (applied.actions.length === 0) return;
  void runAlertSideEffects({
    tenantId,
    stateId: applied.stateId,
    probeId,
    rule: { id: rule.id, name: rule.name, spec: rule.spec },
    site: { id: site.id, name: site.name, groupId: site.group_id ?? null },
    item: { id: item.id, ip: item.ip, mac: item.mac, name: deviceNameOf(item) },
    actions: applied.actions,
    status: applied.status,
    values: applied.values,
    assertions: applied.assertions,
    error: r.error ? { code: r.error.code, message: r.error.message } : null,
    alertSince: applied.next.alert_since,
    at,
  });
}
