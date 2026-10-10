import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, Radar, Zap } from 'lucide-react';
import { clsx } from 'clsx';
import type { SiteProbe } from '@/api/site.api';
import { useAnonymize } from '@/utils/anonymize';
import { LoadError } from '@/components/common/LoadError';
import { EmptyState } from '@/components/common/EmptyState';
import { TableScroll } from '@/components/common/TableScroll';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

// The probes of a site, from GET /sites/:id/probes (site read): which probes
// scan it, their role and whether they still report. The probe pages take
// 'probes.manage': names link to them only for its holders.

/** "Just now" / "5m ago" / "3h ago" / a date. */
export function formatAgo(ts: string | null, t: TFunction): string {
  if (!ts) return t('common.never', 'Never');
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return t('probesPage.justNow', 'Just now');
  if (diff < 3_600_000) return t('probesPage.minutesAgo', { n: Math.floor(diff / 60_000), defaultValue: '{{n}}m ago' });
  if (diff < 86_400_000) return t('probesPage.hoursAgo', { n: Math.floor(diff / 3_600_000), defaultValue: '{{n}}h ago' });
  return new Date(ts).toLocaleDateString();
}

/** True when the site has probes and none of them is online (its data may be stale). */
export function allProbesOffline(probes: readonly SiteProbe[] | null): boolean {
  return !!probes && probes.length > 0 && probes.every((p) => p.online === false);
}

function onlineDot(probe: SiteProbe): string {
  if (probe.online === true) return 'bg-emerald-500';
  if (probe.online === false) return 'bg-red-500';
  return 'bg-zinc-500';
}

function ProbeName({ probe, canManageProbes, className }: { probe: SiteProbe; canManageProbes: boolean; className?: string }) {
  const { anonymize } = useAnonymize();
  const name = anonymize(probe.name, 'hostname');
  return canManageProbes ? (
    <Link to={`/manage/probes/${probe.id}`} className={clsx('hover:text-accent transition-colors', className)}>
      {name}
    </Link>
  ) : (
    <span className={className}>{name}</span>
  );
}

/** Compact probe strip at the top of the Devices tab (any subnet count). */
export function SiteProbeStrip({
  probes,
  canManageProbes,
}: {
  probes: readonly SiteProbe[] | null;
  canManageProbes: boolean;
}) {
  const { t } = useTranslation();
  if (!probes || probes.length === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1 text-xs text-text-muted">
        <Radar size={12} />
        {t('siteDetail.probes.strip', 'Probes')}
      </span>
      {probes.map((p) => (
        <span
          key={p.id}
          className="inline-flex items-center gap-1.5 rounded-full bg-bg-secondary px-2.5 py-0.5 text-xs text-text-primary"
          title={p.online === false
            ? t('siteDetail.probes.offlineSince', { when: formatAgo(p.offlineSince ?? p.lastSeenAt, t), defaultValue: 'Offline since {{when}}' })
            : t('siteDetail.probes.lastSeen', { when: formatAgo(p.lastSeenAt, t), defaultValue: 'Last seen {{when}}' })}
        >
          <span className={clsx('h-1.5 w-1.5 rounded-full', onlineDot(p))} />
          <ProbeName probe={p} canManageProbes={canManageProbes} className="font-medium" />
          {p.isPrimary && probes.length > 1 && (
            <span className="text-[10px] uppercase tracking-wide text-accent">{t('siteDetail.probes.primary', 'Primary')}</span>
          )}
        </span>
      ))}
    </div>
  );
}

/** Warning shown when every probe of the site is offline: the device list may be out of date. */
export function StaleProbesBanner({ probes }: { probes: readonly SiteProbe[] | null }) {
  const { t } = useTranslation();
  if (!allProbesOffline(probes)) return null;
  return (
    <div role="status" className="mb-4 flex items-start gap-2 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <span>
        {t('siteDetail.probes.staleBanner', 'Every probe of this site is offline: the device list may be out of date.')}
      </span>
    </div>
  );
}

/** Probes tab of the site page. */
export function SiteProbesTab({
  probes,
  error,
  onRetry,
  canManageProbes,
}: {
  /** null while loading (or after a failed load). */
  probes: SiteProbe[] | null;
  error: boolean;
  onRetry: () => void;
  canManageProbes: boolean;
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();

  if (error && !probes) {
    return <LoadError message={t('probesPage.failedLoad', 'Failed to load probes')} onRetry={onRetry} />;
  }
  if (!probes) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }
  if (probes.length === 0) {
    return (
      <EmptyState
        icon={<Radar className="h-6 w-6" />}
        title={t('siteDetail.probes.none', 'No probe scans this site')}
        description={t('siteDetail.probes.noneDesc', 'Approve a probe and assign it to this site to discover its devices.')}
      />
    );
  }

  return (
    <div>
      <StaleProbesBanner probes={probes} />
      <TableScroll className="bg-bg-secondary">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-text-muted uppercase tracking-wider">
              <th className="px-4 py-3">{t('siteDetail.probes.colProbe', 'Probe')}</th>
              <th className="px-4 py-3">{t('siteDetail.probes.colRole', 'Role')}</th>
              <th className="px-4 py-3">{t('siteDetail.probes.colStatus', 'Status')}</th>
              <th className="px-4 py-3 hidden sm:table-cell">{t('siteDetail.probes.colLastSeen', 'Last seen')}</th>
              <th className="px-4 py-3 hidden md:table-cell">{t('siteDetail.probes.colVersion', 'Version')}</th>
            </tr>
          </thead>
          <tbody>
            {probes.map((p) => {
              const ips = p.ips && p.ips.length > 0 ? p.ips : p.ip ? [p.ip] : [];
              return (
                <tr key={p.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <ProbeName probe={p} canManageProbes={canManageProbes} className="font-medium text-text-primary" />
                    {ips.length > 0 && (
                      <p className="text-xs font-mono text-text-muted mt-0.5">{ips.map((ip) => anonymize(ip, 'ip')).join(', ')}</p>
                    )}
                    {p.mac && <p className="text-xs font-mono text-text-muted">{anonymize(p.mac, 'mac')}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={clsx(
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                      p.isPrimary ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-secondary',
                    )}>
                      {p.isPrimary ? t('siteDetail.probes.primary', 'Primary') : t('siteDetail.probes.secondary', 'Secondary')}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
                        <span className={clsx('h-2 w-2 rounded-full', onlineDot(p))} />
                        {p.online === true
                          ? t('siteDetail.probes.online', 'Online')
                          : p.online === false
                            ? t('siteDetail.probes.offlineSince', { when: formatAgo(p.offlineSince ?? p.lastSeenAt, t), defaultValue: 'Offline since {{when}}' })
                            : t('siteDetail.probes.unknown', 'Unknown')}
                      </span>
                      {p.wsConnected && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent"
                          title={t('siteDetail.probes.liveHint', 'Connected over its live channel: commands reach it at once')}
                        >
                          <Zap size={9} />
                          {t('siteDetail.probes.live', 'Live')}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell text-xs text-text-muted">{formatAgo(p.lastSeenAt, t)}</td>
                  <td className="px-4 py-3 hidden md:table-cell text-xs font-mono text-text-muted">{p.probeVersion ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}
