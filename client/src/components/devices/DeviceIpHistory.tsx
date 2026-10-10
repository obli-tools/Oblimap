import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { History, Loader2 } from 'lucide-react';
import type { ItemIpHistory } from '@oblimap/shared';
import { itemsApi } from '@/api/items.api';
import { useAnonymize } from '@/utils/anonymize';
import { formatRelative } from '@/utils/formatRelative';
import { cn } from '@/utils/cn';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadError } from '@/components/common/LoadError';
import { TableScroll } from '@/components/common/TableScroll';

function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

/** "3 d 4 h", "25 min", "< 1 min": how long the MAC held the IP. */
function spanLabel(fromIso: string, toIso: string, t: TFunction): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return t('deviceDetail.ipHistory.lessThanMinute', '< 1 min');
  const min = Math.floor(ms / 60_000);
  if (min < 60) return t('deviceDetail.ipHistory.minutes', { count: min, defaultValue: '{{count}} min' });
  const h = Math.floor(min / 60);
  if (h < 48) return t('deviceDetail.ipHistory.hours', { count: h, defaultValue: '{{count}} h' });
  return t('deviceDetail.ipHistory.days', { count: Math.floor(h / 24), defaultValue: '{{count}} d' });
}

export interface DeviceIpHistoryProps {
  itemId: number;
  /** The device's MAC: the history follows it (none = no history). */
  mac: string | null;
  /** The device's current IP (marked in the list). */
  currentIp: string;
  /** Changing it reloads the list silently (live refresh). */
  refreshKey?: number;
}

/**
 * The IPs the device's MAC held on its site (item_ip_history, newest
 * first): first / last seen and how long. Addresses are masked in
 * anonymous mode.
 */
export function DeviceIpHistory({ itemId, mac, currentIp, refreshKey = 0 }: DeviceIpHistoryProps) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const [history, setHistory] = useState<ItemIpHistory[] | null>(null);
  const [error, setError] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await itemsApi.ipHistory(itemId);
      if (mine !== seq.current) return;
      setHistory(res.history);
      setError(false);
    } catch {
      if (mine !== seq.current) return;
      setError(true);
    }
  }, [itemId]);

  useEffect(() => {
    setHistory(null);
    setError(false);
  }, [itemId]);

  useEffect(() => {
    if (mac) void load();
  }, [load, mac, refreshKey]);

  useEffect(() => () => { seq.current += 1; }, []);

  if (!mac) {
    return (
      <EmptyState
        icon={<History className="h-6 w-6" />}
        title={t('deviceDetail.ipHistory.noMac', 'No IP history')}
        description={t('deviceDetail.ipHistory.noMacHint', 'The IP history follows the MAC address, and this device has none.')}
      />
    );
  }
  if (history === null) {
    if (error) {
      return (
        <LoadError
          message={t('deviceDetail.ipHistory.failedLoad', 'Could not load the IP history.')}
          onRetry={() => void load()}
        />
      );
    }
    return (
      <div className="flex justify-center py-10">
        <Loader2 size={22} className="animate-spin text-accent" />
      </div>
    );
  }
  if (history.length === 0) {
    return (
      <EmptyState
        icon={<History className="h-6 w-6" />}
        title={t('deviceDetail.ipHistory.empty', 'No IP history yet')}
        description={t('deviceDetail.ipHistory.emptyHint', 'Every IP the probes see this MAC address use on the site is listed here.')}
      />
    );
  }

  const distinct = new Set(history.map((h) => h.ip)).size;
  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-400">
          {t('deviceDetail.failedRefresh', 'Refresh failed: the data shown may be out of date.')}
        </p>
      )}
      <p className="text-sm text-text-muted">
        {t('deviceDetail.ipHistory.summary', {
          count: distinct,
          defaultValue: '{{count}} IP address(es) seen for this MAC address on this site.',
        })}
      </p>
      <div className="rounded-xl bg-bg-secondary shadow-[var(--shadow-card)]">
        <TableScroll>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                <th className="px-4 py-2 font-medium">{t('deviceDetail.ipHistory.colIp', 'IP address')}</th>
                <th className="px-4 py-2 font-medium">{t('deviceDetail.ipHistory.colFirstSeen', 'First seen')}</th>
                <th className="px-4 py-2 font-medium">{t('deviceDetail.ipHistory.colLastSeen', 'Last seen')}</th>
                <th className="hidden px-4 py-2 font-medium sm:table-cell">{t('deviceDetail.ipHistory.colDuration', 'Span')}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const current = h.ip === currentIp;
                return (
                  <tr key={h.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">
                      <span className={cn('font-mono', current ? 'text-text-primary' : 'text-text-secondary')}>
                        {anonymize(h.ip, 'ip')}
                      </span>
                      {current && (
                        <span className="ml-2 rounded-full border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                          {t('deviceDetail.ipHistory.current', 'current')}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-text-secondary" title={absoluteTime(h.firstSeenAt)}>
                      {absoluteTime(h.firstSeenAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-text-secondary" title={absoluteTime(h.lastSeenAt)}>
                      {formatRelative(h.lastSeenAt, t)}
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-2 text-xs text-text-muted sm:table-cell">
                      {spanLabel(h.firstSeenAt, h.lastSeenAt, t)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      </div>
    </div>
  );
}
