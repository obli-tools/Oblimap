import { DEVICE_CHECK_LIMITS } from '@oblimap/shared';
import type {
  DeviceCheckAlerting,
  DeviceCheckAlertState,
  DeviceCheckAssertionResult,
  DeviceCheckField,
  DeviceCheckSlot,
  DeviceCheckSpec,
  DeviceCheckStatus,
  DeviceCheckSummary,
  DeviceCheckValue,
  ProbeCheckErrorCode,
} from '@oblimap/shared';
import { unsafeTextRegExp } from '../../utils/templates';

// Device Checks evaluation. PURE: no database, no
// clock (the caller passes `now`), no I/O — unit-tested in
// tests/unit/deviceChecks/eval.test.ts.
//
// The server never executes a rule regex: matches / notMatches read the
// verdict the probe computed with RE2 (result.regex[assertionId]).

// ── Values ───────────────────────────────────────────────────────────────────

// C0 / C1 controls and the bidi / zero-width formatting characters used to
// disguise text: device-supplied strings are shown in the UI and in alerts.
const UNSAFE_CHARS_RE = unsafeTextRegExp();
const NUMERIC_RE = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/;
const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/** Truncates without splitting a surrogate pair. */
function sliceChars(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** Device text → safe, bounded string (control / formatting characters become a space). */
export function cleanValueString(s: string, max: number = DEVICE_CHECK_LIMITS.maxValueLength): string {
  return sliceChars(s.replace(UNSAFE_CHARS_RE, ' '), max);
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && NUMERIC_RE.test(v)) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (TRUE_WORDS.has(s)) return true;
    if (FALSE_WORDS.has(s)) return false;
  }
  return null;
}

function scalarToString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'boolean') return String(v);
  return null;
}

/** One raw value coerced to the field's declared type; null when it does not fit. */
export function coerceValue(field: DeviceCheckField, raw: unknown): DeviceCheckValue {
  if (raw === null || raw === undefined) return null;
  const max = Math.min(field.maxLength ?? DEVICE_CHECK_LIMITS.maxValueLength, DEVICE_CHECK_LIMITS.maxValueLength);
  switch (field.valueType) {
    case 'number':
      return toFiniteNumber(raw);
    case 'boolean':
      return toBoolean(raw);
    case 'enum': {
      const s = scalarToString(raw);
      if (s === null) return null;
      const clean = cleanValueString(s, max);
      return field.enumValues?.some((ev) => ev.value === clean) ? clean : null;
    }
    case 'string':
    default: {
      const s = scalarToString(raw);
      return s === null ? null : cleanValueString(s, max);
    }
  }
}

/**
 * Values reported by the probe → one entry per DECLARED field (null when
 * missing or not coercible). Undeclared keys are dropped; strings are
 * stripped of control characters and truncated to the field's maxLength.
 */
export function coerceValues(
  fields: readonly DeviceCheckField[],
  raw: Record<string, unknown> | null | undefined,
): Record<string, DeviceCheckValue> {
  const out: Record<string, DeviceCheckValue> = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const f of fields) {
    out[f.key] = Object.prototype.hasOwnProperty.call(src, f.key) ? coerceValue(f, src[f.key]) : null;
  }
  return out;
}

/**
 * values_changed_at after an observation at `at`: a field whose value
 * differs from the previous one — or that was never observed — changed at
 * `at` (the first observation counts as a change). Returns the new map and
 * the keys that changed.
 */
export function updateChangedAt(
  prevValues: Record<string, unknown> | null | undefined,
  prevChangedAt: Record<string, string> | null | undefined,
  values: Record<string, DeviceCheckValue>,
  at: Date,
): { changedAt: Record<string, string>; changedKeys: string[] } {
  const before = prevValues ?? {};
  const beforeAt = prevChangedAt ?? {};
  const changedAt: Record<string, string> = {};
  const changedKeys: string[] = [];
  const iso = at.toISOString();
  for (const [key, value] of Object.entries(values)) {
    const known = Object.prototype.hasOwnProperty.call(beforeAt, key) && typeof beforeAt[key] === 'string';
    const same = Object.prototype.hasOwnProperty.call(before, key) && before[key] === value;
    if (known && same) {
      changedAt[key] = beforeAt[key];
    } else {
      changedAt[key] = iso;
      changedKeys.push(key);
    }
  }
  return { changedAt, changedKeys };
}

// ── Assertions ────────────────────────────────────────────────────────

function valuesEqual(v: DeviceCheckValue, expected: unknown): boolean {
  if (v === null || expected === null || expected === undefined || Array.isArray(expected)) return false;
  if (typeof v === 'number') {
    const e = toFiniteNumber(expected);
    return e !== null && e === v;
  }
  if (typeof v === 'boolean') {
    const e = toBoolean(expected);
    return e !== null && e === v;
  }
  const e = scalarToString(expected);
  return e !== null && e === v;
}

function actualOf(v: DeviceCheckValue, sensitive: boolean | undefined): string | undefined {
  if (sensitive || v === null) return undefined;
  return sliceChars(String(v), 100);
}

/**
 * Evaluates the ENABLED assertions of `spec` (disabled ones are left out).
 * For every op but `exists`, a null value is skipped when the assertion is
 * optional and fails otherwise; matches / notMatches read the probe's RE2
 * verdict and apply the same rule when it is missing.
 */
export function evaluateAssertions(
  spec: Pick<DeviceCheckSpec, 'assertions' | 'fields'>,
  values: Record<string, DeviceCheckValue>,
  regex: Record<string, boolean | null | undefined> | null | undefined,
  changedAt: Record<string, string> | null | undefined,
  now: Date,
): DeviceCheckAssertionResult[] {
  const results: DeviceCheckAssertionResult[] = [];
  const fields = new Map(spec.fields.map((f) => [f.key, f]));
  const verdicts = regex ?? {};
  const changed = changedAt ?? {};

  for (const a of spec.assertions) {
    if (!a.enabled) continue;
    const field = fields.get(a.field);
    const v: DeviceCheckValue = Object.prototype.hasOwnProperty.call(values, a.field) ? values[a.field] ?? null : null;
    const base = { id: a.id, label: a.label };
    const actual = actualOf(v, field?.sensitive);
    const nullOutcome = (): DeviceCheckAssertionResult =>
      a.optional ? { ...base, pass: true, skipped: true } : { ...base, pass: false, skipped: false };
    const done = (pass: boolean): DeviceCheckAssertionResult =>
      ({ ...base, pass, skipped: false, ...(actual !== undefined ? { actual } : {}) });

    if (a.op === 'exists') {
      results.push(done(v !== null));
      continue;
    }
    if (v === null) {
      results.push(nullOutcome());
      continue;
    }

    switch (a.op) {
      case 'notEmpty':
        results.push(done(String(v).trim() !== ''));
        break;
      case 'equals':
        results.push(done(valuesEqual(v, a.value)));
        break;
      case 'notEquals':
        results.push(done(!valuesEqual(v, a.value)));
        break;
      case 'in':
      case 'notIn': {
        const list = Array.isArray(a.value) ? a.value : [];
        const member = list.some((e) => valuesEqual(v, e));
        results.push(done(a.op === 'in' ? member : !member));
        break;
      }
      case 'contains':
      case 'notContains': {
        const needle = scalarToString(a.value);
        const has = needle !== null && String(v).toLowerCase().includes(needle.toLowerCase());
        results.push(done(needle !== null && (a.op === 'contains' ? has : !has)));
        break;
      }
      case 'matches':
      case 'notMatches': {
        const r = Object.prototype.hasOwnProperty.call(verdicts, a.id) ? verdicts[a.id] : undefined;
        if (r === null || r === undefined) {
          results.push(nullOutcome());
          break;
        }
        results.push(done(a.op === 'matches' ? r === true : r === false));
        break;
      }
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const n = toFiniteNumber(v);
        const e = toFiniteNumber(a.value);
        if (n === null || e === null) {
          results.push(done(false));
          break;
        }
        const pass = a.op === 'gt' ? n > e : a.op === 'gte' ? n >= e : a.op === 'lt' ? n < e : n <= e;
        results.push(done(pass));
        break;
      }
      case 'changedWithin': {
        const ts = changed[a.field];
        const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
        const seconds = typeof a.seconds === 'number' ? a.seconds : 0;
        results.push(done(Number.isFinite(t) && now.getTime() - t <= seconds * 1000));
        break;
      }
      default:
        results.push(done(false));
    }
  }
  return results;
}

/**
 * Result status: `error` when the probe reported an error, otherwise `fail`
 * when an enabled, non-skipped assertion failed, otherwise `ok`.
 */
export function computeStatus(
  result: { status: 'ok' | 'error' },
  assertions: readonly DeviceCheckAssertionResult[] | null | undefined,
): 'ok' | 'fail' | 'error' {
  if (result.status === 'error') return 'error';
  if (assertions?.some((a) => !a.pass && !a.skipped)) return 'fail';
  return 'ok';
}

/** Labels of the failed (non-skipped) assertions. */
export function failedAssertionLabels(assertions: readonly DeviceCheckAssertionResult[] | null | undefined): string[] {
  return (assertions ?? []).filter((a) => !a.pass && !a.skipped).map((a) => a.label);
}

// ── Alert state machine ───────────────────────────────────────────────

/** The alerting columns of a device_check_state row. */
export interface AlertState {
  alert_state: DeviceCheckAlertState;
  alert_since: Date | null;
  last_notified_at: Date | null;
  consecutive_bad: number;
  consecutive_ok: number;
  bad_since: Date | null;
  ok_since: Date | null;
}

export type AlertInput =
  | { kind: 'result'; status: 'ok' | 'fail' | 'error'; errorCode?: ProbeCheckErrorCode | null }
  | { kind: 'tick' };

/**
 * Errors about where or whether the check may run at all (the executor probe
 * refused the target — outside the subnets it scans, no scan yet — or its
 * local policy refused the rule), not about the device: always skipped,
 * whatever treatErrorAs says, so a placement or configuration problem never
 * opens a "device check failing" alert on a healthy device.
 */
const PLACEMENT_ERROR_CODES: ReadonlySet<ProbeCheckErrorCode> = new Set<ProbeCheckErrorCode>(['target_not_allowed', 'policy_denied']);

export interface AlertContext {
  now: Date;
  /** The business-hours window is open (ignored when alerting.window is 'always'). */
  windowOpen: boolean;
  /** Start of the current open period (null: closed, or open "forever"). */
  openSince: Date | null;
  /** The device is offline in the IPAM (site_items.status). */
  itemOffline: boolean;
  /**
   * Sweeper ticks only: no result for max(3 × interval, 180 s) (isStale),
   * interval = the effective one (effectiveIntervalSeconds).
   * A stale check neither opens an alert nor sends "still failing"
   * reminders: nothing recent says it is failing.
   */
  stale?: boolean;
}

export type AlertCloseReason = 'recovered' | 'window_closed' | 'alerting_disabled' | 'rule_disabled' | 'checks_disabled';

export type AlertAction =
  /** Alert opened at `at`: live alert (alerting.liveAlert) + notification (alerting.notify). */
  | { type: 'open'; at: Date }
  /** Alert closed; `notify` → recovery live alert + notification. `alertSince` = the closed alert's start. */
  | { type: 'close'; reason: AlertCloseReason; notify: boolean; alertSince: Date | null }
  /** Still failing: notification reminder. */
  | { type: 'reminder'; alertSince: Date | null }
  /** A failing check is held back because the business-hours window is closed. */
  | { type: 'suppress' };

const STATES: ReadonlySet<string> = new Set(['ok', 'pending', 'alerting', 'suppressed']);

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}

function asCount(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Normalises the alerting columns of a database row. */
export function toAlertState(row: Record<string, unknown>): AlertState {
  const state = typeof row.alert_state === 'string' && STATES.has(row.alert_state) ? row.alert_state as DeviceCheckAlertState : 'ok';
  return {
    alert_state: state,
    alert_since: asDate(row.alert_since),
    last_notified_at: asDate(row.last_notified_at),
    consecutive_bad: asCount(row.consecutive_bad),
    consecutive_ok: asCount(row.consecutive_ok),
    bad_since: asDate(row.bad_since),
    ok_since: asDate(row.ok_since),
  };
}

/**
 * One step of the alert state machine.
 *
 * - A result counts as bad (fail, or error when treatErrorAs='fail'), good
 *   (ok) or is skipped (error with treatErrorAs='ignore', a placement error —
 *   PLACEMENT_ERROR_CODES —, device offline with skipWhenDeviceOffline, or a
 *   sweeper tick).
 * - Opening needs failAfterRuns bad results in a row AND failForSeconds since
 *   the first of them, inside the window and past the grace period after
 *   opening time. Recovery needs recoverAfterRuns / recoverForSeconds.
 * - Outside the business-hours window everything is `suppressed`; an open
 *   alert closes (silently or with a notification, onWindowClose).
 * - Alerting disabled: an open alert closes silently, the state stays `ok`.
 * - A sweeper tick on a stale check (ctx.stale) never opens an alert nor
 *   sends a reminder; neither does any step while the device is offline
 *   with skipWhenDeviceOffline (a pending row stays pending).
 */
export function stepAlert(
  prev: AlertState,
  input: AlertInput,
  al: DeviceCheckAlerting,
  ctx: AlertContext,
): { next: AlertState; actions: AlertAction[] } {
  const now = ctx.now;
  const t = now.getTime();
  const next: AlertState = { ...prev };
  const actions: AlertAction[] = [];

  let eff: 'ok' | 'bad' | 'skip';
  if (input.kind === 'tick') eff = 'skip';
  else if (input.status === 'ok') eff = 'ok';
  else if (input.status === 'fail') eff = 'bad';
  else if (input.errorCode && PLACEMENT_ERROR_CODES.has(input.errorCode)) eff = 'skip';
  else eff = al.treatErrorAs === 'fail' ? 'bad' : 'skip';
  const offlineSkip = ctx.itemOffline && al.skipWhenDeviceOffline;
  if (offlineSkip) eff = 'skip';
  const staleTick = input.kind === 'tick' && ctx.stale === true;

  if (eff === 'bad') {
    next.consecutive_bad = prev.consecutive_bad + 1;
    next.consecutive_ok = 0;
    next.ok_since = null;
    next.bad_since = prev.bad_since ?? now;
  } else if (eff === 'ok') {
    next.consecutive_ok = prev.consecutive_ok + 1;
    next.consecutive_bad = 0;
    next.bad_since = null;
    next.ok_since = prev.ok_since ?? now;
  }

  const close = (reason: AlertCloseReason, notify: boolean): void => {
    actions.push({ type: 'close', reason, notify, alertSince: prev.alert_since });
    next.alert_since = null;
  };

  if (!al.enabled) {
    if (prev.alert_state === 'alerting') close('alerting_disabled', false);
    next.alert_state = 'ok';
    return { next, actions };
  }

  const inWindow = al.window === 'always' || ctx.windowOpen;
  const inGrace = al.window === 'businessHours'
    && ctx.openSince !== null
    && t - ctx.openSince.getTime() < al.graceAfterOpenSeconds * 1000;

  if (!inWindow) {
    if (prev.alert_state === 'alerting') close('window_closed', al.onWindowClose === 'notify');
    if (prev.alert_state !== 'suppressed' && next.consecutive_bad > 0) actions.push({ type: 'suppress' });
    next.alert_state = 'suppressed';
    return { next, actions };
  }

  const badReady = next.consecutive_bad >= al.failAfterRuns
    && next.bad_since !== null
    && t - next.bad_since.getTime() >= al.failForSeconds * 1000;
  const goodReady = next.consecutive_ok >= al.recoverAfterRuns
    && next.ok_since !== null
    && t - next.ok_since.getTime() >= al.recoverForSeconds * 1000;

  if (prev.alert_state === 'alerting') {
    if (goodReady) {
      close('recovered', al.notifyRecovery);
      next.alert_state = 'ok';
    } else if (
      next.consecutive_bad > 0
      && !offlineSkip
      && !staleTick
      && al.renotifyEverySeconds > 0
      && (prev.last_notified_at === null || t - prev.last_notified_at.getTime() >= al.renotifyEverySeconds * 1000)
    ) {
      actions.push({ type: 'reminder', alertSince: prev.alert_since });
      next.last_notified_at = now;
    }
    return { next, actions };
  }

  // ok | pending | suppressed
  if (next.consecutive_bad > 0) {
    // Never opened while the device is offline and skipWhenDeviceOffline is
    // set (the row stays pending: the debounce met while it was online
    // opens once it is back and failing), nor on a stale tick.
    if (badReady && !inGrace && !staleTick && !offlineSkip) {
      next.alert_state = 'alerting';
      next.alert_since = now;
      next.last_notified_at = now;
      actions.push({ type: 'open', at: now });
    } else {
      next.alert_state = 'pending';
    }
  } else {
    next.alert_state = 'ok';
  }
  return { next, actions };
}

/**
 * Silent close outside the state machine, for a check that no longer runs
 * (rule disabled, suspended or with a stored spec that no longer validates;
 * Device Checks disabled on the site): an open alert closes without
 * notification and the row goes back to `ok` with its debounce counters
 * reset (the columns rule.service closeAlertsSilently writes).
 */
export function closeSilently(prev: AlertState, reason: AlertCloseReason): { next: AlertState; actions: AlertAction[] } {
  const actions: AlertAction[] = prev.alert_state === 'alerting'
    ? [{ type: 'close', reason, notify: false, alertSince: prev.alert_since }]
    : [];
  return {
    next: {
      ...prev,
      alert_state: 'ok',
      alert_since: null,
      consecutive_bad: 0,
      consecutive_ok: 0,
      bad_since: null,
      ok_since: null,
    },
    actions,
  };
}

/** True when the step changed anything worth persisting. */
export function alertStateChanged(a: AlertState, b: AlertState): boolean {
  const same = (x: Date | null, y: Date | null) => (x === null ? y === null : y !== null && x.getTime() === y.getTime());
  return a.alert_state !== b.alert_state
    || a.consecutive_bad !== b.consecutive_bad
    || a.consecutive_ok !== b.consecutive_ok
    || !same(a.alert_since, b.alert_since)
    || !same(a.last_notified_at, b.last_notified_at)
    || !same(a.bad_since, b.bad_since)
    || !same(a.ok_since, b.ok_since);
}

// ── Summaries (SiteItem.checks, socket payloads) ─────────────────────────────

// The platform policy minimum (DeviceChecksPolicy.minIntervalSeconds) last
// seen by the services that load the policy (ingest per batch, sweeper per
// tick: notePolicyMinIntervalSeconds). The one piece of state of this module
// — a number, no I/O: it lets callers that do not load the policy (site
// items, rule states) measure staleness against the interval the probe
// actually runs. Starts at the hard minimum.
let lastPolicyMinIntervalSeconds: number = DEVICE_CHECK_LIMITS.minIntervalSeconds;

/** Records the platform policy's minIntervalSeconds (see effectiveIntervalSeconds). */
export function notePolicyMinIntervalSeconds(seconds: number): void {
  if (Number.isFinite(seconds) && seconds > 0) lastPolicyMinIntervalSeconds = seconds;
}

/**
 * The interval a probe runs a rule at — what config.service buildWireRule
 * sends: the spec interval raised to the platform policy minimum and the hard
 * minimum, capped at the hard maximum. `policyMinIntervalSeconds` defaults to
 * the policy last noted (notePolicyMinIntervalSeconds).
 */
export function effectiveIntervalSeconds(
  specIntervalSeconds: number | undefined,
  policyMinIntervalSeconds: number = lastPolicyMinIntervalSeconds,
): number {
  const spec = typeof specIntervalSeconds === 'number' && Number.isFinite(specIntervalSeconds)
    ? specIntervalSeconds
    : DEVICE_CHECK_LIMITS.minIntervalSeconds;
  const policyMin = Number.isFinite(policyMinIntervalSeconds) ? policyMinIntervalSeconds : DEVICE_CHECK_LIMITS.minIntervalSeconds;
  return Math.min(
    DEVICE_CHECK_LIMITS.maxIntervalSeconds,
    Math.max(spec, policyMin, DEVICE_CHECK_LIMITS.minIntervalSeconds),
  );
}

/**
 * Staleness is computed on read: no result for max(3 × interval, 180 s).
 * `intervalSeconds` must be the effective interval (effectiveIntervalSeconds),
 * not the spec's: a policy minimum above it slows the probe down.
 */
export function isStale(lastCheckedAt: Date | null, intervalSeconds: number, now: Date): boolean {
  if (!lastCheckedAt) return false;
  const limitMs = Math.max(3 * intervalSeconds, 180) * 1000;
  return now.getTime() - lastCheckedAt.getTime() > limitMs;
}

function slotOf(spec: DeviceCheckSpec, key: string | undefined, values: Record<string, DeviceCheckValue>): DeviceCheckSlot | undefined {
  if (!key) return undefined;
  const field = spec.fields.find((f) => f.key === key);
  // Sensitive values never leave through summaries (socket, site list).
  if (!field || field.sensitive) return undefined;
  const value: DeviceCheckValue = Object.prototype.hasOwnProperty.call(values, key) ? values[key] ?? null : null;
  const tone = field.valueType === 'enum' && typeof value === 'string'
    ? field.enumValues?.find((ev) => ev.value === value)?.tone
    : undefined;
  return { label: field.label, value, ...(tone ? { tone } : {}) };
}

export interface SummaryInput {
  stateId: number;
  ruleId: number;
  ruleName: string;
  spec: DeviceCheckSpec;
  status: DeviceCheckStatus;
  alertState: DeviceCheckAlertState;
  values: Record<string, DeviceCheckValue>;
  lastCheckedAt: Date | null;
  lastErrorCode: string | null;
  /** Platform policy minimum interval; absent: the one last noted (effectiveIntervalSeconds). */
  policyMinIntervalSeconds?: number;
}

/**
 * DeviceCheckSummary of one state row (display slots, sensitive values left
 * out). Staleness and intervalSeconds use the effective interval.
 */
export function buildCheckSummary(s: SummaryInput, now: Date): DeviceCheckSummary {
  const interval = effectiveIntervalSeconds(s.spec.schedule?.intervalSeconds, s.policyMinIntervalSeconds);
  const display = s.spec.display ?? { icon: 'info' as const };
  const primary = slotOf(s.spec, display.primary, s.values);
  const secondary = slotOf(s.spec, display.secondary, s.values);
  const badge = slotOf(s.spec, display.badge, s.values);
  return {
    stateId: s.stateId,
    ruleId: s.ruleId,
    ruleName: s.ruleName,
    icon: display.icon,
    status: s.status,
    alertState: s.alertState,
    stale: isStale(s.lastCheckedAt, interval, now),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(badge ? { badge } : {}),
    lastCheckedAt: s.lastCheckedAt ? s.lastCheckedAt.toISOString() : null,
    lastErrorCode: s.lastErrorCode,
    intervalSeconds: interval,
  };
}

/** Display keys of a spec (a change of one of these values refreshes the UI). */
export function displayedKeys(spec: DeviceCheckSpec): string[] {
  const d = spec.display;
  return [d?.primary, d?.secondary, d?.badge].filter((k): k is string => typeof k === 'string');
}
