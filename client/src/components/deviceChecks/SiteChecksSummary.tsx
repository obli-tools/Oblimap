/**
 * SiteChecksSummary — device check counts of one site:
 * - variant 'card' (Sites page): "1/1 OK", or a red "1 failing" pill;
 * - variant 'inline' (site header stats bar): "Checks: 11 OK · 1 failing".
 *
 * Fed by GET /device-checks/summary (Sites page) or by the items' checks
 * (summarizeItemChecks, site page). Renders nothing when the site has no check.
 */

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Activity } from 'lucide-react';
import type { DeviceCheckSiteSummary, SiteItem } from '@oblimap/shared';
import { cn } from '@/utils/cn';

export type DeviceCheckCounts = Omit<DeviceCheckSiteSummary, 'siteId'>;

/** Counts of the checks carried by site items (same buckets as GET /device-checks/summary). */
export function summarizeItemChecks(items: readonly SiteItem[]): DeviceCheckCounts {
  const counts: DeviceCheckCounts = { total: 0, ok: 0, failing: 0, error: 0, alerting: 0, stale: 0 };
  for (const item of items) {
    for (const check of item.checks ?? []) {
      counts.total++;
      if (check.status === 'ok') counts.ok++;
      else if (check.status === 'fail') counts.failing++;
      else if (check.status === 'error') counts.error++;
      if (check.alertState === 'alerting') counts.alerting++;
      if (check.stale) counts.stale++;
    }
  }
  return counts;
}

function tooltipOf(c: DeviceCheckCounts, t: TFunction): string {
  return [
    t('deviceChecks.siteSummary.tooltipTotal', { count: c.total, defaultValue: '{{count}} device checks' }),
    t('deviceChecks.siteSummary.okCount', { count: c.ok, defaultValue: '{{count}} OK' }),
    t('deviceChecks.siteSummary.failing', { count: c.failing, defaultValue: '{{count}} failing' }),
    t('deviceChecks.siteSummary.error', { count: c.error, defaultValue: '{{count}} in error' }),
    t('deviceChecks.siteSummary.alerting', { count: c.alerting, defaultValue: '{{count}} alerting' }),
    t('deviceChecks.siteSummary.stale', { count: c.stale, defaultValue: '{{count}} without recent result' }),
  ].join('\n');
}

export interface SiteChecksSummaryProps {
  counts: DeviceCheckCounts | null | undefined;
  variant?: 'card' | 'inline';
  className?: string;
}

export function SiteChecksSummary({ counts, variant = 'card', className }: SiteChecksSummaryProps) {
  const { t } = useTranslation();
  if (!counts || counts.total <= 0) return null;
  const tooltip = tooltipOf(counts, t);

  if (variant === 'inline') {
    return (
      <span className={cn('inline-flex items-center gap-1.5', className)} title={tooltip}>
        <Activity size={13} className="text-text-muted" aria-hidden="true" />
        <span>{t('deviceChecks.siteSummary.label', 'Checks:')}</span>
        <span className={counts.ok > 0 ? 'text-accent' : 'text-text-muted'}>
          {t('deviceChecks.siteSummary.okCount', { count: counts.ok, defaultValue: '{{count}} OK' })}
        </span>
        {counts.failing > 0 && (
          <>
            <span className="text-text-muted" aria-hidden="true">·</span>
            <span className="text-red-400">
              {t('deviceChecks.siteSummary.failing', { count: counts.failing, defaultValue: '{{count}} failing' })}
            </span>
          </>
        )}
        {counts.error > 0 && (
          <>
            <span className="text-text-muted" aria-hidden="true">·</span>
            <span className="text-amber-400">
              {t('deviceChecks.siteSummary.error', { count: counts.error, defaultValue: '{{count}} in error' })}
            </span>
          </>
        )}
        {counts.alerting > 0 && (
          <>
            <span className="text-text-muted" aria-hidden="true">·</span>
            <span className="font-medium text-red-400">
              {t('deviceChecks.siteSummary.alerting', { count: counts.alerting, defaultValue: '{{count}} alerting' })}
            </span>
          </>
        )}
      </span>
    );
  }

  const problems = counts.failing + counts.error;
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 text-xs', className)} title={tooltip}>
      <Activity size={12} className="shrink-0 text-text-muted" aria-hidden="true" />
      {problems === 0 ? (
        <span className="rounded-full bg-accent/10 px-2 py-0.5 font-medium text-accent">
          {t('deviceChecks.siteSummary.ok', { ok: counts.ok, total: counts.total, defaultValue: '{{ok}}/{{total}} OK' })}
        </span>
      ) : (
        <>
          {counts.failing > 0 && (
            <span className="rounded-full bg-red-500/15 px-2 py-0.5 font-medium text-red-400">
              {t('deviceChecks.siteSummary.failing', { count: counts.failing, defaultValue: '{{count}} failing' })}
            </span>
          )}
          {counts.error > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-400">
              {t('deviceChecks.siteSummary.error', { count: counts.error, defaultValue: '{{count}} in error' })}
            </span>
          )}
          <span className="text-text-muted">
            {t('deviceChecks.siteSummary.ok', { ok: counts.ok, total: counts.total, defaultValue: '{{ok}}/{{total}} OK' })}
          </span>
        </>
      )}
      {counts.alerting > 0 && (
        <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-red-400">
          {t('deviceChecks.siteSummary.alerting', { count: counts.alerting, defaultValue: '{{count}} alerting' })}
        </span>
      )}
      {counts.stale > 0 && (
        <span className="text-text-muted">
          {t('deviceChecks.siteSummary.stale', { count: counts.stale, defaultValue: '{{count}} without recent result' })}
        </span>
      )}
    </div>
  );
}
