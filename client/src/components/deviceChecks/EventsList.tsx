/**
 * EventsList — history of one (rule, device) check (drawer
 * "History" tab): status changes, historized value changes, alert opened /
 * closed / reminders, failed notifications. Newest first, cursor-paged through
 * GET /device-checks/states/:stateId/events.
 *
 * Event details carry device-supplied text: rendered as text only; in
 * anonymous mode sensitive values are masked and IP / MAC addresses hidden
 * (plus host names in notification delivery errors).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertTriangle, BellOff, BellRing, CheckCircle2, History, Loader2, MailWarning, PencilLine, RefreshCw, ShieldOff,
} from 'lucide-react';
import type { DeviceCheckEvent, DeviceCheckField, DeviceCheckStatus, DeviceCheckValue } from '@oblimap/shared';
import { deviceChecksApi, deviceCheckErrorLabel, describeDeviceCheckError } from '@/api/deviceChecks.api';
import { anonymize, useAnonymize } from '@/utils/anonymize';
import { cn } from '@/utils/cn';
import { deviceCheckStatusLabel, deviceCheckTimeAgo, formatDeviceCheckValue } from './DeviceCheckChip';
import { maskDeviceAddresses } from './TraceView';

const DEFAULT_PAGE_SIZE = 25;
const STATUSES: ReadonlySet<string> = new Set(['pending', 'ok', 'fail', 'error']);

const CLOSE_REASON_FALLBACKS: Record<string, string> = {
  recovered: 'The check recovered',
  window_closed: 'Business hours ended',
  alerting_disabled: 'Alerting was disabled on the rule',
  rule_disabled: 'The rule was disabled',
  checks_disabled: 'Device checks were disabled for this site',
};

// Dotted DNS names with an alphabetic TLD (IPv4 addresses do not match).
const HOST_NAME_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;

/** Masks host names in free text (use only in anonymous mode). */
function maskHostNames(text: string): string {
  return text.replace(HOST_NAME_RE, (host) => anonymize(host, 'hostname'));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function statusText(s: string | null, t: TFunction): string {
  if (!s) return '—';
  return STATUSES.has(s) ? deviceCheckStatusLabel(s as DeviceCheckStatus, t) : s;
}

interface EventView {
  Icon: typeof History;
  tone: string;
  title: string;
  detail: string | null;
}

function describeEvent(
  e: DeviceCheckEvent,
  fields: Map<string, DeviceCheckField>,
  t: TFunction,
  isAnonymous: boolean,
): EventView {
  const d = isRecord(e.details) ? e.details : {};
  const safe = (s: string) => (isAnonymous ? maskDeviceAddresses(s) : s);
  const errorCode = typeof d.errorCode === 'string' ? d.errorCode : null;
  const errorText = errorCode ? (deviceCheckErrorLabel(errorCode, t) ?? errorCode) : null;

  switch (e.kind) {
    case 'status_changed': {
      const bad = e.toStatus === 'fail' || e.toStatus === 'error';
      return {
        Icon: bad ? AlertTriangle : CheckCircle2,
        tone: e.toStatus === 'fail' ? 'text-red-400' : e.toStatus === 'error' ? 'text-amber-400' : e.toStatus === 'ok' ? 'text-accent' : 'text-text-muted',
        title: t('deviceChecks.events.statusChanged', {
          from: statusText(e.fromStatus, t),
          to: statusText(e.toStatus, t),
          defaultValue: 'Status {{from}} → {{to}}',
        }),
        detail: errorText,
      };
    }
    case 'value_changed': {
      const key = typeof d.field === 'string' ? d.field : '';
      const field = fields.get(key);
      const label = field?.label || key || '?';
      const v = d.value;
      const raw: DeviceCheckValue = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
      let value: string;
      if (v === '[sensitive]') value = t('deviceChecks.events.sensitiveValue', '(sensitive value, not kept)');
      else if (field?.sensitive && isAnonymous && raw !== null) value = anonymize(formatDeviceCheckValue(raw, t, 200), 'hostname');
      else value = formatDeviceCheckValue(raw, t, 200);
      return {
        Icon: PencilLine,
        tone: 'text-text-secondary',
        title: t('deviceChecks.events.valueChanged', { field: formatDeviceCheckValue(label, t, 60), defaultValue: '{{field}} changed' }),
        detail: safe(value),
      };
    }
    case 'alert_opened': {
      const failed = Array.isArray(d.failed)
        ? d.failed.filter((l): l is string => typeof l === 'string' && l !== '').map((l) => formatDeviceCheckValue(l, t, 100))
        : [];
      const parts = [failed.join(', '), errorText].filter((p): p is string => !!p);
      return {
        Icon: BellRing,
        tone: 'text-red-400',
        title: t('deviceChecks.events.alertOpened', 'Alert opened'),
        detail: parts.length > 0 ? safe(parts.join(' · ')) : null,
      };
    }
    case 'alert_closed': {
      const reason = typeof d.reason === 'string' ? d.reason : '';
      const reasonText = reason
        ? t(`deviceChecks.events.closeReason.${reason}`, CLOSE_REASON_FALLBACKS[reason] ?? reason)
        : null;
      const notified = d.notify === true;
      return {
        Icon: CheckCircle2,
        tone: 'text-accent',
        title: t('deviceChecks.events.alertClosed', 'Alert closed'),
        detail: [reasonText, notified ? t('deviceChecks.events.recoveryNotified', 'recovery notified') : null]
          .filter((p): p is string => !!p).join(' · ') || null,
      };
    }
    case 'alert_reminder':
      return {
        Icon: BellRing,
        tone: 'text-amber-400',
        title: t('deviceChecks.events.alertReminder', 'Still failing: reminder sent'),
        detail: null,
      };
    case 'alert_suppressed':
      return {
        Icon: BellOff,
        tone: 'text-text-muted',
        title: t('deviceChecks.events.alertSuppressed', 'Failure held back (outside business hours)'),
        detail: null,
      };
    case 'notify_failed': {
      const channelId = typeof d.channelId === 'number' ? d.channelId : null;
      // A plugin's delivery error can name the webhook / SMTP host or its IP.
      const err = typeof d.error === 'string'
        ? formatDeviceCheckValue(isAnonymous ? maskHostNames(safe(d.error)) : d.error, t, 100)
        : null;
      return {
        Icon: MailWarning,
        tone: 'text-amber-400',
        title: t('deviceChecks.events.notifyFailed', 'Notification not delivered'),
        detail: [
          channelId !== null ? t('deviceChecks.events.channel', { id: channelId, defaultValue: 'Channel #{{id}}' }) : null,
          err,
        ].filter((p): p is string => !!p).join(': ') || null,
      };
    }
    case 'rule_suspended':
      return {
        Icon: ShieldOff,
        tone: 'text-amber-400',
        title: t('deviceChecks.events.ruleSuspended', 'Rule suspended'),
        detail: typeof d.reason === 'string' ? formatDeviceCheckValue(d.reason, t, 200) : null,
      };
    default:
      return {
        Icon: History,
        tone: 'text-text-muted',
        title: t(`deviceChecks.events.kind.${e.kind}`, e.kind),
        detail: null,
      };
  }
}

export interface EventsListProps {
  stateId: number;
  /** Fields of the rule (labels, sensitive flag). */
  fields?: DeviceCheckField[];
  /** Changing it reloads the first page (e.g. on DEVICE_CHECK_ALERT). */
  refreshKey?: number;
  pageSize?: number;
  className?: string;
}

export function EventsList({ stateId, fields, refreshKey = 0, pageSize = DEFAULT_PAGE_SIZE, className }: EventsListProps) {
  const { t } = useTranslation();
  const { isAnonymous } = useAnonymize();
  const [events, setEvents] = useState<DeviceCheckEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Responses of a previous state / refresh are ignored.
  const seq = useRef(0);

  const loadFirst = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    try {
      const page = await deviceChecksApi.events(stateId, { limit: pageSize });
      if (mine !== seq.current) return;
      setEvents(page.events);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (mine !== seq.current) return;
      setEvents([]);
      setNextCursor(null);
      setError(describeDeviceCheckError(err, t, t('deviceChecks.events.failedLoad', 'Could not load the history')));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [stateId, pageSize, t]);

  useEffect(() => { void loadFirst(); }, [loadFirst, refreshKey]);

  async function loadMore() {
    if (nextCursor === null || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const page = await deviceChecksApi.events(stateId, { before: nextCursor, limit: pageSize });
      if (mine !== seq.current) return;
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...page.events.filter((e) => !seen.has(e.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(describeDeviceCheckError(err, t, t('deviceChecks.events.failedLoad', 'Could not load the history')));
    } finally {
      if (mine === seq.current) setLoadingMore(false);
    }
  }

  // A refresh keeps the current list on screen (no flicker); only the first load shows a spinner.
  if (loading && events.length === 0) {
    return (
      <div className={cn('flex items-center justify-center py-6', className)}>
        <Loader2 size={18} className="animate-spin text-accent" />
      </div>
    );
  }

  const fieldMap = new Map((fields ?? []).map((f) => [f.key, f]));

  return (
    <div className={cn('space-y-2', className)}>
      {error && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-400">
          <span className="min-w-0 break-words">{error}</span>
          <button
            type="button"
            onClick={() => void loadFirst()}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-red-500/10"
          >
            <RefreshCw size={11} />{t('common.retry', 'Retry')}
          </button>
        </div>
      )}
      {events.length === 0 && !error ? (
        <p className="py-3 text-center text-xs text-text-muted">
          {t('deviceChecks.events.empty', 'No event recorded for this check yet.')}
        </p>
      ) : (
        <ol className="space-y-1.5">
          {events.map((e) => {
            const view = describeEvent(e, fieldMap, t, isAnonymous);
            const when = new Date(e.createdAt);
            return (
              <li key={e.id} className="flex items-start gap-2 rounded-md bg-bg-tertiary/50 px-2.5 py-1.5 text-xs">
                <view.Icon size={13} className={cn('mt-0.5 shrink-0', view.tone)} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="font-medium text-text-primary">{view.title}</span>
                    <span
                      className="shrink-0 text-[11px] text-text-muted"
                      title={Number.isFinite(when.getTime()) ? when.toLocaleString() : e.createdAt}
                    >
                      {deviceCheckTimeAgo(e.createdAt, t)}
                    </span>
                  </div>
                  {view.detail && (
                    <p className="mt-0.5 break-words text-text-secondary [overflow-wrap:anywhere]">{view.detail}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {nextCursor !== null && (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="inline-flex items-center gap-1.5 rounded-md bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-accent disabled:opacity-50"
          >
            {loadingMore ? <Loader2 size={12} className="animate-spin" /> : <History size={12} />}
            {t('deviceChecks.events.loadMore', 'Load older events')}
          </button>
        </div>
      )}
    </div>
  );
}
