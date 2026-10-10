/**
 * DeviceChecksDrawer — the device detail slot of device checks.
 * Opened by a row chip or by a live-alert link (/sites/:id?device=<itemId>&check=<ruleId>).
 *
 * One card per rule applying to the device (GET /device-checks/sites/:siteId/states,
 * filtered on the item): display slots, the full values table with "changed
 * X ago", status and alert state with "since", variant, probe, last check.
 * Admins also get "Run now" and "Open rule". The body is DeviceChecksPanel, also
 * the Checks tab of the device page (/sites/:siteId/devices/:itemId). Sub-tabs: "Last run" (trace +
 * assertions) and "History" (EventsList, cursor-paged).
 *
 * Values come from third-party devices: rendered as React text only. In
 * anonymous mode sensitive fields are masked and addresses in traces / errors
 * hidden.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import {
  CheckCircle2, ExternalLink, History, ListChecks, Loader2, MinusCircle, Play, Radar, RefreshCw, X, XCircle,
} from 'lucide-react';
import type {
  DeviceCheckField,
  DeviceCheckSlot,
  DeviceCheckStateDetail,
  DeviceCheckValue,
  SiteItem,
} from '@oblimap/shared';
import { deviceChecksApi, deviceCheckErrorLabel, describeDeviceCheckError, parseDeviceCheckError } from '@/api/deviceChecks.api';
import { anonymize, useAnonymize } from '@/utils/anonymize';
import { cn } from '@/utils/cn';
import { isHandled } from '@/utils/apiError';
import {
  DEVICE_CHECK_STATUS_COLORS,
  DEVICE_CHECK_TONE_CLASSES,
  DeviceCheckIconGlyph,
  deviceCheckAlertStateLabel,
  deviceCheckStatusLabel,
  deviceCheckTimeAgo,
  formatDeviceCheckValue,
} from './DeviceCheckChip';
import { TraceView, maskDeviceAddresses } from './TraceView';
import { EventsList } from './EventsList';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Worst first: alerting, failing, error, stale, pending, ok. */
export function deviceCheckSeverityRank(c: { status: string; alertState: string; stale: boolean }): number {
  if (c.alertState === 'alerting') return 0;
  if (c.status === 'fail') return 1;
  if (c.status === 'error') return 2;
  if (c.stale) return 3;
  if (c.status === 'pending') return 4;
  return 5;
}

function absoluteTime(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

const STATUS_PILL: Record<string, string> = {
  ok: 'border-accent/40 bg-accent/10 text-accent',
  fail: 'border-red-500/40 bg-red-500/15 text-red-400',
  error: 'border-amber-500/40 bg-amber-500/15 text-amber-400',
  pending: 'border-zinc-500/40 bg-zinc-500/15 text-zinc-400',
};

const ALERT_PILL: Record<string, string> = {
  alerting: 'border-red-500/40 bg-red-500/15 text-red-400',
  pending: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  suppressed: 'border-zinc-500/40 bg-transparent text-zinc-400',
};

/** Display text of one field value (enum label + tone, sensitive masking in anonymous mode). */
function fieldValueView(
  field: DeviceCheckField | undefined,
  value: DeviceCheckValue | undefined,
  t: TFunction,
  isAnonymous: boolean,
): { text: string; tone?: string } {
  let text = formatDeviceCheckValue(value, t, 200);
  let tone: string | undefined;
  if (field?.valueType === 'enum' && typeof value === 'string') {
    const ev = field.enumValues?.find((e) => e.value === value);
    if (ev) {
      if (ev.label) text = formatDeviceCheckValue(ev.label, t, 200);
      tone = DEVICE_CHECK_TONE_CLASSES[ev.tone] ?? DEVICE_CHECK_TONE_CLASSES.neutral;
    }
  }
  if (field?.sensitive && isAnonymous && value !== null && value !== undefined) {
    text = anonymize(text, 'hostname');
  }
  return { text, tone };
}

// ─── Check card ───────────────────────────────────────────────────────────────

function SlotRow({ slot, t }: { slot: DeviceCheckSlot | undefined; t: TFunction }) {
  if (!slot) return null;
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-xs">
      <span className="shrink-0 text-text-muted">{formatDeviceCheckValue(slot.label, t, 60)}</span>
      {slot.tone ? (
        <span className={cn('min-w-0 truncate rounded-full border px-1.5 text-[11px] font-medium', DEVICE_CHECK_TONE_CLASSES[slot.tone] ?? DEVICE_CHECK_TONE_CLASSES.neutral)}>
          {formatDeviceCheckValue(slot.value, t, 60)}
        </span>
      ) : (
        <span className="min-w-0 break-words font-medium text-text-primary [overflow-wrap:anywhere]">
          {formatDeviceCheckValue(slot.value, t, 200)}
        </span>
      )}
    </div>
  );
}

interface CheckCardProps {
  state: DeviceCheckStateDetail;
  focused: boolean;
  isAdmin: boolean;
  canOpenProbes: boolean;
  probeName: string | null;
  eventsRefreshKey: number;
  onReloadSoon: () => void;
}

function CheckCard({ state, focused, isAdmin, canOpenProbes, probeName, eventsRefreshKey, onReloadSoon }: CheckCardProps) {
  const { t } = useTranslation();
  const { isAnonymous } = useAnonymize();
  const [tab, setTab] = useState<'lastRun' | 'history'>('lastRun');
  const [running, setRunning] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);

  const colors = DEVICE_CHECK_STATUS_COLORS[state.status] ?? DEVICE_CHECK_STATUS_COLORS.pending;
  const errorText = state.lastErrorCode ? (deviceCheckErrorLabel(state.lastErrorCode, t) ?? state.lastErrorCode) : null;
  const errorDetail = state.lastError
    ? (isAnonymous ? maskDeviceAddresses(formatDeviceCheckValue(state.lastError, t, 200)) : formatDeviceCheckValue(state.lastError, t, 200))
    : null;

  async function runNow() {
    setRunning(true);
    try {
      await deviceChecksApi.runNow(state.stateId);
      toast.success(t('deviceChecks.drawer.runNowSent', 'Check requested: the result arrives in a few seconds'));
      onReloadSoon();
    } catch (err) {
      if (!isHandled(err)) toast.error(describeDeviceCheckError(err, t, t('deviceChecks.drawer.runNowFailed', 'Could not run the check now')));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      ref={ref}
      className={cn(
        'rounded-xl bg-bg-secondary p-4 shadow-[var(--shadow-card)]',
        focused && 'ring-1 ring-accent/50',
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
          <DeviceCheckIconGlyph icon={state.icon} size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-sm font-semibold text-text-primary">{formatDeviceCheckValue(state.ruleName, t, 128)}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium', STATUS_PILL[state.status] ?? STATUS_PILL.pending)}>
              <span className={cn('inline-block h-1.5 w-1.5 rounded-full', colors.fill)} aria-hidden="true" />
              {deviceCheckStatusLabel(state.status, t)}
            </span>
            {state.stale && (
              <span className="rounded-full border border-zinc-500/40 px-2 py-0.5 text-zinc-400">
                {t('deviceChecks.status.stale', 'Stale (no recent result)')}
              </span>
            )}
            {state.alertState !== 'ok' && (
              <span
                className={cn('rounded-full border px-2 py-0.5', ALERT_PILL[state.alertState] ?? ALERT_PILL.pending)}
                title={absoluteTime(state.alertSince)}
              >
                {deviceCheckAlertStateLabel(state.alertState, t)}
                {state.alertSince && (
                  <span className="ml-1 opacity-80">
                    {t('deviceChecks.drawer.since', { ago: deviceCheckTimeAgo(state.alertSince, t), defaultValue: 'since {{ago}}' })}
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
        {isAdmin && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void runNow()}
              disabled={running}
              className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-accent disabled:opacity-50"
              title={t('deviceChecks.drawer.runNowHint', 'Ask the probe to run this check now')}
            >
              {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              {t('deviceChecks.drawer.runNow', 'Run now')}
            </button>
            <Link
              to={`/manage/device-checks/${state.ruleId}`}
              className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-accent"
            >
              <ExternalLink size={12} />
              {t('deviceChecks.drawer.openRule', 'Open rule')}
            </Link>
          </div>
        )}
      </div>

      {/* Display slots */}
      {(state.primary || state.secondary || state.badge) && (
        <div className="mt-3 space-y-1 rounded-lg bg-bg-tertiary/50 px-3 py-2">
          <SlotRow slot={state.primary} t={t} />
          <SlotRow slot={state.secondary} t={t} />
          <SlotRow slot={state.badge} t={t} />
        </div>
      )}

      {/* Error */}
      {(errorText || errorDetail) && state.status === 'error' && (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-400">
          {errorText && <p className="font-medium">{errorText}</p>}
          {errorDetail && errorDetail !== errorText && (
            <p className="break-words text-amber-400/80 [overflow-wrap:anywhere]">{errorDetail}</p>
          )}
        </div>
      )}

      {/* Values */}
      {state.fields.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">{t('deviceChecks.drawer.values', 'Values')}</p>
          <table className="w-full text-xs">
            <tbody>
              {state.fields.map((f) => {
                const view = fieldValueView(f, state.values[f.key], t, isAnonymous);
                const changedAt = state.valuesChangedAt[f.key];
                return (
                  <tr key={f.key} className="border-b border-border/60 last:border-0">
                    <td className="py-1 pr-2 align-top text-text-muted">{formatDeviceCheckValue(f.label || f.key, t, 60)}</td>
                    <td className="py-1 pr-2 align-top">
                      {view.tone ? (
                        <span className={cn('rounded-full border px-1.5 text-[11px] font-medium', view.tone)}>{view.text}</span>
                      ) : (
                        <span className="break-words font-mono text-text-primary [overflow-wrap:anywhere]">{view.text}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-1 text-right align-top text-[11px] text-text-muted" title={absoluteTime(changedAt)}>
                      {changedAt
                        ? t('deviceChecks.drawer.changed', { ago: deviceCheckTimeAgo(changedAt, t), defaultValue: 'changed {{ago}}' })
                        : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Meta */}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-text-muted">{t('deviceChecks.drawer.lastCheck', 'Last check')}</dt>
        <dd className="text-text-primary" title={absoluteTime(state.lastCheckedAt)}>{deviceCheckTimeAgo(state.lastCheckedAt, t)}</dd>
        <dt className="text-text-muted">{t('deviceChecks.drawer.interval', 'Interval')}</dt>
        <dd className="text-text-primary">
          {t('deviceChecks.drawer.everySeconds', { count: state.intervalSeconds, defaultValue: 'every {{count}} s' })}
        </dd>
        <dt className="text-text-muted">{t('deviceChecks.drawer.variant', 'Variant')}</dt>
        <dd className="break-all font-mono text-text-primary">{state.variantId ?? '—'}</dd>
        <dt className="text-text-muted">{t('deviceChecks.drawer.probe', 'Probe')}</dt>
        <dd className="min-w-0 text-text-primary">
          {state.probeId === null ? '—' : canOpenProbes ? (
            <Link to={`/manage/probes/${state.probeId}`} className="inline-flex items-center gap-1 text-accent hover:underline">
              <Radar size={11} />
              {probeName ? anonymize(probeName, 'hostname') : `#${state.probeId}`}
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Radar size={11} className="text-text-muted" />
              {probeName ? anonymize(probeName, 'hostname') : `#${state.probeId}`}
            </span>
          )}
        </dd>
      </dl>

      {/* Tabs */}
      <div className="mt-3 flex items-center gap-1 border-b border-border">
        {([
          { id: 'lastRun' as const, label: t('deviceChecks.drawer.tabLastRun', 'Last run'), Icon: ListChecks },
          { id: 'history' as const, label: t('deviceChecks.drawer.tabHistory', 'History'), Icon: History },
        ]).map((tb) => (
          <button
            key={tb.id}
            type="button"
            onClick={() => setTab(tb.id)}
            className={cn(
              '-mb-px inline-flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs font-medium transition-colors',
              tab === tb.id ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-primary',
            )}
          >
            <tb.Icon size={12} />{tb.label}
          </button>
        ))}
      </div>

      <div className="pt-3">
        {tab === 'lastRun' ? (
          <div className="space-y-3">
            <TraceView steps={state.lastTrace} />
            {state.assertions && state.assertions.length > 0 && (
              <div>
                <p className="mb-1.5 text-[11px] uppercase tracking-wide text-text-muted">{t('deviceChecks.drawer.assertions', 'Checks')}</p>
                <ul className="space-y-1 text-xs">
                  {state.assertions.map((a) => {
                    const actual = a.actual !== undefined ? formatDeviceCheckValue(a.actual, t, 200) : null;
                    return (
                      <li key={a.id} className="flex items-start gap-1.5">
                        {a.skipped
                          ? <MinusCircle size={13} className="mt-0.5 shrink-0 text-zinc-400" />
                          : a.pass
                            ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-accent" />
                            : <XCircle size={13} className="mt-0.5 shrink-0 text-red-400" />}
                        <span className="min-w-0">
                          <span className="text-text-primary">{formatDeviceCheckValue(a.label || a.id, t, 100)}</span>
                          {a.skipped && <span className="ml-1 text-text-muted">({t('deviceChecks.drawer.skipped', 'skipped')})</span>}
                          {actual !== null && (
                            <span className="block break-words font-mono text-text-muted [overflow-wrap:anywhere]">
                              {isAnonymous ? maskDeviceAddresses(actual) : actual}
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <EventsList key={state.stateId} stateId={state.stateId} fields={state.fields} refreshKey={eventsRefreshKey} />
        )}
      </div>
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

/** What the cards need of a probe: its id and a name (display name, else hostname). */
export type DeviceChecksProbeRef = { id: number; name?: string | null; hostname?: string | null };

export interface DeviceChecksPanelProps {
  siteId: number;
  itemId: number;
  /** Rule to highlight (live-alert link). */
  focusRuleId?: number | null;
  /** Probe names (any site reader may get them through GET /sites/:id/probes). */
  probes?: ReadonlyArray<DeviceChecksProbeRef>;
  /** 'deviceChecks.manage': "Run now" and the rule link. */
  isAdmin: boolean;
  /** 'probes.manage': the probe link to /manage/probes/:id (defaults to isAdmin). */
  canOpenProbes?: boolean;
  /** Changing it reloads the states silently (DEVICE_CHECK_UPDATED / _ALERT, a refresh button). */
  refreshKey?: number;
  /** Changing it reloads the histories (DEVICE_CHECK_ALERT). */
  eventsRefreshKey?: number;
  /** Told when a (re)load starts and ends (refresh button spinner). */
  onReloadingChange?: (reloading: boolean) => void;
}

type LoadError = 'forbidden' | 'notFound' | 'error';

/**
 * The device checks of one device (one card per rule applying to it, worst
 * first) — the body of DeviceChecksDrawer, also the Checks tab of the
 * device page.
 */
export function DeviceChecksPanel({
  siteId,
  itemId,
  focusRuleId = null,
  probes,
  isAdmin,
  canOpenProbes,
  refreshKey = 0,
  eventsRefreshKey = 0,
  onReloadingChange,
}: DeviceChecksPanelProps) {
  const { t } = useTranslation();
  const [states, setStates] = useState<DeviceCheckStateDetail[] | null>(null);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const seq = useRef(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadingRef = useRef(onReloadingChange);
  reloadingRef.current = onReloadingChange;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    reloadingRef.current?.(true);
    try {
      const all = await deviceChecksApi.siteStates(siteId);
      if (mine !== seq.current) return;
      const mineStates = all
        .filter((s) => s.siteItemId === itemId)
        .sort((a, b) => deviceCheckSeverityRank(a) - deviceCheckSeverityRank(b)
          || a.ruleName.localeCompare(b.ruleName));
      setStates(mineStates);
      setLoadError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      const status = parseDeviceCheckError(err).status;
      setLoadError(status === 403 ? 'forbidden' : status === 404 ? 'notFound' : 'error');
    } finally {
      if (mine === seq.current) reloadingRef.current?.(false);
    }
  }, [siteId, itemId]);

  useEffect(() => {
    setStates(null);
    setLoadError(null);
  }, [siteId, itemId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  useEffect(() => () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    // A pending load is dropped: its spinner must not stay on.
    seq.current += 1;
  }, []);

  // After "Run now": the new result may not change anything displayed (no
  // socket event), so reload once it had time to arrive.
  const reloadSoon = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => void load(), 8000);
  }, [load]);

  const probeNames = useMemo(
    () => new Map((probes ?? []).map((p) => [p.id, p.name || p.hostname || null])),
    [probes],
  );
  const focusMissing = focusRuleId !== null && states !== null && !states.some((s) => s.ruleId === focusRuleId);

  if (loadError && states === null) {
    return (
      <p className="rounded-xl bg-bg-secondary p-4 text-center text-sm text-text-muted shadow-[var(--shadow-card)]">
        {loadError === 'forbidden'
          ? t('deviceChecks.drawer.forbidden', 'You do not have access to the checks of this site.')
          : loadError === 'notFound'
            ? t('deviceChecks.drawer.notFound', 'This site no longer exists.')
            : t('deviceChecks.drawer.failedLoad', 'Could not load the device checks.')}
      </p>
    );
  }
  if (states === null) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 size={22} className="animate-spin text-accent" />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {loadError && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-400">
          {t('deviceChecks.drawer.failedRefresh', 'Refresh failed: the values shown may be out of date.')}
        </p>
      )}
      {focusMissing && (
        <p className="rounded-md bg-bg-secondary px-2.5 py-1.5 text-xs text-text-muted">
          {t('deviceChecks.drawer.focusMissing', 'The check of this alert no longer applies to this device (rule disabled, deleted or no longer matching).')}
        </p>
      )}
      {states.length === 0 ? (
        <p className="rounded-xl bg-bg-secondary p-4 text-center text-sm text-text-muted shadow-[var(--shadow-card)]">
          {t('deviceChecks.drawer.empty', 'No device check runs on this device.')}
        </p>
      ) : (
        states.map((s) => (
          <CheckCard
            key={s.stateId}
            state={s}
            focused={focusRuleId !== null && s.ruleId === focusRuleId}
            isAdmin={isAdmin}
            canOpenProbes={canOpenProbes ?? isAdmin}
            probeName={s.probeId !== null ? probeNames.get(s.probeId) ?? null : null}
            eventsRefreshKey={eventsRefreshKey}
            onReloadSoon={reloadSoon}
          />
        ))
      )}
    </div>
  );
}

// ─── Drawer ───────────────────────────────────────────────────────────────────

export interface DeviceChecksDrawerProps {
  siteId: number;
  itemId: number;
  /** The device, when it is in the loaded items (header). */
  item: SiteItem | null;
  /** Rule to highlight (live-alert link). */
  focusRuleId?: number | null;
  /** Probe names. */
  probes?: ReadonlyArray<DeviceChecksProbeRef>;
  isAdmin: boolean;
  /** Changing it reloads the states silently (DEVICE_CHECK_UPDATED / _ALERT). */
  refreshKey?: number;
  /** Changing it reloads the histories (DEVICE_CHECK_ALERT). */
  eventsRefreshKey?: number;
  onClose: () => void;
}

export function DeviceChecksDrawer({
  siteId,
  itemId,
  item,
  focusRuleId = null,
  probes,
  isAdmin,
  refreshKey = 0,
  eventsRefreshKey = 0,
  onClose,
}: DeviceChecksDrawerProps) {
  const { t } = useTranslation();
  const [reloading, setReloading] = useState(false);
  // Bumped by the refresh button (added to the caller's key: both only grow).
  const [manualRefresh, setManualRefresh] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { anonymize: anon } = useAnonymize();
  const displayName = item ? (item.customName ?? item.hostname) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="dc-drawer-title"
        className="flex h-full w-full max-w-xl flex-col border-l border-border bg-bg-primary shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <h2 id="dc-drawer-title" className="text-base font-semibold text-text-primary">
              {t('deviceChecks.drawer.title', 'Device checks')}
            </h2>
            <p className="truncate text-xs text-text-muted">
              {displayName ? `${anon(displayName, 'hostname')} · ` : ''}
              {item ? <span className="font-mono">{anon(item.ip, 'ip')}</span> : t('deviceChecks.drawer.deviceId', { id: itemId, defaultValue: 'Device #{{id}}' })}
              {item?.mac && <span className="font-mono"> · {anon(item.mac, 'mac')}</span>}
            </p>
            <Link
              to={`/sites/${siteId}/devices/${itemId}?tab=checks${focusRuleId !== null ? `&check=${focusRuleId}` : ''}`}
              className="mt-0.5 inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <ExternalLink size={11} />
              {t('deviceChecks.drawer.openDevice', 'Open the device page')}
            </Link>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setManualRefresh((k) => k + 1)}
              disabled={reloading}
              className="rounded p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
              title={t('common.refresh', 'Refresh')}
              aria-label={t('common.refresh', 'Refresh')}
            >
              <RefreshCw size={15} className={reloading ? 'animate-spin' : undefined} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary"
              aria-label={t('common.close', 'Close')}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <DeviceChecksPanel
            siteId={siteId}
            itemId={itemId}
            focusRuleId={focusRuleId}
            probes={probes}
            isAdmin={isAdmin}
            refreshKey={refreshKey + manualRefresh}
            eventsRefreshKey={eventsRefreshKey}
            onReloadingChange={setReloading}
          />
        </div>
      </aside>
    </div>
  );
}
