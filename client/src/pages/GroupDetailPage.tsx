import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import {
  FolderOpen, Folder, FolderPlus, Settings2, MapPin, Wifi, WifiOff, Radar, Plus, Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { useAnonymize } from '@/utils/anonymize';
import { parseRouteId } from '@/utils/routeId';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore, useCanManageGroups, useTenantCapability } from '@/store/authStore';
import { groupsApi, type GroupDetailStats, type GroupSubtreeStats } from '@/api/groups.api';
import { siteApi, type SiteListItem } from '@/api/site.api';
import { useIpamLiveRefresh } from '@/hooks/useIpamLiveRefresh';
import { useUrlTab } from '@/hooks/useUrlTab';
import type { GroupTreeNode, MonitorGroup, Probe } from '@oblimap/shared';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { LoadError } from '@/components/common/LoadError';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/common/Button';
import { TableScroll } from '@/components/common/TableScroll';
import { usePrompt } from '@/components/common/ConfirmDialog';
import { ProbeStatusBadge, LastSeen } from '@/components/probes/ProbeStatusBadge';
import { SiteModal } from '@/components/ipam/SiteModal';
import { useGroupSiteActions } from '@/components/devices/GroupSitePanel';

type GroupLoadError = 'forbidden' | 'notFound' | 'error';

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

type Tab = 'sites' | 'subgroups' | 'probes';

const TAB_IDS: readonly Tab[] = ['sites', 'subgroups', 'probes'];

/**
 * Former tabs now living on the single group-settings page
 * (/group/:id/edit?section=…): ?tab=settings / ?tab=notifications deep links
 * (e.g. the device-check business-hours link) are redirected there.
 */
const MOVED_TABS = ['settings', 'notifications'] as const;
type MovedTab = typeof MOVED_TABS[number];

function findNode(nodes: GroupTreeNode[], id: number): GroupTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

/** Online share bar of a device count. */
function UptimeBar({ online, total }: { online: number; total: number }) {
  if (total <= 0) return null;
  const pct = Math.round((online / total) * 100);
  return (
    <div className="mb-2 h-1 w-full overflow-hidden rounded-full bg-bg-tertiary">
      <div
        className={cn(
          'h-full rounded-full transition-all',
          pct > 80 ? 'bg-emerald-500' : pct > 50 ? 'bg-yellow-400' : 'bg-red-500',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ─── Sites Tab ────────────────────────────────────────────────────────────────

/** Sites of the group and of its sub-groups (the scope of the stats and the probes tab). */
function SitesTab({ groupId, reloadKey, onNewSite }: {
  groupId: number;
  /** Bumped by the page after it changed the sites (new site). */
  reloadKey: number;
  /** Opens the new-site dialog (absent: the user may not create a site here). */
  onNewSite?: () => void;
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const getGroup = useGroupStore((s) => s.getGroup);
  useGroupStore((s) => s.groups);
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // A late answer for a previous group is dropped.
  const groupRef = useRef(groupId);
  groupRef.current = groupId;

  const load = useCallback(async () => {
    const forGroup = groupId;
    try {
      const res = await siteApi.list({ groupId: forGroup, includeDescendants: true });
      if (groupRef.current !== forGroup) return;
      setSites(res.sites);
      setLoadError(false);
    } catch {
      if (groupRef.current === forGroup) setLoadError(true);
    } finally {
      if (groupRef.current === forGroup) setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    setLoading(true);
    setSites([]);
    setLoadError(false);
    void load();
  }, [load, reloadKey]);

  const reload = useCallback(() => { void load(); }, [load]);
  useIpamLiveRefresh(reload);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  // A failed live refresh keeps the list already shown.
  if (loadError && sites.length === 0) {
    return (
      <LoadError
        message={t('sites.failedLoad', 'Failed to load sites')}
        onRetry={() => { setLoading(true); void load(); }}
      />
    );
  }

  if (sites.length === 0) {
    return (
      <EmptyState
        icon={<MapPin className="h-6 w-6" />}
        title={t('groups.detail.noSites', 'No sites in this group')}
        description={onNewSite
          ? t('groups.detail.noSitesCreate', 'Create a site in this group, or move an existing site here.')
          : t('groups.detail.noSitesDesc', 'Assign sites to this group when creating or editing them.')}
        action={onNewSite && (
          <Button size="sm" onClick={onNewSite}>
            <Plus size={14} className="mr-1.5" />
            {t('groups.detail.newSite', 'New site')}
          </Button>
        )}
      />
    );
  }

  const totalDevices = sites.reduce((s, x) => s + (x.itemCount ?? 0), 0);
  const totalOnline  = sites.reduce((s, x) => s + (x.onlineCount ?? 0), 0);
  const totalOffline = sites.reduce((s, x) => s + (x.offlineCount ?? 0), 0);

  return (
    <div>
      {/* Summary row */}
      <div className="mb-4 flex flex-wrap items-center gap-4 text-sm text-text-secondary">
        <span className="font-medium text-text-primary">{t('groups.detail.siteCount', { count: sites.length, defaultValue: '{{count}} sites' })}</span>
        <span>{t('siteDetail.statDevices', { count: totalDevices, defaultValue: '{{count}} devices' })}</span>
        <span className="flex items-center gap-1 text-emerald-400"><Wifi size={13} /> {t('groups.detail.onlineCount', { count: totalOnline, defaultValue: '{{count}} online' })}</span>
        {totalOffline > 0 && (
          <span className="flex items-center gap-1 text-red-400"><WifiOff size={13} /> {t('groups.detail.offlineCount', { count: totalOffline, defaultValue: '{{count}} offline' })}</span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sites.map((site) => {
          const total   = site.itemCount ?? 0;
          const online  = site.onlineCount ?? 0;
          const offline = site.offlineCount ?? 0;
          const probes  = site.probeCount ?? 0;
          const onlineProbes = site.onlineProbeCount;
          // A site of a sub-group: its group is named on the card.
          const subGroup = site.groupId !== null && site.groupId !== groupId ? getGroup(site.groupId) : undefined;

          return (
            <Link
              key={site.id}
              to={`/sites/${site.id}`}
              className="group block rounded-xl bg-bg-secondary p-4 shadow-sm transition-colors hover:bg-bg-hover"
            >
              <div className="mb-3 flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10">
                  <MapPin size={14} className="text-accent" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-text-primary transition-colors group-hover:text-accent">
                    {anonymize(site.name, 'hostname')}
                  </p>
                  {subGroup && (
                    <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-text-muted">
                      <Folder size={11} className="shrink-0" />
                      {anonymize(subGroup.name, 'hostname')}
                    </p>
                  )}
                  {site.description && (
                    <p className="mt-0.5 truncate text-xs text-text-muted">{site.description}</p>
                  )}
                </div>
              </div>

              {/* Device stats */}
              <div className="mb-2 flex items-center gap-3 text-xs text-text-secondary">
                <span>{t('siteDetail.statDevices', { count: total, defaultValue: '{{count}} devices' })}</span>
                {online > 0 && <span className="text-emerald-400">{t('groups.detail.onlineCount', { count: online, defaultValue: '{{count}} online' })}</span>}
                {offline > 0 && <span className="text-red-400">{t('groups.detail.offlineCount', { count: offline, defaultValue: '{{count}} offline' })}</span>}
              </div>

              <UptimeBar online={online} total={total} />

              {/* Probe count (online / total when the server reports it) */}
              {probes > 0 && (
                <div className="flex items-center gap-1 text-xs text-text-muted">
                  <Radar size={11} />
                  {onlineProbes !== undefined
                    ? t('groups.detail.probesOnline', '{{online}}/{{count}} probes online', { online: onlineProbes, count: probes })
                    : t('sites.probeCount', { count: probes, defaultValue: '{{count}} probes' })}
                </div>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ─── Sub-groups Tab ───────────────────────────────────────────────────────────

/** Direct sub-groups of the group (from the tree the user may see), with their subtree stats. */
function SubgroupsTab({ node, onNewSubgroup }: {
  node: GroupTreeNode | null;
  /** Creates a sub-group (absent: the user may not). */
  onNewSubgroup?: () => void;
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const groupStats = useGroupStore((s) => s.groupStats) as Record<number, GroupSubtreeStats | undefined>;
  const children = node?.children ?? [];

  if (children.length === 0) {
    return (
      <EmptyState
        icon={<Folder className="h-6 w-6" />}
        title={t('groups.detail.noSubgroups', 'No sub-groups')}
        description={t('groups.detail.noSubgroupsDesc', 'Sub-groups organise the sites of this group; their settings inherit from it.')}
        action={onNewSubgroup && (
          <Button size="sm" onClick={onNewSubgroup}>
            <FolderPlus size={14} className="mr-1.5" />
            {t('groups.addSubGroup', 'Add sub-group')}
          </Button>
        )}
      />
    );
  }

  return (
    <div>
      {onNewSubgroup && (
        <div className="mb-3 flex justify-end">
          <Button size="sm" variant="secondary" onClick={onNewSubgroup}>
            <FolderPlus size={14} className="mr-1.5" />
            {t('groups.addSubGroup', 'Add sub-group')}
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {children.map((child) => {
          const stats = groupStats[child.id];
          const total = stats?.total ?? 0;
          const online = stats?.up ?? 0;
          const offline = stats?.offlineCount ?? 0;
          const siteCount = stats?.siteCount ?? (child.sites?.length ?? 0);
          return (
            <Link
              key={child.id}
              to={`/group/${child.id}`}
              className="group block rounded-xl bg-bg-secondary p-4 shadow-sm transition-colors hover:bg-bg-hover"
            >
              <div className="mb-3 flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10">
                  <Folder size={14} className="text-accent" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-text-primary transition-colors group-hover:text-accent">
                    {anonymize(child.name, 'hostname')}
                  </p>
                  {child.description && (
                    <p className="mt-0.5 truncate text-xs text-text-muted">{child.description}</p>
                  )}
                </div>
              </div>
              <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
                <span>{t('groups.detail.siteCount', { count: siteCount, defaultValue: '{{count}} sites' })}</span>
                {child.children.length > 0 && (
                  <span>{t('groups.detail.subgroupCount', '{{count}} sub-groups', { count: child.children.length })}</span>
                )}
                <span>{t('siteDetail.statDevices', { count: total, defaultValue: '{{count}} devices' })}</span>
                {online > 0 && <span className="text-emerald-400">{t('groups.detail.onlineCount', { count: online, defaultValue: '{{count}} online' })}</span>}
                {offline > 0 && <span className="text-red-400">{t('groups.detail.offlineCount', { count: offline, defaultValue: '{{count}} offline' })}</span>}
              </div>
              <UptimeBar online={online} total={total} />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ─── Probes Tab ───────────────────────────────────────────────────────────────

interface GroupProbe extends Probe {
  siteName: string | null;
}

/** Probes of the sites of the group and its sub-groups, with the server's connectivity verdict. */
function ProbesTab({ groupId }: { groupId: number }) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  // The probe pages take the 'probes.manage' tenant capability.
  const canManageProbes = useTenantCapability('probes.manage');
  const [probes, setProbes] = useState<GroupProbe[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const groupRef = useRef(groupId);
  groupRef.current = groupId;

  const load = useCallback(async () => {
    const forGroup = groupId;
    try {
      const res = await groupsApi.getGroupProbes(forGroup);
      if (groupRef.current !== forGroup) return;
      setProbes(res.probes as GroupProbe[]);
      setLoadError(false);
    } catch {
      if (groupRef.current === forGroup) setLoadError(true);
    } finally {
      if (groupRef.current === forGroup) setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    setLoading(true);
    setProbes([]);
    setLoadError(false);
    void load();
  }, [load]);

  // Live refresh (PROBE_STATUS_CHANGED included), socket reconnect and tenant switch.
  const reload = useCallback(() => { void load(); }, [load]);
  useIpamLiveRefresh(reload);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  // A failed live refresh keeps the list already shown.
  if (loadError && probes.length === 0) {
    return (
      <LoadError
        message={t('probesPage.failedLoad', 'Failed to load probes')}
        onRetry={() => { setLoading(true); void load(); }}
      />
    );
  }

  if (probes.length === 0) {
    return (
      <EmptyState
        icon={<Radar className="h-6 w-6" />}
        title={t('groups.detail.noProbes', 'No probes in this group')}
        description={t('groups.detail.noProbesDesc', 'Probes will appear here when assigned to sites in this group.')}
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl bg-bg-secondary">
      <TableScroll>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg-tertiary/50 text-left text-xs uppercase tracking-wider text-text-muted">
              <th className="px-4 py-3">{t('groups.detail.colProbe', 'Probe')}</th>
              <th className="px-4 py-3">{t('groups.detail.colSite', 'Site')}</th>
              <th className="px-4 py-3">{t('groups.detail.colStatus', 'Status')}</th>
              <th className="px-4 py-3">{t('groups.detail.colLastSeen', 'Last seen')}</th>
            </tr>
          </thead>
          <tbody>
            {probes.map((probe) => (
              <tr key={probe.id} className="border-t border-border/50 transition-colors hover:bg-bg-hover/50">
                <td className="px-4 py-3">
                  {canManageProbes ? (
                    <Link
                      to={`/manage/probes/${probe.id}`}
                      className="font-medium text-text-primary transition-colors hover:text-accent"
                    >
                      {anonymize(probe.name || probe.hostname, 'hostname')}
                    </Link>
                  ) : (
                    <span className="font-medium text-text-primary">
                      {anonymize(probe.name || probe.hostname, 'hostname')}
                    </span>
                  )}
                  {probe.ip && (
                    <p className="mt-0.5 text-xs text-text-muted">{anonymize(probe.ip, 'ip')}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-text-secondary">
                  {probe.siteName && probe.siteId ? (
                    <Link to={`/sites/${probe.siteId}`} className="hover:text-accent">
                      {anonymize(probe.siteName, 'hostname')}
                    </Link>
                  ) : '-'}
                </td>
                <td className="px-4 py-3">
                  <ProbeStatusBadge probe={probe} />
                </td>
                <td className="px-4 py-3 text-xs text-text-muted">
                  <LastSeen ts={probe.lastSeenAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { anonymize } = useAnonymize();
  const prompt = usePrompt();
  const actions = useGroupSiteActions();

  // Strict id (an invalid one renders the not-found state).
  const groupId = parseRouteId(id) ?? 0;

  const [group, setGroup] = useState<MonitorGroup | null>(() => useGroupStore.getState().getGroup(groupId) ?? null);
  const [loading, setLoading] = useState(!group);
  const [loadError, setLoadError] = useState<GroupLoadError | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  // The store copy follows renames / moves made elsewhere (TREE_CHANGED).
  const storeGroup = useGroupStore((s) => s.groups.get(groupId));
  const tree = useGroupStore((s) => s.tree);
  const node = groupId > 0 ? findNode(tree, groupId) : null;

  // The group-settings page (/group/:id/edit) serves group writers and the
  // holders of 'settings' / 'notifications.manage' (the server enforces the
  // same capabilities on those routes; tenant admins hold them all).
  const canManageSettings = useTenantCapability('settings');
  const canManageNotifications = useTenantCapability('notifications.manage');
  const canManageSites = useTenantCapability('sites.manage');
  // Write permission on the group or an ancestor (re-evaluated when the
  // permissions or the tree are reloaded).
  useAuthStore((s) => s.permissions);
  const canEditGroup = groupId > 0 && useAuthStore.getState().canWriteGroup(groupId);
  const canOpenSettings = canEditGroup || canManageSettings || canManageNotifications;
  // New site: 'sites.manage' + write on the group (requireSiteCreateTarget).
  const canCreateSite = canManageSites && canEditGroup;
  const canCreateSubgroup = groupId > 0 && actions.canCreateUnder(groupId);
  const canManageGroups = useCanManageGroups();

  // Active tab: kept in ?tab= so a tab can be linked to (none = sites).
  const [activeTab, setActiveTab] = useUrlTab(TAB_IDS, 'sites');
  const [searchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');

  // ?tab=settings / ?tab=notifications: these moved to the group-settings
  // page. Users who may open it are sent to the matching section; the others
  // stay on the sites tab.
  useEffect(() => {
    if (rawTab === null || !(MOVED_TABS as readonly string[]).includes(rawTab)) return;
    if (groupId > 0 && canOpenSettings) {
      navigate(`/group/${groupId}/edit?section=${rawTab as MovedTab}`, { replace: true });
    } else {
      setActiveTab('sites');
    }
  }, [rawTab, groupId, canOpenSettings, navigate, setActiveTab]);

  // The tree (sub-groups, delete counts): the sidebar that normally loads it
  // is not mounted on phones.
  useEffect(() => {
    const store = useGroupStore.getState();
    if (store.tree.length === 0) void store.fetchTree();
    if (store.groups.size === 0) void store.fetchGroups();
    if (Object.keys(store.groupStats).length === 0) void store.fetchGroupStats();
  }, []);

  // Aggregate stats of the group and its sub-groups (every tab), and the
  // probe count. Reset on group change so nothing of the previous group
  // stays; a late answer for another group is dropped.
  const [stats, setStats] = useState<GroupDetailStats | null>(null);
  // Approved probes only (server detail-stats; null on an older server).
  const [probeCount, setProbeCount] = useState<number | null>(null);
  // Every probe the Probes tab lists (pending / refused / suspended included):
  // the tab badge uses this one so it always matches the rows.
  const [listedProbeCount, setListedProbeCount] = useState<number | null>(null);
  const statsGroupRef = useRef(groupId);
  statsGroupRef.current = groupId;

  const loadStats = useCallback(() => {
    if (groupId <= 0) return;
    const forGroup = groupId;
    groupsApi.detailStats(forGroup)
      .then((s) => {
        if (statsGroupRef.current !== forGroup) return;
        setStats(s);
        setProbeCount(typeof s.probeCount === 'number' ? s.probeCount : null);
      })
      .catch(() => { /* the bar stays hidden; the tabs report their own errors */ });
    groupsApi.getGroupProbes(forGroup)
      .then((res) => { if (statsGroupRef.current === forGroup) setListedProbeCount(res.probes.length); })
      .catch(() => { /* the count stays hidden */ });
  }, [groupId]);

  useEffect(() => {
    setStats(null);
    setProbeCount(null);
    setListedProbeCount(null);
    loadStats();
  }, [loadStats]);

  // Socket events, socket reconnect and tenant switch. The group store's tree
  // and subtree stats feed the Sub-groups tab: refetch them here too, since the
  // sidebar that normally does is not mounted on phones (both are debounced).
  useIpamLiveRefresh(useCallback(() => {
    loadStats();
    const store = useGroupStore.getState();
    void store.fetchTree();
    void store.fetchGroupStats();
  }, [loadStats]));

  // The group of the route (another group id: nothing of the previous one stays).
  useEffect(() => {
    let alive = true;
    const cached = useGroupStore.getState().getGroup(groupId);
    setLoadError(null);
    if (cached) {
      setGroup(cached);
      setLoading(false);
      return;
    }
    setGroup(null);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) {
      setLoadError('notFound');
      setLoading(false);
      return;
    }
    setLoading(true);
    groupsApi.getById(groupId)
      .then((g) => { if (alive) setGroup(g); })
      .catch((err: unknown) => {
        if (!alive) return;
        // 403: the group is not shown to this user; 404: not in this tenant.
        const status = httpStatus(err);
        if (status === 403) setLoadError('forbidden');
        else if (status === 404 || status === 400) setLoadError('notFound');
        else setLoadError('error');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [groupId, retryKey]);

  // New site (SiteModal) and the sites tab reload after it.
  const [showSiteModal, setShowSiteModal] = useState(false);
  const [sitesReloadKey, setSitesReloadKey] = useState(0);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const shown = storeGroup ?? group;

  if (!shown) {
    if (loadError === 'error') {
      return (
        <PageContainer>
          <LoadError
            message={t('groups.failedLoad', 'Failed to load group')}
            onRetry={() => setRetryKey((k) => k + 1)}
          />
        </PageContainer>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-text-muted">
          {loadError === 'forbidden'
            ? t('groups.forbidden', 'You do not have access to this group.')
            : t('groups.notFound', 'Group not found')}
        </p>
        <Link to="/" className="text-sm text-accent hover:underline">
          {t('groups.backToDashboard', 'Back to the dashboard')}
        </Link>
      </div>
    );
  }

  const handleDelete = async () => {
    const parentId = shown.parentId ?? null;
    if (await actions.deleteGroup(groupId)) {
      navigate(parentId !== null ? `/group/${parentId}` : '/', { replace: true });
    }
  };

  const handleNewSubgroup = async () => {
    const name = await prompt({
      title: t('groups.addSubGroup', 'Add sub-group'),
      message: t('groups.newSubgroupIn', 'New sub-group in "{{name}}"', { name: anonymize(shown.name, 'hostname') }),
      placeholder: t('groups.form.namePlaceholder', 'Group name'),
      confirmLabel: t('common.create', 'Create'),
      required: true,
    });
    if (name && name.trim()) await actions.createGroup(name, groupId);
  };

  const subgroupCount = node?.children.length ?? 0;
  const tabs: ReadonlyArray<SegmentedTab<Tab>> = [
    {
      id: 'sites',
      label: t('nav.sites', 'Sites'),
      icon: <MapPin size={15} />,
      badge: stats ? <span className="text-xs opacity-70">{stats.siteCount}</span> : undefined,
    },
    {
      id: 'subgroups',
      label: t('groups.detail.tabSubgroups', 'Sub-groups'),
      icon: <Folder size={15} />,
      badge: <span className="text-xs opacity-70">{subgroupCount}</span>,
    },
    {
      id: 'probes',
      label: t('groups.detail.tabProbesLabel', 'Probes'),
      icon: <Radar size={15} />,
      badge: listedProbeCount !== null ? <span className="text-xs opacity-70">{listedProbeCount}</span> : undefined,
    },
  ];

  const headerActions = (canOpenSettings || canCreateSite || canEditGroup) ? (
    <>
      {canCreateSite && (
        <Button size="sm" onClick={() => setShowSiteModal(true)}>
          <Plus size={14} className="mr-1.5" />
          {t('groups.detail.newSite', 'New site')}
        </Button>
      )}
      {canOpenSettings && (
        <Link to={`/group/${groupId}/edit`}>
          <Button size="sm" variant="secondary">
            <Settings2 size={14} className="mr-1.5" />
            {t('groups.settingsButton', 'Settings')}
          </Button>
        </Link>
      )}
      {canEditGroup && (
        <Button size="sm" variant="danger" onClick={() => { void handleDelete(); }}>
          <Trash2 size={14} className="mr-1.5" />
          {t('common.delete', 'Delete')}
        </Button>
      )}
    </>
  ) : undefined;

  return (
    <PageContainer
      title={anonymize(shown.name, 'hostname')}
      subtitle={shown.description || undefined}
      icon={<FolderOpen className="h-5 w-5" />}
      backTo={canManageGroups ? `/devices?groupId=${shown.id}` : '/'}
      actions={headerActions}
    >
      {/* Aggregate stats (group and sub-groups, readable sites only) */}
      {stats && (
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl bg-bg-secondary px-4 py-3 text-sm">
          <span className="flex items-center gap-1.5 text-text-secondary">
            <MapPin size={13} className="text-accent" />
            <span className="font-medium text-text-primary">{stats.siteCount}</span> {t('nav.sites', 'Sites').toLowerCase()}
          </span>
          <span className="flex items-center gap-1.5 text-text-secondary">
            <span className="font-medium text-text-primary">{stats.total}</span> {t('groups.detail.totalDevices', 'Total Devices').toLowerCase()}
          </span>
          <span className="flex items-center gap-1.5 text-emerald-400">
            <Wifi size={13} />
            <span className="font-medium">{stats.up}</span> {t('groups.detail.online', 'Online').toLowerCase()}
          </span>
          {stats.total - stats.up > 0 && (
            <span className="flex items-center gap-1.5 text-red-400">
              <WifiOff size={13} />
              <span className="font-medium">{stats.total - stats.up}</span> {t('groups.detail.offline', 'Offline').toLowerCase()}
            </span>
          )}
          {probeCount !== null ? (
            <span className="flex items-center gap-1.5 text-text-secondary">
              <Radar size={13} className="text-accent" />
              <span className="font-medium text-text-primary">{probeCount}</span> {t('groups.detail.approvedProbes', 'approved probes')}
            </span>
          ) : listedProbeCount !== null && (
            <span className="flex items-center gap-1.5 text-text-secondary">
              <Radar size={13} className="text-accent" />
              <span className="font-medium text-text-primary">{listedProbeCount}</span> {t('groups.detail.totalProbes', 'Total Probes').toLowerCase()}
            </span>
          )}
        </div>
      )}

      <SegmentedTabs
        tabs={tabs}
        value={activeTab}
        onChange={setActiveTab}
        fill={false}
        className="mb-4 w-fit max-w-full"
        ariaLabel={t('groups.detail.tabsLabel', 'Group sections')}
      />

      {activeTab === 'sites' && (
        <SitesTab
          groupId={groupId}
          reloadKey={sitesReloadKey}
          onNewSite={canCreateSite ? () => setShowSiteModal(true) : undefined}
        />
      )}
      {activeTab === 'subgroups' && (
        <SubgroupsTab
          node={node}
          onNewSubgroup={canCreateSubgroup ? () => { void handleNewSubgroup(); } : undefined}
        />
      )}
      {activeTab === 'probes' && <ProbesTab groupId={groupId} />}

      {showSiteModal && (
        <SiteModal
          defaultGroupId={groupId}
          onClose={() => setShowSiteModal(false)}
          onSaved={() => {
            setShowSiteModal(false);
            setSitesReloadKey((k) => k + 1);
            loadStats();
            void useGroupStore.getState().fetchTree();
            if (activeTab !== 'sites') setActiveTab('sites');
          }}
        />
      )}
    </PageContainer>
  );
}
