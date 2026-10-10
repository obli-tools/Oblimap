import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, ArrowUpCircle, Loader2 } from 'lucide-react';
import { SOCKET_EVENTS } from '@oblimap/shared';
import type { Probe } from '@oblimap/shared';
import { cn } from '@/utils/cn';
import { formatRelative } from '@/utils/formatRelative';
import { getSocket } from '@/socket/socketClient';
import { useSocketStore } from '@/store/socketStore';
import { useTenantEpoch } from '@/store/tenantStore';

/**
 * Probe status presentation (ported from Obliance's DeviceStatusBadge):
 * connectivity comes from the server's own verdict (`probe.online` /
 * `offlineSince`, the probe-offline job's threshold), never from a browser
 * heuristic on lastSeenAt.
 */

/** The server deletes an uninstalled probe 10 minutes after the command. */
export const UNINSTALL_GRACE_MS = 10 * 60 * 1000;

const PILL = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium';

const APPROVAL_CLS: Record<Probe['status'], { cls: string; dot: string }> = {
  pending:   { cls: 'bg-yellow-500/15 text-yellow-400', dot: 'bg-yellow-400' },
  approved:  { cls: 'bg-emerald-500/15 text-emerald-400', dot: 'bg-emerald-400' },
  refused:   { cls: 'bg-red-500/15 text-red-400', dot: 'bg-red-400' },
  suspended: { cls: 'bg-zinc-500/15 text-zinc-400', dot: 'bg-zinc-400' },
};

/** Ticking clock (ms), re-rendering every `intervalMs` while `active`. */
function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}

/** "mm:ss" of a duration (clamped at 0). */
export function formatMmSs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Milliseconds left before the server deletes a probe whose uninstall was
 * commanded (ticks every second), or null when no uninstall is pending.
 */
export function useUninstallRemaining(uninstallCommandedAt: string | null | undefined): number | null {
  const commandedAt = uninstallCommandedAt ? Date.parse(uninstallCommandedAt) : NaN;
  const pending = !Number.isNaN(commandedAt);
  const now = useNow(1000, pending);
  if (!pending) return null;
  return Math.max(0, commandedAt + UNINSTALL_GRACE_MS - now);
}

/** Translated label of an approval status. */
export function useProbeStatusLabel(): (status: Probe['status']) => string {
  const { t } = useTranslation();
  return (status) => {
    switch (status) {
      case 'pending': return t('probesPage.statusPending', 'Pending');
      case 'approved': return t('probesPage.statusApproved', 'Approved');
      case 'refused': return t('probesPage.statusRefused', 'Refused');
      case 'suspended': return t('probesPage.statusSuspended', 'Suspended');
      default: return String(status);
    }
  };
}

/**
 * Translated reason of an aborted update (probe-reported short code, see
 * probe/update_notify.go): 'Checksum mismatch', 'Download failed'…
 */
export function updateErrorLabel(code: string, t: TFunction): string {
  switch (code) {
    case 'download_failed': return t('probesPage.updateError.download_failed', 'Download failed');
    case 'checksum_mismatch': return t('probesPage.updateError.checksum_mismatch', 'Checksum mismatch');
    case 'version_check_failed': return t('probesPage.updateError.version_check_failed', 'Downloaded binary could not be checked');
    case 'same_version': return t('probesPage.updateError.same_version', 'Same version as the running one');
    case 'not_newer': return t('probesPage.updateError.not_newer', 'Not newer than the running version');
    case 'install_failed': return t('probesPage.updateError.install_failed', 'Installation failed');
    default: return t('probesPage.updateError.unknown', 'Unknown error');
  }
}

/** Abort reasons that are no failure (the probe already runs that version or a newer one). */
const HARMLESS_UPDATE_ERRORS = new Set(['same_version', 'not_newer']);

export interface ProbeStatusBadgeProps {
  probe: Pick<Probe, 'status' | 'online' | 'offlineSince' | 'lastSeenAt' | 'updatingSince' | 'uninstallCommandedAt'
    | 'updateAvailable' | 'latestVersion' | 'lastUpdateError' | 'lastUpdateErrorAt' | 'lastUpdateTarget'>;
  size?: 'sm' | 'md';
  /** Also render the 'Approved' pill next to the connectivity of an approved probe (detail header). */
  showApproval?: boolean;
  className?: string;
}

/**
 * Approval status (pending / refused / suspended), or for an approved probe
 * its connectivity (Online / Offline since …), plus 'Updating…', 'Update
 * failed: <reason>' (last aborted update), 'Update available vX' (the server
 * ships a newer version) and the 'Uninstalling (mm:ss)' countdown.
 */
export function ProbeStatusBadge({ probe, size = 'sm', showApproval = false, className }: ProbeStatusBadgeProps) {
  const { t } = useTranslation();
  const statusLabel = useProbeStatusLabel();
  const remaining = useUninstallRemaining(probe.uninstallCommandedAt);
  const sizeCls = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs';
  const dotCls = size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2';

  const approved = probe.status === 'approved';
  const approval = APPROVAL_CLS[probe.status] ?? APPROVAL_CLS.suspended;

  let connectivity: { label: string; cls: string; dot: string; title?: string } | null = null;
  if (approved) {
    if (probe.online === true) {
      connectivity = { label: t('probesPage.online', 'Online'), cls: 'bg-emerald-500/15 text-emerald-400', dot: 'bg-emerald-400' };
    } else if (!probe.lastSeenAt) {
      connectivity = { label: t('probesPage.neverSeen', 'Never seen'), cls: 'bg-zinc-500/15 text-zinc-400', dot: 'bg-zinc-500' };
    } else {
      connectivity = {
        label: t('probesPage.offline', 'Offline'),
        cls: 'bg-zinc-500/15 text-zinc-400',
        dot: 'bg-zinc-500',
        title: probe.offlineSince
          ? t('probesPage.offlineSinceTitle', 'Offline since {{date}}', { date: new Date(probe.offlineSince).toLocaleString() })
          : undefined,
      };
    }
  }

  // A past failure matters only while the probe is still behind the server
  // (an older server sends no updateAvailable: the failure is still shown).
  const updateFailed = !probe.updatingSince && !!probe.lastUpdateError
    && !HARMLESS_UPDATE_ERRORS.has(probe.lastUpdateError) && probe.updateAvailable !== false;

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
      {(!approved || showApproval) && (
        <span className={cn(PILL, sizeCls, approval.cls)}>
          {!approved && <span className={cn('rounded-full', dotCls, approval.dot)} />}
          {statusLabel(probe.status)}
        </span>
      )}
      {connectivity && (
        <span className={cn(PILL, sizeCls, connectivity.cls)} title={connectivity.title}>
          <span className={cn('rounded-full', dotCls, connectivity.dot)} />
          {connectivity.label}
        </span>
      )}
      {probe.updatingSince && (
        <span
          className={cn(PILL, sizeCls, 'bg-blue-500/15 text-blue-400')}
          title={t('probesPage.updatingSinceTitle', 'Updating since {{date}}', { date: new Date(probe.updatingSince).toLocaleString() })}
        >
          <Loader2 size={11} className="animate-spin" />
          {t('probesPage.updating', 'Updating…')}
        </span>
      )}
      {updateFailed && probe.lastUpdateError && (
        <span
          className={cn(PILL, sizeCls, 'bg-red-500/15 text-red-400')}
          title={[
            probe.lastUpdateTarget ? t('probesPage.updateFailedTarget', 'Update to v{{version}}', { version: probe.lastUpdateTarget }) : null,
            probe.lastUpdateErrorAt ? new Date(probe.lastUpdateErrorAt).toLocaleString() : null,
          ].filter(Boolean).join(' · ') || undefined}
        >
          <AlertTriangle size={11} />
          {t('probesPage.updateFailed', 'Update failed: {{error}}', { error: updateErrorLabel(probe.lastUpdateError, t) })}
        </span>
      )}
      {!probe.updatingSince && !updateFailed && probe.updateAvailable && probe.latestVersion && (
        <span className={cn(PILL, sizeCls, 'bg-sky-500/15 text-sky-400')}>
          <ArrowUpCircle size={11} />
          {t('probesPage.updateAvailable', 'Update available v{{version}}', { version: probe.latestVersion })}
        </span>
      )}
      {remaining !== null && (
        <span className={cn(PILL, sizeCls, 'bg-orange-500/15 text-orange-400')}>
          <span className={cn('rounded-full animate-pulse bg-orange-400', dotCls)} />
          {remaining > 0
            ? t('probesPage.uninstallingCountdown', 'Uninstalling ({{time}})', { time: formatMmSs(remaining) })
            : t('probesPage.uninstalling', 'Uninstalling')}
        </span>
      )}
    </span>
  );
}

/** Relative "last seen" text, refreshed every 30 s; the full date as tooltip. */
export function LastSeen({ ts, className }: { ts: string | null | undefined; className?: string }) {
  const { t } = useTranslation();
  useNow(30_000, !!ts);
  return (
    <span className={className} title={ts ? new Date(ts).toLocaleString() : undefined}>
      {formatRelative(ts, t)}
    </span>
  );
}

// ─── Live refresh ─────────────────────────────────────────────────────────────

const PROBE_EVENTS = [
  SOCKET_EVENTS.PROBE_STATUS_CHANGED,
  SOCKET_EVENTS.PROBE_APPROVED,
  SOCKET_EVENTS.PROBE_DEVICE_UPDATED,
  SOCKET_EVENTS.PROBE_DEVICE_DELETED,
] as const;

/** Window event dispatched by useSocket after a socket reconnect. */
const RESYNC_EVENT = 'oblimap:resync';

export interface ProbeLiveRefreshOptions {
  /** Only react to events about this probe (detail page). */
  probeId?: number;
  /**
   * Also reload on a tenant switch and after a socket reconnect (set it when
   * the page does not use useIpamLiveRefresh, which already does both).
   */
  resync?: boolean;
  /** Fallback poll (ms, default 60 s; 0 disables it). Skipped while the tab is hidden. */
  pollMs?: number;
  debounceMs?: number;
  /**
   * Leave PROBE_STATUS_CHANGED to another hook (set it when the page also uses
   * useIpamLiveRefresh, which already reloads on it: one reload per event).
   */
  skipStatusChanged?: boolean;
}

/**
 * Debounced reload on the probe socket events (PROBE_STATUS_CHANGED,
 * PROBE_APPROVED, PROBE_DEVICE_UPDATED, PROBE_DEVICE_DELETED — sent to the
 * tenant's probes.manage holders, ids only) with a slow polling fallback.
 */
export function useProbeLiveRefresh(onRefresh: () => void, options: ProbeLiveRefreshOptions = {}): void {
  const { probeId, resync = false, pollMs = 60_000, debounceMs = 800, skipStatusChanged = false } = options;
  const callbackRef = useRef(onRefresh);
  callbackRef.current = onRefresh;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceRef = useRef(debounceMs);
  debounceRef.current = debounceMs;

  const scheduleRef = useRef(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      callbackRef.current();
    }, debounceRef.current);
  });

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const socketStatus = useSocketStore((s) => s.status);
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = (payload?: unknown) => {
      if (probeId !== undefined) {
        const id = (payload as { probeId?: unknown } | null | undefined)?.probeId;
        if (Number(id) !== probeId) return;
      }
      scheduleRef.current();
    };
    const events = skipStatusChanged
      ? PROBE_EVENTS.filter((ev) => ev !== SOCKET_EVENTS.PROBE_STATUS_CHANGED)
      : PROBE_EVENTS;
    for (const ev of events) socket.on(ev, handler);
    return () => {
      for (const ev of events) socket.off(ev, handler);
    };
  }, [socketStatus, probeId, skipStatusChanged]);

  // Fallback poll (events can be missed: no capability room yet, proxies…).
  useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      callbackRef.current();
    }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs]);

  // Tenant switch / socket reconnect (opt-in).
  const epoch = useTenantEpoch();
  const prevEpochRef = useRef(epoch);
  useEffect(() => {
    if (!resync || prevEpochRef.current === epoch) {
      prevEpochRef.current = epoch;
      return;
    }
    prevEpochRef.current = epoch;
    scheduleRef.current();
  }, [epoch, resync]);

  useEffect(() => {
    if (!resync) return;
    const onResync = () => scheduleRef.current();
    window.addEventListener(RESYNC_EVENT, onResync);
    return () => window.removeEventListener(RESYNC_EVENT, onResync);
  }, [resync]);
}
