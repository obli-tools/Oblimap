/**
 * DeviceCheckChip — the fixed row slot of one device check:
 * status dot, rule icon, primary value (40 chars max) and a badge pill with
 * its tone color. The tooltip lists every slot, the rule name and the time of
 * the last check.
 *
 * Values come from third-party devices (titles, firmware strings…): they are
 * rendered as React text only, never as HTML, and icons come from a fixed map.
 */

import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Music, Radio, Volume2, Activity, Printer, Info, type LucideIcon } from 'lucide-react';
import type {
  DeviceCheckAlertState,
  DeviceCheckIcon,
  DeviceCheckSlot,
  DeviceCheckStatus,
  DeviceCheckSummary,
  DeviceCheckTone,
  DeviceCheckValue,
} from '@oblimap/shared';
import { deviceCheckErrorLabel } from '@/api/deviceChecks.api';
import { cn } from '@/utils/cn';

// ─── Shared maps (also used by the editor and the device drawer) ──────────────

/** The only icons a rule can show (DeviceCheckIcon allowlist). */
export const DEVICE_CHECK_ICON_COMPONENTS: Record<DeviceCheckIcon, LucideIcon> = {
  music: Music,
  radio: Radio,
  volume: Volume2,
  activity: Activity,
  printer: Printer,
  info: Info,
};

export function DeviceCheckIconGlyph({ icon, size = 12, className }: { icon: DeviceCheckIcon; size?: number; className?: string }) {
  const Icon = DEVICE_CHECK_ICON_COMPONENTS[icon] ?? Info;
  return <Icon size={size} className={className} aria-hidden="true" />;
}

/** Pill classes per tone: ok = accent green (#8dc63f), warn = amber, bad = red, neutral = gray. */
export const DEVICE_CHECK_TONE_CLASSES: Record<DeviceCheckTone, string> = {
  ok: 'border-accent/40 bg-accent/15 text-accent',
  warn: 'border-amber-500/40 bg-amber-500/15 text-amber-400',
  bad: 'border-red-500/40 bg-red-500/15 text-red-400',
  neutral: 'border-zinc-500/40 bg-zinc-500/15 text-zinc-400',
};

/** Dot colors per status (filled; hollow when the alert is suppressed, grey when stale). */
export const DEVICE_CHECK_STATUS_COLORS: Record<DeviceCheckStatus, { fill: string; ring: string }> = {
  ok: { fill: 'bg-accent', ring: 'border-accent' },
  fail: { fill: 'bg-red-500', ring: 'border-red-500' },
  error: { fill: 'bg-amber-500', ring: 'border-amber-500' },
  pending: { fill: 'bg-zinc-400', ring: 'border-zinc-400' },
};

export const DEVICE_CHECK_STATUS_FALLBACKS: Record<DeviceCheckStatus, string> = {
  pending: 'Pending',
  ok: 'OK',
  fail: 'Failing',
  error: 'Error',
};

export function deviceCheckStatusLabel(status: DeviceCheckStatus, t: TFunction): string {
  return t(`deviceChecks.status.${status}`, DEVICE_CHECK_STATUS_FALLBACKS[status] ?? status);
}

export const DEVICE_CHECK_ALERT_STATE_FALLBACKS: Record<DeviceCheckAlertState, string> = {
  ok: 'No alert',
  pending: 'Alert pending (debounce)',
  alerting: 'Alerting',
  suppressed: 'Outside business hours (suppressed)',
};

export function deviceCheckAlertStateLabel(state: DeviceCheckAlertState, t: TFunction): string {
  return t(`deviceChecks.alertState.${state}`, DEVICE_CHECK_ALERT_STATE_FALLBACKS[state] ?? state);
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Display text of a check value: control characters removed, '—' when empty, truncated to `max`. */
export function formatDeviceCheckValue(value: DeviceCheckValue | undefined, t: TFunction, max?: number): string {
  if (value === null || value === undefined) return '—';
  let s = typeof value === 'boolean'
    ? (value ? t('deviceChecks.value.true', 'Yes') : t('deviceChecks.value.false', 'No'))
    : String(value);
  s = s.replace(CONTROL_CHARS, ' ').trim();
  if (s === '') return '—';
  if (max && s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/** "23 s ago", "12 min ago"… ; 'never' for null. */
export function deviceCheckTimeAgo(iso: string | null | undefined, t: TFunction): string {
  if (!iso) return t('deviceChecks.time.never', 'never');
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('deviceChecks.time.secondsAgo', { count: s, defaultValue: '{{count}} s ago' });
  const m = Math.round(s / 60);
  if (m < 60) return t('deviceChecks.time.minutesAgo', { count: m, defaultValue: '{{count}} min ago' });
  const h = Math.round(m / 60);
  if (h < 48) return t('deviceChecks.time.hoursAgo', { count: h, defaultValue: '{{count}} h ago' });
  return t('deviceChecks.time.daysAgo', { count: Math.round(h / 24), defaultValue: '{{count}} d ago' });
}

// ─── Chip ─────────────────────────────────────────────────────────────────────

export interface DeviceCheckChipProps {
  summary: DeviceCheckSummary;
  onClick?: () => void;
  className?: string;
}

const PRIMARY_MAX = 40;
const BADGE_MAX = 24;

function slotLine(slot: DeviceCheckSlot | undefined, t: TFunction): string | null {
  if (!slot) return null;
  return `${formatDeviceCheckValue(slot.label, t, 60)}: ${formatDeviceCheckValue(slot.value, t, 200)}`;
}

export function DeviceCheckChip({ summary, onClick, className }: DeviceCheckChipProps) {
  const { t } = useTranslation();
  const colors = DEVICE_CHECK_STATUS_COLORS[summary.status] ?? DEVICE_CHECK_STATUS_COLORS.pending;
  const suppressed = summary.alertState === 'suppressed';
  const statusText = deviceCheckStatusLabel(summary.status, t);

  const primaryText = summary.primary
    ? formatDeviceCheckValue(summary.primary.value, t, PRIMARY_MAX)
    : statusText;
  const badge = summary.badge;

  const tooltip = [
    formatDeviceCheckValue(summary.ruleName, t, 128),
    summary.stale
      ? `${statusText} · ${t('deviceChecks.status.stale', 'Stale (no recent result)')}`
      : statusText,
    summary.alertState !== 'ok' ? deviceCheckAlertStateLabel(summary.alertState, t) : null,
    summary.status === 'error' ? deviceCheckErrorLabel(summary.lastErrorCode, t) ?? summary.lastErrorCode : null,
    slotLine(summary.primary, t),
    slotLine(summary.secondary, t),
    slotLine(summary.badge, t),
    t('deviceChecks.chip.checked', { ago: deviceCheckTimeAgo(summary.lastCheckedAt, t), defaultValue: 'Checked {{ago}}' }),
  ].filter((l): l is string => !!l).join('\n');

  const content = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          'inline-block h-2 w-2 shrink-0 rounded-full border',
          summary.stale
            ? (suppressed ? 'border-zinc-500 bg-transparent' : 'border-zinc-500 bg-zinc-500')
            : (suppressed ? cn(colors.ring, 'bg-transparent') : cn(colors.ring, colors.fill)),
        )}
      />
      <DeviceCheckIconGlyph icon={summary.icon} size={11} className="shrink-0 text-text-muted" />
      <span className="min-w-0 truncate">{primaryText}</span>
      {badge && (
        <span
          className={cn(
            'shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4',
            DEVICE_CHECK_TONE_CLASSES[badge.tone ?? 'neutral'] ?? DEVICE_CHECK_TONE_CLASSES.neutral,
          )}
        >
          {formatDeviceCheckValue(badge.value, t, BADGE_MAX)}
        </span>
      )}
    </>
  );

  const base = cn(
    'inline-flex max-w-full items-center gap-1.5 rounded-md bg-bg-tertiary px-1.5 py-0.5 text-[11px] text-text-secondary',
    summary.stale && 'opacity-60',
    className,
  );

  if (!onClick) {
    return <span className={base} title={tooltip} aria-label={tooltip}>{content}</span>;
  }
  return (
    <button
      type="button"
      title={tooltip}
      aria-label={tooltip}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(base, 'transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent')}
    >
      {content}
    </button>
  );
}
