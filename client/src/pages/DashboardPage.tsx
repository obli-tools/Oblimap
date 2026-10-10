import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  LayoutDashboard, MapPin, Radar, RefreshCw, Clock, WifiOff,
  Network, Bookmark, Shuffle, Sparkles, FolderTree, ShieldCheck,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GroupTreeNode } from '@oblimap/shared';
import { useAuthStore, useTenantCapability } from '@/store/authStore';
import { useGroupStore } from '@/store/groupStore';
import { dashboardApi, type DashboardSummary, type DashboardTimeseriesPoint } from '@/api/dashboard.api';
import { groupsApi } from '@/api/groups.api';
import { useIpamLiveRefresh } from '@/hooks/useIpamLiveRefresh';
import { useAnonymize } from '@/utils/anonymize';
import { formatRelative } from '@/utils/formatRelative';
import { deviceTypeLabel } from '@/utils/deviceTypes';
import { PageContainer } from '@/components/common/PageContainer';
import { IconButton } from '@/components/common/IconButton';
import { LoadError } from '@/components/common/LoadError';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { HeroFeatured, HeroCard, CARD_SHADOW } from '@/components/dashboard/HeroCard';
import { ActivityChart, type ActivityPoint } from '@/components/dashboard/ActivityChart';
import { Donut, type DonutSlice } from '@/components/dashboard/Donut';
import { MiniStat } from '@/components/dashboard/MiniStat';
import { StatusCard } from '@/components/dashboard/StatusCard';
import { GroupCard, type GroupCardStats } from '@/components/dashboard/GroupCard';
import { cn } from '@/utils/cn';

// Dashboard on the shared Obli pattern (as in
// Obliance client/src/pages/DashboardPage.tsx): page header, 5 hero KPIs (the
// first featured with a sparkline), 14-day activity chart next to a donut,
// mini-stats row, 4 status cards and the recursive "by group" view. Every
// figure covers only the sites the user may read (server side); the probe
// widgets exist only for 'probes.manage' holders (summary.probes != null).

const TIMESERIES_DAYS = 14;
/** Days shown under the featured sparkline. */
const FEATURED_DAYS = 4;
/** Donut slices before the rest is folded into "Other". */
const DONUT_MAX_SLICES = 6;
/** A /24 at or above this use counts as saturated. */
const SATURATED_PCT = 80;
/** The summary lists the top 5 subnets only. */
const TOP_SUBNETS = 5;

/** Donut palette (CSS colors, readable on both themes). */
const DONUT_COLORS = [
  'rgb(var(--c-accent))',
  '#4f7bff',
  '#f5a623',
  '#a78bfa',
  '#22d3ee',
  '#f472b6',
  'rgb(var(--c-text-muted))',
];

/** YYYY-MM-DD (UTC) of now. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Short date of a YYYY-MM-DD (UTC) day in the UI language. */
function formatDay(day: string, lang: string, opts: Intl.DateTimeFormatOptions): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  try {
    return d.toLocaleDateString(lang, { ...opts, timeZone: 'UTC' });
  } catch {
    return day;
  }
}

/** /groups/stats row (the server also returns site / online / offline counts). */
interface GroupStatsRow {
  total: number;
  up: number;
  uptimePct: number;
  siteCount?: number;
  onlineCount?: number;
  offlineCount?: number;
}

/** Group tree pruned to the groups with figures (or with such descendants). */
interface GroupViewNode {
  id: number;
  name: string;
  stats: GroupCardStats | null;
  children: GroupViewNode[];
}

function buildGroupView(nodes: GroupTreeNode[], stats: Record<number, GroupCardStats>): GroupViewNode[] {
  const out: GroupViewNode[] = [];
  for (const node of nodes) {
    const children = buildGroupView(node.children ?? [], stats);
    // /groups/stats answers a (zero) row for every visible group: only a
    // group whose subtree holds readable sites has figures.
    const row = stats[node.id];
    const own = row && row.siteCount > 0 ? row : null;
    if (own || children.length > 0) out.push({ id: node.id, name: node.name, stats: own, children });
  }
  return out;
}

function renderGroupNode(node: GroupViewNode, depth: number): React.ReactNode {
  return (
    <div
      key={node.id}
      className="pl-[var(--gi-sm)] sm:pl-[var(--gi)]"
      style={{
        ['--gi' as string]: `${Math.min(depth, 4) * 18}px`,
        ['--gi-sm' as string]: `${Math.min(depth, 4) * 8}px`,
      } as React.CSSProperties}
    >
      <GroupCard groupId={node.id} name={node.name} stats={node.stats} depth={depth} />
      {node.children.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-2.5">
          {node.children.map((c) => renderGroupNode(c, depth + 1))}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const { anonymize } = useAnonymize();
  const canManageProbes = useTenantCapability('probes.manage');
  const canManageSites = useTenantCapability('sites.manage');

  const tree = useGroupStore((s) => s.tree);

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [series, setSeries] = useState<DashboardTimeseriesPoint[]>([]);
  const [groupStats, setGroupStats] = useState<Record<number, GroupCardStats> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [summaryError, setSummaryError] = useState(false);
  const [groupStatsError, setGroupStatsError] = useState(false);

  // Only the latest request may write the state (a tenant switch or a live
  // refresh can overlap a slower earlier one).
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setRefreshing(true);
    const [sumRes, tsRes, gsRes] = await Promise.allSettled([
      dashboardApi.summary(),
      dashboardApi.timeseries(TIMESERIES_DAYS),
      groupsApi.getStats(),
    ]);
    if (seq !== seqRef.current) return;

    if (sumRes.status === 'fulfilled') {
      setSummary(sumRes.value);
      setSummaryError(false);
    } else {
      // Keep the last good figures on a failed refresh; the error block (or
      // banner) offers a retry. Never fall back to the onboarding.
      setSummaryError(true);
    }
    if (tsRes.status === 'fulfilled') setSeries(tsRes.value);

    if (gsRes.status === 'fulfilled') {
      const rows = gsRes.value as Record<number, GroupStatsRow>;
      const mapped: Record<number, GroupCardStats> = {};
      for (const [id, r] of Object.entries(rows)) {
        mapped[Number(id)] = {
          total: Number(r.total) || 0,
          online: Number(r.onlineCount ?? r.up) || 0,
          offline: Number(r.offlineCount ?? 0) || 0,
          siteCount: Number(r.siteCount ?? 0) || 0,
        };
      }
      setGroupStats(mapped);
      setGroupStatsError(false);
    } else {
      setGroupStatsError(true);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live refresh: device / probe / site / tree events, socket resync and a
  // tenant switch (the hook watches the tenant epoch).
  useIpamLiveRefresh(() => void load(), 2000);

  // The group tree is normally loaded by the sidebar; the mobile drawer may
  // not be mounted, so load it once when it is still empty.
  useEffect(() => {
    if (useGroupStore.getState().tree.length === 0) void useGroupStore.getState().fetchTree();
  }, []);

  // ── Derived data ──
  const devices = summary?.devices ?? { total: 0, online: 0, offline: 0, reserved: 0 };

  // Today's snapshot may predate the latest scans: the live figures replace
  // the online / total counts of today's point.
  const points = useMemo(() => {
    if (!summary || series.length === 0) return series;
    const today = todayUtc();
    return series.map((p) =>
      p.day === today ? { ...p, hostsOnline: summary.devices.online, hostsTotal: summary.devices.total } : p,
    );
  }, [series, summary]);

  const lang = i18n.language || 'en';
  const featuredSeries = points.map((p) => p.hostsOnline);
  const featuredDays = points.slice(-FEATURED_DAYS).map((p) => ({
    short: formatDay(p.day, lang, { weekday: 'short' }),
    value: p.hostsOnline,
  }));
  const activityData: ActivityPoint[] = points.map((p) => ({
    label: formatDay(p.day, lang, { day: '2-digit', month: '2-digit' }),
    primary: p.hostsOnline,
    secondary: p.newHosts,
  }));

  const donut = useMemo(() => {
    const types = [...(summary?.deviceTypes ?? [])].filter((d) => d.count > 0).sort((a, b) => b.count - a.count);
    const total = types.reduce((s, d) => s + d.count, 0);
    const head = types.length > DONUT_MAX_SLICES ? types.slice(0, DONUT_MAX_SLICES - 1) : types;
    const rest = types.length > DONUT_MAX_SLICES ? types.slice(DONUT_MAX_SLICES - 1) : [];
    const slices: DonutSlice[] = head.map((d, i) => ({
      key: d.type,
      name: deviceTypeLabel(t, d.type),
      value: d.count,
      color: DONUT_COLORS[i % DONUT_COLORS.length],
      to: `/devices?type=${encodeURIComponent(d.type)}`,
    }));
    if (rest.length > 0) {
      slices.push({
        key: '__other',
        name: t('dashboard.donutOther', 'Other'),
        value: rest.reduce((s, d) => s + d.count, 0),
        color: DONUT_COLORS[DONUT_COLORS.length - 1],
        to: '/devices',
      });
    }
    return { slices, total };
  }, [summary, t]);

  const groupView = useMemo(
    () => (groupStats ? buildGroupView(tree, groupStats) : []),
    [tree, groupStats],
  );

  const welcome = user
    ? t('dashboard.welcomeBack', 'Welcome back, {{name}}', {
        name: anonymize(user.displayName || user.username, 'username'),
      })
    : undefined;

  const refreshButton = (
    <IconButton
      label={t('common.refresh', 'Refresh')}
      icon={<RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />}
      size="lg"
      onClick={() => void load()}
      disabled={refreshing}
    />
  );

  const pageProps = {
    title: t('dashboard.title', 'Dashboard'),
    subtitle: welcome,
    icon: <LayoutDashboard className="h-5 w-5" />,
    actions: refreshButton,
  };

  if (loading) {
    return (
      <PageContainer {...pageProps}>
        <div className="flex h-64 items-center justify-center">
          <LoadingSpinner />
        </div>
      </PageContainer>
    );
  }

  // A failed first load: retry block, never the onboarding.
  if (!summary) {
    return (
      <PageContainer {...pageProps}>
        <LoadError
          message={t('dashboard.loadFailed', 'The dashboard could not be loaded.')}
          onRetry={() => void load()}
        />
      </PageContainer>
    );
  }

  // Probes card: only for probes.manage holders (summary.probes != null).
  const probes = summary.probes;
  const probesTo =
    probes && probes.pending > 0 ? '/manage/discovery?tab=probes&status=pending' : '/manage/discovery?tab=probes';
  const probesApproved = probes ? probes.online + probes.offline : 0;
  const probesCard = probes ? (
    <StatusCard
      icon={<Radar size={16} />}
      label={t('dashboard.cardProbes', 'Probes')}
      primary={
        probes.pending > 0
          ? t('dashboard.pendingApproval', { count: probes.pending, defaultValue: '{{count}} probes waiting for approval' })
          : probesApproved === 0
            ? t('dashboard.noProbes', 'No probe yet')
            : probes.offline > 0
              ? t('dashboard.probesOffline', '{{count}} offline', { count: probes.offline })
              : t('dashboard.probesAllOnline', 'All probes online')
      }
      secondary={t('dashboard.probesOnlineOf', '{{online}} of {{total}} approved online', {
        online: probes.online,
        total: probesApproved,
      })}
      badge={`${probes.online}/${probesApproved}`}
      badgeColor={
        probes.offline > 0
          ? 'text-red-400'
          : probes.pending > 0
            ? 'text-amber-400'
            : probesApproved === 0
              ? 'text-text-muted'
              : 'text-green-400'
      }
      to={probesTo}
      linkLabel={
        probes.pending > 0 ? t('dashboard.reviewPending', 'Review pending probes') : t('dashboard.manageProbes', 'Manage probes')
      }
    />
  ) : null;

  // Members (and new tenants) without any readable site keep the explanation.
  // On a fresh install probes register (pending) before any site exists: the
  // probes card stays above the explanation so the admin sees them.
  if (summary.sites.total === 0) {
    return (
      <PageContainer {...pageProps}>
        {summaryError && (
          <LoadError className="mb-4 py-6" message={t('dashboard.refreshFailed', 'The dashboard could not be refreshed.')} onRetry={() => void load()} />
        )}
        {probes && probes.pending > 0 && <div className="mb-4 max-w-md">{probesCard}</div>}
        <EmptyState
          icon={<MapPin className="h-6 w-6" />}
          title={t('dashboard.noSites', 'No sites yet')}
          description={
            canManageSites
              ? t('dashboard.noSitesDesc', 'Create a site to represent a network location, then assign a probe to start discovering devices automatically.')
              : t('dashboard.noSitesMemberDesc', 'No site is available to you yet. Ask an administrator to give your team access to a site.')
          }
          action={
            canManageSites || canManageProbes ? (
              <>
                {canManageSites && (
                  <Link
                    to="/sites"
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
                  >
                    <MapPin size={14} />
                    {t('dashboard.createSite', 'Create a site')}
                  </Link>
                )}
                {canManageProbes && (
                  <Link
                    to="/manage/probes"
                    className="inline-flex items-center gap-1.5 rounded-md bg-bg-tertiary px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-bg-hover"
                  >
                    <Radar size={14} />
                    {t('dashboard.manageProbes', 'Manage probes')}
                  </Link>
                )}
              </>
            ) : undefined
          }
        />
      </PageContainer>
    );
  }

  // ── KPI texts ──
  const onlinePct = devices.total > 0 ? Math.round((devices.online / devices.total) * 100) : 0;
  const dOnline = summary.deltas.devicesOnline;
  const onlineDeltaText =
    dOnline == null
      ? t('dashboard.pctOfHosts', '{{pct}}% of {{total}} hosts', { pct: onlinePct, total: devices.total })
      : dOnline === 0
        ? t('dashboard.stableVsYesterday', 'stable vs yesterday')
        : t('dashboard.deltaVsYesterday', '{{count}} vs yesterday', { count: Math.abs(dOnline) });

  const dNew = summary.deltas.newDevices;
  const newDeltaText =
    dNew == null
      ? t('dashboard.inLast24h', 'in the last 24 h')
      : dNew === 0
        ? t('dashboard.stableVsYesterday', 'stable vs yesterday')
        : t('dashboard.deltaVsYesterday', '{{count}} vs yesterday', { count: Math.abs(dNew) });

  const checks = summary.checks;
  const failingChecks = checks ? checks.fail + checks.error : 0;
  const checksTotal = checks ? checks.ok + checks.fail + checks.error : 0;

  const saturated = summary.topSubnets.filter((s) => s.pct >= SATURATED_PCT).length;
  const densest = summary.topSubnets[0] ?? null;

  const lastScanText = formatRelative(summary.lastScanAt, t);

  return (
    <PageContainer {...pageProps} className="space-y-3.5">
      {summaryError && (
        <LoadError
          className="py-6"
          message={t('dashboard.refreshFailed', 'The dashboard could not be refreshed.')}
          onRetry={() => void load()}
        />
      )}

      {/* Hero row: featured hosts online + 4 KPIs, each a link to its list. */}
      <div className="grid grid-cols-1 items-stretch gap-3.5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
        <HeroFeatured
          to="/devices?status=online"
          label={t('dashboard.kpiHostsOnline', 'Hosts online')}
          value={devices.online}
          series={featuredSeries.length > 1 ? featuredSeries : [devices.online, devices.online]}
          days={featuredDays}
          delta={dOnline}
          deltaText={onlineDeltaText}
          sparklineLabel={t('dashboard.sparklineLabel', 'Hosts online over {{count}} days', { count: TIMESERIES_DAYS })}
        />
        <HeroCard
          to="/sites"
          label={t('dashboard.kpiSites', 'Sites')}
          value={summary.sites.total}
          color="text-text-primary"
          subStats={[
            { label: t('dashboard.subHosts', 'hosts'), value: devices.total },
            { label: t('dashboard.subOffline', 'offline'), value: devices.offline, color: devices.offline > 0 ? 'text-red-400' : undefined },
          ]}
        />
        <HeroCard
          to="/devices?new=24h"
          label={t('dashboard.kpiNewDevices', 'New devices 24 h')}
          value={summary.newDevices24h}
          color="text-blue-400"
          delta={dNew}
          deltaText={newDeltaText}
        />
        <HeroCard
          to="/devices?conflict=1"
          label={t('dashboard.kpiIpConflicts', 'IP conflicts')}
          value={summary.ipConflictsActive}
          color={summary.ipConflictsActive > 0 ? 'text-red-400' : 'text-text-muted'}
          deltaColor={summary.ipConflictsActive > 0 ? 'text-red-400' : undefined}
          deltaText={
            summary.ipConflictsActive > 0
              ? t('dashboard.activeAlerts', 'active alerts')
              : t('dashboard.noneActive', 'none active')
          }
        />
        <HeroCard
          to="/devices?checks=failing"
          label={t('dashboard.kpiFailingChecks', 'Failing checks')}
          value={checks ? failingChecks : '—'}
          color={failingChecks > 0 ? 'text-amber-400' : 'text-text-muted'}
          deltaColor={failingChecks > 0 ? 'text-amber-400' : undefined}
          deltaText={
            !checks
              ? t('dashboard.noCheckRule', 'no check rule enabled')
              : failingChecks === 0
                ? t('dashboard.allChecksPassing', 'all checks passing')
                : t('dashboard.checksAlerting', '{{count}} alerting', { count: checks.alerting })
          }
          barPct={checks && checksTotal > 0 ? (failingChecks / checksTotal) * 100 : undefined}
          barColor="#f5a623"
        />
      </div>

      {/* Activity chart (2/3) next to the device-type donut (1/3). */}
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-3">
        <div className={cn('rounded-xl bg-bg-secondary p-5 lg:col-span-2', CARD_SHADOW)}>
          <div className="mb-3">
            <div className="text-[15px] font-semibold text-text-primary">
              {t('dashboard.activityTitle', 'Hosts over {{count}} days', { count: TIMESERIES_DAYS })}
            </div>
            <div className="font-mono text-[11px] tracking-wider text-text-muted">
              {t('dashboard.activitySub', 'hosts online / new hosts · daily snapshots')}
            </div>
          </div>
          <ActivityChart
            data={activityData}
            ariaLabel={t('dashboard.activityTitle', 'Hosts over {{count}} days', { count: TIMESERIES_DAYS })}
          />
          <div className="mt-2 flex items-center gap-4 font-mono text-[11px] text-text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 bg-status-up" /> {t('dashboard.legendOnline', 'Hosts online')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 border-t border-dashed border-text-muted" /> {t('dashboard.legendNew', 'New hosts')}
            </span>
          </div>
        </div>

        <div className={cn('rounded-xl bg-bg-secondary p-5', CARD_SHADOW)}>
          <div className="mb-4">
            <div className="text-[15px] font-semibold text-text-primary">
              {t('dashboard.deviceTypesTitle', 'Device types')}
            </div>
            <div className="font-mono text-[11px] tracking-wider text-text-muted">
              {t('dashboard.deviceTypesSub', 'all readable sites')}
            </div>
          </div>
          {donut.total === 0 ? (
            <div className="py-6 text-center text-sm text-text-muted">{t('dashboard.noDevices', 'No device discovered yet')}</div>
          ) : (
            <Donut slices={donut.slices} total={donut.total} caption={t('dashboard.donutCaption', 'hosts')} />
          )}
        </div>
      </div>

      {/* Mini-stats row: every item links to the matching page. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <MiniStat
          icon={<WifiOff size={15} />}
          label={t('dashboard.miniOffline', 'Offline hosts')}
          value={devices.offline}
          color={devices.offline > 0 ? 'text-red-400' : 'text-text-primary'}
          to="/devices?status=offline"
        />
        <MiniStat
          icon={<Network size={15} />}
          label={t('dashboard.miniSaturated', 'Saturated subnets')}
          value={saturated >= TOP_SUBNETS ? `${TOP_SUBNETS}+` : saturated}
          sub={t('dashboard.miniSaturatedSub', '≥ {{pct}}% of a /24', { pct: SATURATED_PCT })}
          color={saturated > 0 ? 'text-amber-400' : 'text-text-primary'}
          to="/sites"
        />
        <MiniStat
          icon={<Clock size={15} />}
          label={t('dashboard.miniLastScan', 'Last scan')}
          value={lastScanText}
          to={canManageProbes ? '/manage/discovery?tab=probes' : '/sites'}
        />
        <MiniStat
          icon={<Bookmark size={15} />}
          label={t('dashboard.miniReserved', 'Reserved IPs')}
          value={devices.reserved}
          to="/devices?status=reserved"
        />
        <MiniStat
          icon={<Shuffle size={15} />}
          label={t('dashboard.miniInstability', 'IP instability')}
          value={summary.ipInstabilityActive}
          sub={t('dashboard.miniInstabilitySub', 'active alerts')}
          color={summary.ipInstabilityActive > 0 ? 'text-amber-400' : 'text-text-primary'}
          to="/devices?conflict=1"
        />
      </div>

      {/* Status cards. */}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-4">
        {densest ? (
          <StatusCard
            icon={<Network size={16} />}
            label={t('dashboard.cardDensest', 'Densest subnet')}
            primary={anonymize(densest.subnet, 'ip')}
            secondary={`${anonymize(densest.siteName, 'hostname')} · ${densest.used} / ${densest.usable}`}
            badge={`${Math.round(densest.pct)}%`}
            badgeColor={densest.pct >= SATURATED_PCT ? 'text-amber-400' : 'text-text-primary'}
            barPct={densest.pct}
            barColor={densest.pct >= SATURATED_PCT ? '#f5a623' : undefined}
            to={`/sites/${densest.siteId}?tab=heatmap`}
            linkLabel={t('dashboard.openHeatmap', 'Open the heatmap')}
          />
        ) : (
          <StatusCard
            icon={<Network size={16} />}
            label={t('dashboard.cardDensest', 'Densest subnet')}
            primary={t('dashboard.noSubnet', 'No subnet in use yet')}
            to="/sites"
            linkLabel={t('dashboard.viewSites', 'View sites')}
          />
        )}
        <StatusCard
          icon={<Clock size={16} />}
          label={t('dashboard.cardLastScan', 'Last scan')}
          primary={lastScanText}
          secondary={summary.lastScanAt ? new Date(summary.lastScanAt).toLocaleString(lang) : undefined}
          to="/sites"
          linkLabel={t('dashboard.viewSites', 'View sites')}
        />
        <StatusCard
          icon={<Sparkles size={16} />}
          label={t('dashboard.cardNewHosts', 'New hosts')}
          primary={t('dashboard.inLast24h', 'in the last 24 h')}
          secondary={dNew != null ? newDeltaText : undefined}
          badge={summary.newDevices24h}
          badgeColor={summary.newDevices24h > 0 ? 'text-blue-400' : 'text-text-muted'}
          to="/devices?new=24h"
          linkLabel={t('dashboard.viewDevices', 'View devices')}
        />
        {probesCard ?? (
          <StatusCard
            icon={<ShieldCheck size={16} />}
            label={t('dashboard.cardChecks', 'Device checks')}
            primary={
              !checks
                ? t('dashboard.noCheckRule', 'no check rule enabled')
                : t('dashboard.checksPassing', '{{count}} passing', { count: checks.ok })
            }
            secondary={checks ? t('dashboard.checksAlerting', '{{count}} alerting', { count: checks.alerting }) : undefined}
            badge={checks ? failingChecks : '—'}
            badgeColor={failingChecks > 0 ? 'text-amber-400' : 'text-text-muted'}
            to="/devices?checks=failing"
            linkLabel={t('dashboard.viewFailing', 'View failing checks')}
          />
        )}
      </div>

      {/* By group: recursive cards, root → children indented by depth. */}
      <div className={cn('rounded-xl bg-bg-secondary p-5', CARD_SHADOW)}>
        <div className="mb-4 flex items-center gap-2">
          <FolderTree size={16} className="shrink-0 text-accent" />
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-text-primary">{t('dashboard.groupView', 'By group')}</div>
            <div className="font-mono text-[11px] tracking-wider text-text-muted">
              {t('dashboard.groupViewSub', 'hosts online / total · sites')}
            </div>
          </div>
        </div>
        {groupStatsError && !groupStats ? (
          <LoadError className="bg-bg-tertiary py-6" onRetry={() => void load()} />
        ) : groupView.length === 0 ? (
          <div className="py-6 text-center text-sm text-text-muted">{t('dashboard.noGroups', 'No group with sites yet')}</div>
        ) : (
          <div className="flex flex-col gap-2.5">{groupView.map((g) => renderGroupNode(g, 0))}</div>
        )}
      </div>
    </PageContainer>
  );
}
