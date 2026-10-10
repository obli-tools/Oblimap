import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { Cable, History, RefreshCw, StopCircle } from 'lucide-react';
import { SOCKET_EVENTS } from '@oblimap/shared';
import { tunnelApi, type TunnelListEntry } from '@/api/tunnel.api';
import { getSocket } from '@/socket/socketClient';
import { useAuthStore, useFullAccess } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadError } from '@/components/common/LoadError';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { Button } from '@/components/common/Button';
import { useAnonymize } from '@/utils/anonymize';
import { useFormatRelative } from '@/utils/formatRelative';
import { toastApiError } from '@/utils/apiError';
import { cn } from '@/utils/cn';

/** Fallback refresh when a socket event is missed (and to age the relative times). */
const POLL_MS = 30_000;
/** Coalesces a burst of TUNNEL_CHANGED (opening → active) into one reload. */
const EVENT_DEBOUNCE_MS = 400;
const CLOSED_LIMIT = 50;
/** Fired on window after a socket reconnect (useSocket RESYNC_EVENT). */
const RESYNC_EVENT = 'oblimap:resync';
const IPV4_IN_TEXT_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

const TH = 'px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-text-muted';
const TD = 'px-4 py-2.5 align-top';

function formatDateTime(value: string | null, locale: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(locale);
}

function formatDuration(from: string, to: string | null, t: TFunction): string {
  if (!to) return '—';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) {
    return t('supervision.tunnels.durationSeconds', { s: totalSec, defaultValue: '{{s}} s' });
  }
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    return t('supervision.tunnels.durationMinutes', { m: totalMin, s: totalSec % 60, defaultValue: '{{m}} min {{s}} s' });
  }
  return t('supervision.tunnels.durationHours', {
    h: Math.floor(totalMin / 60),
    m: totalMin % 60,
    defaultValue: '{{h}} h {{m}} min',
  });
}

/**
 * Tunnels of the tenant (Supervision hub, 'tunnels' tab; Obliance
 * RemoteSessionsPage pattern). Full access (platform / tenant admin): every
 * tunnel of the tenant, any of them can be closed; tunnels.use holders: their
 * own. Active tunnels and the last 50 finished ones; live through
 * TUNNEL_CHANGED with a 30 s fallback poll. Every name and address is
 * anonymized in anonymous mode.
 */
export function TunnelsPanel() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const formatRelative = useFormatRelative();
  const { anonymize, isAnonymous } = useAnonymize();
  const fullAccess = useFullAccess();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const tenantId = useTenantStore((s) => s.currentTenantId);

  const [active, setActive] = useState<TunnelListEntry[]>([]);
  const [closed, setClosed] = useState<TunnelListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async (manual = false) => {
    const seq = ++seqRef.current;
    if (manual) setRefreshing(true);
    try {
      const [a, c] = await Promise.all([
        tunnelApi.list({ status: 'active' }),
        tunnelApi.list({ status: 'closed', limit: CLOSED_LIMIT }),
      ]);
      if (seq !== seqRef.current) return;
      setActive(a.tunnels);
      setClosed(c.tunnels);
      setFailed(false);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setFailed(true);
      if (manual) toastApiError(err, t('supervision.tunnels.loadFailed', 'Could not load the tunnels'));
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [t]);

  // Tenant switch: drop the previous tenant's rows at once (no stale Close
  // buttons / site links while the new list loads) and any late answer of
  // a request sent under the old tenant.
  useEffect(() => {
    seqRef.current++;
    setActive([]);
    setClosed([]);
    setFailed(false);
    setLoading(true);
  }, [tenantId]);

  // Initial load, tenant switch, fallback poll.
  useEffect(() => {
    setLoading(true);
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load, tenantId]);

  // Live updates: TUNNEL_CHANGED (ids only, the list is refetched) and the
  // resync after a socket reconnect.
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { void load(); }, EVENT_DEBOUNCE_MS);
    };
    const socket = getSocket();
    socket?.on(SOCKET_EVENTS.TUNNEL_CHANGED, schedule);
    window.addEventListener(RESYNC_EVENT, schedule);
    return () => {
      if (debounce) clearTimeout(debounce);
      socket?.off(SOCKET_EVENTS.TUNNEL_CHANGED, schedule);
      window.removeEventListener(RESYNC_EVENT, schedule);
    };
  }, [load]);

  const target = (row: TunnelListEntry) => `${anonymize(row.targetIp, 'ip')}:${row.targetPort}`;
  const userLabel = (row: TunnelListEntry) =>
    row.requestedByUsername ? anonymize(row.requestedByUsername, 'username') : t('supervision.tunnels.deletedUser', 'Deleted user');
  const probeLabel = (row: TunnelListEntry) =>
    row.probeName ? anonymize(row.probeName, 'hostname') : `#${row.probeId}`;
  const errorText = (message: string) =>
    (isAnonymous ? message.replace(IPV4_IN_TEXT_RE, (ip) => anonymize(ip, 'ip')) : message);
  const canClose = (row: TunnelListEntry) => fullAccess || (userId !== null && row.requestedBy === userId);

  const siteCell = (row: TunnelListEntry) => (
    row.siteName
      ? (
        <Link to={`/sites/${row.siteId}`} className="text-accent hover:underline">
          {anonymize(row.siteName, 'hostname')}
        </Link>
      )
      : <span className="text-text-muted">—</span>
  );

  const handleClose = async (row: TunnelListEntry) => {
    const own = userId !== null && row.requestedBy === userId;
    const ok = await confirm({
      title: t('supervision.tunnels.closeTitle', 'Close this tunnel?'),
      message: own
        ? t('supervision.tunnels.closeConfirmOwn', 'The tunnel to {{target}} is closed and its connections are cut.', { target: target(row) })
        : t('supervision.tunnels.closeConfirmOther', 'The tunnel opened by {{user}} to {{target}} is closed and its connections are cut.', {
          user: userLabel(row),
          target: target(row),
        }),
      confirmLabel: t('supervision.tunnels.close', 'Close'),
      danger: true,
    });
    if (!ok) return;
    setClosingId(row.id);
    try {
      await tunnelApi.close(row.id);
      toast.success(t('supervision.tunnels.closed', 'Tunnel closed'));
      await load();
    } catch (err) {
      toastApiError(err, t('supervision.tunnels.closeFailed', 'Could not close the tunnel'));
    } finally {
      setClosingId(null);
    }
  };

  if (loading && active.length === 0 && closed.length === 0) {
    return <div className="flex justify-center py-12"><LoadingSpinner /></div>;
  }
  if (failed && active.length === 0 && closed.length === 0) {
    return <LoadError onRetry={() => { void load(true); }} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">
          {fullAccess
            ? t('supervision.tunnels.scopeAll', 'Every tunnel of this workspace.')
            : t('supervision.tunnels.scopeOwn', 'The tunnels you opened.')}
        </p>
        <Button variant="secondary" size="sm" onClick={() => { void load(true); }} disabled={refreshing}>
          <RefreshCw className={cn('mr-1.5 h-4 w-4', refreshing && 'animate-spin')} />
          {t('common.refresh', 'Refresh')}
        </Button>
      </div>

      {/* Active tunnels */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-text-primary">
          {t('supervision.tunnels.activeTitle', 'Active tunnels')}
          <span className="ml-2 text-text-muted">{active.length}</span>
        </h2>
        {active.length === 0 ? (
          <EmptyState
            icon={<Cable className="h-6 w-6" />}
            title={t('supervision.tunnels.noActive', 'No open tunnel')}
            description={t('supervision.tunnels.noActiveHint', 'Tunnels opened from a site\'s devices appear here.')}
          />
        ) : (
          <TableScroll className="bg-bg-secondary rounded-xl">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={TH}>{t('supervision.tunnels.colTarget', 'Target')}</th>
                  <th className={cn(TH, 'hidden md:table-cell')}>{t('supervision.tunnels.colUser', 'User')}</th>
                  <th className={cn(TH, 'hidden lg:table-cell')}>{t('supervision.tunnels.colProbe', 'Probe')}</th>
                  <th className={TH}>{t('supervision.tunnels.colSite', 'Site')}</th>
                  <th className={cn(TH, 'hidden md:table-cell')}>{t('supervision.tunnels.colOpened', 'Opened')}</th>
                  <th className={cn(TH, 'hidden lg:table-cell')}>{t('supervision.tunnels.colIdle', 'Last activity')}</th>
                  <th className={cn(TH, 'text-right')}><span className="sr-only">{t('supervision.tunnels.colActions', 'Actions')}</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {active.map((row) => (
                  <tr key={row.id} className="hover:bg-bg-tertiary transition-colors">
                    <td className={TD}>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-text-primary">{target(row)}</span>
                        {row.status === 'opening' && (
                          <span className="rounded-full border border-yellow-400/30 bg-yellow-400/10 px-2 py-0.5 text-xs text-yellow-400">
                            {t('supervision.tunnels.statusOpening', 'Opening')}
                          </span>
                        )}
                      </div>
                      {/* Columns hidden on narrow screens. */}
                      <p className="mt-0.5 text-xs text-text-muted lg:hidden">
                        <span className="md:hidden">{userLabel(row)} · </span>
                        {probeLabel(row)}
                        <span className="md:hidden"> · {formatRelative(row.createdAt)}</span>
                      </p>
                    </td>
                    <td className={cn(TD, 'hidden md:table-cell text-text-secondary')}>{userLabel(row)}</td>
                    <td className={cn(TD, 'hidden lg:table-cell text-text-secondary')}>{probeLabel(row)}</td>
                    <td className={TD}>{siteCell(row)}</td>
                    <td className={cn(TD, 'hidden md:table-cell text-text-secondary whitespace-nowrap')} title={formatDateTime(row.createdAt, i18n.language)}>
                      {formatRelative(row.createdAt)}
                    </td>
                    <td className={cn(TD, 'hidden lg:table-cell text-text-secondary whitespace-nowrap')}
                      title={formatDateTime(row.lastActivityAt ?? row.createdAt, i18n.language)}>
                      {formatRelative(row.lastActivityAt ?? row.createdAt)}
                    </td>
                    <td className={cn(TD, 'text-right')}>
                      {canClose(row) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-400 hover:text-red-300"
                          onClick={() => { void handleClose(row); }}
                          disabled={closingId === row.id}
                        >
                          <StopCircle className="mr-1.5 h-4 w-4" />
                          {closingId === row.id
                            ? t('supervision.tunnels.closing', 'Closing…')
                            : t('supervision.tunnels.close', 'Close')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      {/* Closed tunnels */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-text-primary">
          {t('supervision.tunnels.closedTitle', 'Recently closed')}
          <span className="ml-2 font-normal text-text-muted">
            {t('supervision.tunnels.closedLimit', 'last {{limit}}', { limit: CLOSED_LIMIT })}
          </span>
        </h2>
        {closed.length === 0 ? (
          <EmptyState
            icon={<History className="h-6 w-6" />}
            title={t('supervision.tunnels.noClosed', 'No closed tunnel yet')}
          />
        ) : (
          <TableScroll className="bg-bg-secondary rounded-xl">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={TH}>{t('supervision.tunnels.colTarget', 'Target')}</th>
                  <th className={cn(TH, 'hidden md:table-cell')}>{t('supervision.tunnels.colUser', 'User')}</th>
                  <th className={cn(TH, 'hidden lg:table-cell')}>{t('supervision.tunnels.colProbe', 'Probe')}</th>
                  <th className={TH}>{t('supervision.tunnels.colSite', 'Site')}</th>
                  <th className={cn(TH, 'hidden md:table-cell')}>{t('supervision.tunnels.colOpened', 'Opened')}</th>
                  <th className={cn(TH, 'hidden md:table-cell')}>{t('supervision.tunnels.colDuration', 'Duration')}</th>
                  <th className={TH}>{t('supervision.tunnels.colResult', 'Result')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {closed.map((row) => (
                  <tr key={row.id} className="hover:bg-bg-tertiary transition-colors">
                    <td className={TD}>
                      <span className="font-mono text-text-primary">{target(row)}</span>
                      <p className="mt-0.5 text-xs text-text-muted lg:hidden">
                        <span className="md:hidden">{userLabel(row)} · </span>
                        {probeLabel(row)}
                        <span className="md:hidden"> · {formatDuration(row.createdAt, row.closedAt, t)}</span>
                      </p>
                    </td>
                    <td className={cn(TD, 'hidden md:table-cell text-text-secondary')}>{userLabel(row)}</td>
                    <td className={cn(TD, 'hidden lg:table-cell text-text-secondary')}>{probeLabel(row)}</td>
                    <td className={TD}>{siteCell(row)}</td>
                    <td className={cn(TD, 'hidden md:table-cell text-text-secondary whitespace-nowrap')}>
                      {formatDateTime(row.createdAt, i18n.language)}
                    </td>
                    <td className={cn(TD, 'hidden md:table-cell text-text-secondary whitespace-nowrap')}>
                      {formatDuration(row.createdAt, row.closedAt, t)}
                    </td>
                    <td className={TD}>
                      <span
                        className={cn(
                          'whitespace-nowrap rounded-full border px-2 py-0.5 text-xs',
                          row.status === 'error'
                            ? 'border-red-400/30 bg-red-400/10 text-red-400'
                            : 'border-border bg-bg-tertiary text-text-secondary',
                        )}
                      >
                        {row.status === 'error'
                          ? t('supervision.tunnels.statusError', 'Failed')
                          : t('supervision.tunnels.statusClosed', 'Closed')}
                      </span>
                      {row.errorMessage && (
                        <p className="mt-1 max-w-xs break-words text-xs text-text-muted">{errorText(row.errorMessage)}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>
    </div>
  );
}
