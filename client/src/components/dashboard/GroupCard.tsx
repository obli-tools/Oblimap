import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderOpen, MapPin, Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/utils/cn';
import { useAnonymize } from '@/utils/anonymize';

// Ported from Obliance client/src/pages/DashboardPage.tsx:477-610 (GroupCard)
// and the recursive "by group" view (:1450-1515, renderGroupNode :1556):
// group name, online / total badge, progress bar and pictos, each with a
// tooltip. Each gauge is its own link, so the
// card itself is not one wrapping <Link> (nested anchors are invalid).

export interface GroupCardStats {
  /** Devices of the group and its sub-groups, over the readable sites. */
  total: number;
  online: number;
  offline: number;
  siteCount: number;
}

export interface GroupCardProps {
  groupId: number;
  name: string;
  /** null: no figures for this group (an ancestor shown for context). */
  stats: GroupCardStats | null;
  depth?: number;
  children?: ReactNode;
}

export function GroupCard({ groupId, name, stats, depth = 0, children }: GroupCardProps) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const total = stats?.total ?? 0;
  const online = stats?.online ?? 0;
  const offline = stats?.offline ?? 0;
  const upPct = total > 0 ? Math.round((online / total) * 100) : 0;
  const barColor = upPct >= 95 ? 'bg-green-400' : upPct >= 70 ? 'bg-amber-400' : 'bg-red-400';
  const onlineColor =
    total === 0 ? 'text-text-muted' : upPct >= 95 ? 'text-green-400' : upPct >= 70 ? 'text-amber-400' : 'text-red-400';

  const deviceLink = (status?: string) => {
    const p = new URLSearchParams();
    p.set('groupId', String(groupId));
    if (status) p.set('status', status);
    return `/devices?${p.toString()}`;
  };

  return (
    <div
      className={cn(
        'rounded-lg px-4 py-3 shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_4px_18px_-8px_rgba(0,0,0,0.45)] max-sm:px-3',
        depth > 0 ? 'bg-bg-tertiary' : 'bg-bg-secondary',
      )}
    >
      <div className="flex min-w-0 items-center gap-3 max-sm:flex-wrap max-sm:gap-y-2">
        <Link
          to={`/group/${groupId}`}
          className="flex min-w-0 items-center gap-2 hover:opacity-90 max-sm:flex-1 coarse:min-h-10"
        >
          <FolderOpen size={depth > 0 ? 14 : 16} className="shrink-0 text-accent" />
          <span className="min-w-0 truncate text-[14px] font-semibold text-text-primary">
            {anonymize(name, 'hostname')}
          </span>
        </Link>

        {stats && (
          <>
            <Link
              to={deviceLink('online')}
              className="ml-2 flex items-center gap-1.5 hover:opacity-80"
              title={t('dashboard.groupTooltipOnline', '{{online}} online · {{offline}} offline · {{total}} total', {
                online,
                offline,
                total,
              })}
            >
              <Wifi size={13} className={onlineColor} />
              <span className="font-mono text-[12px] text-text-secondary">
                <span className={onlineColor}>{online}</span>
                <span className="text-text-muted"> / {total}</span>
              </span>
            </Link>

            <div className="mx-2 h-1.5 min-w-0 max-w-[300px] flex-1 overflow-hidden rounded bg-text-muted/10 max-sm:hidden">
              <div className={cn('h-full', barColor)} style={{ width: `${upPct}%` }} />
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-3 max-sm:ml-0 max-sm:w-full max-sm:flex-wrap">
              {offline > 0 && (
                <Link
                  to={deviceLink('offline')}
                  className="flex items-center gap-1 font-mono text-[12px] text-text-muted hover:text-text-secondary"
                  title={t('dashboard.groupTooltipOffline', '{{count}} offline', { count: offline })}
                >
                  <WifiOff size={13} /> {offline}
                </Link>
              )}
              <span
                className="flex items-center gap-1 font-mono text-[12px] text-text-muted"
                title={t('dashboard.groupTooltipSites', '{{count}} sites', { count: stats.siteCount })}
              >
                <MapPin size={13} /> {stats.siteCount}
              </span>
            </div>
          </>
        )}
      </div>
      {children != null && <div className="mt-3 grid grid-cols-1 gap-2 pl-4 md:grid-cols-2">{children}</div>}
    </div>
  );
}
