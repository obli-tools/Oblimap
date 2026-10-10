import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  MapPin, Plus, Pencil, Trash2, Loader2, RefreshCw, Folder, Search, X,
  Wifi, WifiOff, Monitor, Radar, AlertTriangle, LayoutGrid, List as ListIcon, ArrowUpDown,
  MousePointerClick, Check, FolderInput, MoreHorizontal,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { siteApi } from '../api/site.api';
import { groupsApi } from '../api/groups.api';
import { deviceChecksApi } from '../api/deviceChecks.api';
import type { Site, MonitorGroup, GroupTreeNode, DeviceCheckSiteSummary, PermissionLevel } from '@oblimap/shared';
import { clsx } from 'clsx';
import { useAnonymize } from '../utils/anonymize';
import { useIpamLiveRefresh } from '@/hooks/useIpamLiveRefresh';
import { useAuthStore, useFullAccess, useTenantCapability } from '@/store/authStore';
import { useGroupStore } from '@/store/groupStore';
import { SiteChecksSummary } from '@/components/deviceChecks/SiteChecksSummary';
import { useFreshSitePermissions } from '@/hooks/useFreshSitePermissions';
import { toastApiError } from '@/utils/apiError';
import { storageGet, storageSet } from '@/utils/safeStorage';
import { PageContainer } from '@/components/common/PageContainer';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadError } from '@/components/common/LoadError';
import { EmptyState } from '@/components/common/EmptyState';
import { TableScroll } from '@/components/common/TableScroll';
import { GroupPicker } from '@/components/common/GroupPicker';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { SiteModal, canWriteGroupChain } from '@/components/ipam/SiteModal';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { Modal } from '@/components/common/Modal';

/**
 * Write permission on a site, as the server computes it: full access
 * (platform admin or admin of the current tenant, useFullAccess), or a 'rw'
 * team permission on the site or on its group or any ancestor group.
 */
function canWriteSite(
  fullAccess: boolean,
  permissions: Record<string, PermissionLevel> | undefined,
  site: Site,
  groupsById: Map<number, MonitorGroup>,
): boolean {
  if (fullAccess) return true;
  if (!permissions) return false;
  if (permissions[`site:${site.id}`] === 'rw') return true;
  return canWriteGroupChain(permissions, site.groupId, groupsById);
}

// ─── Filters (kept in the URL: ?q=&groupId=&problems=1&sort=&view=) ──────────

type SortKey = 'name' | 'devices' | 'online';
type ViewMode = 'grid' | 'list';

const SORT_KEYS: readonly SortKey[] = ['name', 'devices', 'online'];
const VIEW_STORAGE_KEY = 'oblimap.sites.view';
const SEARCH_DEBOUNCE_MS = 250;

/** ?groupId= value: a group id, 'none' (ungrouped sites) or null (every group). */
type GroupFilter = number | 'none' | null;

function parseGroupFilter(raw: string | null): GroupFilter {
  if (raw === 'none') return 'none';
  if (raw && /^[1-9]\d{0,9}$/.test(raw)) return Number(raw);
  return null;
}

function readStoredView(): ViewMode {
  return storageGet(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'grid';
}

/** Share of online devices (0–100), null when the site has none. */
function onlinePct(site: Site): number | null {
  const total = site.itemCount ?? 0;
  if (total <= 0) return null;
  return Math.round(((site.onlineCount ?? 0) / total) * 100);
}

/** Offline devices or failing device checks. */
function hasProblems(site: Site, checks: DeviceCheckSiteSummary | undefined): boolean {
  if ((site.offlineCount ?? 0) > 0) return true;
  return !!checks && (checks.failing > 0 || checks.alerting > 0);
}

/** Group names by id, from the group store tree (fetched by the sidebar). */
function groupNamesFromTree(tree: GroupTreeNode[]): Map<number, string> {
  const names = new Map<number, string>();
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    names.set(node.id, node.name);
    for (const child of node.children ?? []) stack.push(child);
  }
  return names;
}

/** The group itself or one of its descendants (via the parent chain). */
function inGroupSubtree(groupId: number | null, rootId: number, groupsById: Map<number, MonitorGroup>): boolean {
  const seen = new Set<number>();
  let current = groupId;
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (current === rootId) return true;
    seen.add(current);
    current = groupsById.get(current)?.parentId ?? null;
  }
  return false;
}

// ─── Group chip ───────────────────────────────────────────────────────────────

function GroupChip({ groupId, name }: { groupId: number | null; name: string | undefined }) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  if (groupId === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted italic">
        {t('sites.ungrouped', 'Ungrouped')}
      </span>
    );
  }
  if (!name) return null;
  return (
    <Link
      to={`/group/${groupId}`}
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary hover:text-accent hover:bg-accent/10 transition-colors"
      title={t('sites.openGroup', 'Open the group')}
    >
      <Folder size={11} className="shrink-0 text-accent" />
      <span className="truncate">{anonymize(name, 'hostname')}</span>
    </Link>
  );
}

// ─── Site Card ────────────────────────────────────────────────────────────────

interface SiteViewProps {
  site: Site;
  /** Device check counts of the site (GET /device-checks/summary). */
  checks?: DeviceCheckSiteSummary;
  groupName: string | undefined;
  /** Absent: the user may not edit / delete this site. */
  onEdit?: (site: Site) => void;
  onDelete?: (site: Site) => void;
  /** Selection mode (Obliance "Select"): a click anywhere toggles the site instead of opening it. */
  selection?: { selected: boolean; toggle: () => void };
}

/** Click handler of a selectable card / row: links do not navigate, the site is toggled. */
function selectionCapture(selection: SiteViewProps['selection']) {
  if (!selection) return undefined;
  return (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    selection.toggle();
  };
}

/** Visual checkbox of a selectable card / row (the whole card is the click target). */
function SelectBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors',
        checked ? 'bg-accent text-white' : 'bg-bg-tertiary',
      )}
    >
      {checked && <Check size={13} />}
    </span>
  );
}

function SiteActions({ site, onEdit, onDelete }: Pick<SiteViewProps, 'site' | 'onEdit' | 'onDelete'>) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1 shrink-0">
      {onEdit && (
        <IconButton
          label={t('common.edit', 'Edit')}
          icon={<Pencil size={14} />}
          onClick={() => onEdit(site)}
        />
      )}
      {onDelete && (
        <IconButton
          label={t('common.delete', 'Delete')}
          icon={<Trash2 size={14} />}
          variant="danger"
          onClick={() => onDelete(site)}
        />
      )}
    </div>
  );
}

/**
 * Probes of a site: "online / approved" when the list carries the online
 * count (GET /sites onlineProbeCount), else the approved count.
 */
function ProbeCount({ site }: { site: Site }) {
  const { t } = useTranslation();
  const probes = site.probeCount ?? 0;
  if (probes === 0) return <>{t('sites.noProbes', 'No probes')}</>;
  if (site.onlineProbeCount === undefined) {
    return <>{t('sites.probeCount', { count: probes, defaultValue: '{{count}} probes' })}</>;
  }
  const online = Math.min(site.onlineProbeCount, probes);
  return (
    <span
      className={online < probes ? 'text-amber-400' : undefined}
      title={t('sites.probesOnlineHint', 'Approved probes of the site that are online')}
    >
      {t('sites.probesOnline', { online, count: probes, defaultValue: '{{online}}/{{count}} probes online' })}
    </span>
  );
}

function SiteCard({ site, checks, groupName, onEdit, onDelete, selection }: SiteViewProps) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const total = site.itemCount ?? 0;
  const online = site.onlineCount ?? 0;
  const offline = site.offlineCount ?? 0;

  return (
    <div
      onClickCapture={selectionCapture(selection)}
      role={selection ? 'checkbox' : undefined}
      aria-checked={selection ? selection.selected : undefined}
      className={clsx(
        'bg-bg-secondary rounded-xl shadow-[var(--shadow-card)] p-5 flex flex-col gap-4 transition-shadow hover:shadow-[var(--shadow-glow)]',
        selection && 'cursor-pointer select-none',
        selection?.selected && 'ring-2 ring-accent bg-accent/5',
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link to={`/sites/${site.id}`} className="group flex items-center gap-2 min-w-0">
            <MapPin size={18} className="text-accent shrink-0" />
            <p className="font-semibold text-text-primary group-hover:text-accent transition-colors truncate">
              {anonymize(site.name, 'hostname')}
            </p>
          </Link>
          {site.description && (
            <p className="text-xs text-text-muted truncate mt-0.5 pl-[26px]">{site.description}</p>
          )}
          <div className="mt-2 pl-[26px] min-w-0">
            <GroupChip groupId={site.groupId} name={groupName} />
          </div>
        </div>
        {selection ? <SelectBox checked={selection.selected} /> : <SiteActions site={site} onEdit={onEdit} onDelete={onDelete} />}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-bg-tertiary rounded-lg px-3 py-2 text-center">
          <p className="text-lg font-bold text-text-primary">{total}</p>
          <p className="text-xs text-text-muted flex items-center justify-center gap-1">
            <Monitor size={10} /> {t('sites.devices', 'Devices')}
          </p>
        </div>
        <div className="bg-bg-tertiary rounded-lg px-3 py-2 text-center">
          <p className={clsx('text-lg font-bold', online > 0 ? 'text-emerald-400' : 'text-text-muted')}>
            {online}
          </p>
          <p className="text-xs text-text-muted flex items-center justify-center gap-1">
            <Wifi size={10} /> {t('sites.online', 'Online')}
          </p>
        </div>
        <div className="bg-bg-tertiary rounded-lg px-3 py-2 text-center">
          <p className={clsx('text-lg font-bold', offline > 0 ? 'text-red-400' : 'text-text-muted')}>
            {offline}
          </p>
          <p className="text-xs text-text-muted flex items-center justify-center gap-1">
            <WifiOff size={10} /> {t('sites.offline', 'Offline')}
          </p>
        </div>
      </div>

      {/* Device checks */}
      <SiteChecksSummary counts={checks} variant="card" />

      {/* Footer */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted flex items-center gap-1">
          <Radar size={11} />
          <ProbeCount site={site} />
        </span>
        <Link
          to={`/sites/${site.id}`}
          className="text-xs text-accent hover:text-accent-hover transition-colors font-medium"
        >
          {t('sites.viewBtn', 'View →')}
        </Link>
      </div>
    </div>
  );
}

// ─── List view ────────────────────────────────────────────────────────────────

function SiteTable({ rows, selecting }: { rows: SiteViewProps[]; selecting: boolean }) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const th = 'px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-text-muted';
  return (
    <TableScroll className="bg-bg-secondary rounded-xl shadow-[var(--shadow-card)]" stickyFirstCol>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {selecting && <th className={clsx(th, 'w-10')}><span className="sr-only">{t('sites.selection.select', 'Select')}</span></th>}
            <th className={th}>{t('sites.colName', 'Site')}</th>
            <th className={th}>{t('sites.form.group', 'Group')}</th>
            <th className={clsx(th, 'text-right')}>{t('sites.devices', 'Devices')}</th>
            <th className={clsx(th, 'text-right')}>{t('sites.online', 'Online')}</th>
            <th className={clsx(th, 'text-right')}>{t('sites.offline', 'Offline')}</th>
            <th className={clsx(th, 'text-right')}>{t('sites.colOnlinePct', 'Online %')}</th>
            <th className={th}>{t('sites.colChecks', 'Checks')}</th>
            <th className={th}>{t('sites.colProbes', 'Probes')}</th>
            <th className={th}><span className="sr-only">{t('common.actions', 'Actions')}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ site, checks, groupName, onEdit, onDelete, selection }) => {
            const pct = onlinePct(site);
            const offline = site.offlineCount ?? 0;
            return (
              <tr
                key={site.id}
                onClickCapture={selectionCapture(selection)}
                aria-selected={selection ? selection.selected : undefined}
                className={clsx(
                  'border-b border-border last:border-b-0 hover:bg-bg-hover/50 transition-colors',
                  selection && 'cursor-pointer select-none',
                  selection?.selected && 'bg-accent/10',
                )}
              >
                {selection && (
                  <td className="px-4 py-2.5 w-10"><SelectBox checked={selection.selected} /></td>
                )}
                <td className="px-4 py-2.5 max-w-[18rem]">
                  <Link to={`/sites/${site.id}`} className="flex items-center gap-2 min-w-0 group">
                    <MapPin size={14} className="text-accent shrink-0" />
                    <span className="font-medium text-text-primary group-hover:text-accent truncate">
                      {anonymize(site.name, 'hostname')}
                    </span>
                  </Link>
                  {site.description && (
                    <p className="text-xs text-text-muted truncate pl-[22px]">{site.description}</p>
                  )}
                </td>
                <td className="px-4 py-2.5 max-w-[14rem]">
                  <GroupChip groupId={site.groupId} name={groupName} />
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-text-primary">{site.itemCount ?? 0}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-emerald-400">{site.onlineCount ?? 0}</td>
                <td className={clsx('px-4 py-2.5 text-right tabular-nums', offline > 0 ? 'text-red-400' : 'text-text-muted')}>
                  {offline}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-text-secondary">
                  {pct === null ? '—' : `${pct}%`}
                </td>
                <td className="px-4 py-2.5">
                  <SiteChecksSummary counts={checks} variant="card" />
                </td>
                <td className="px-4 py-2.5 text-xs text-text-muted whitespace-nowrap">
                  <ProbeCount site={site} />
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex justify-end">
                    {!selection && <SiteActions site={site} onEdit={onEdit} onDelete={onDelete} />}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function SitesPage() {
  const { t } = useTranslation();
  const { anonymize, isAnonymous } = useAnonymize();
  const confirm = useConfirm();
  const [sites, setSites] = useState<Site[]>([]);
  const [groups, setGroups] = useState<MonitorGroup[]>([]);
  const [loading, setLoading] = useState(true);
  // The last load failed: an error block with Retry replaces the grid / empty
  // state (a failed load must never look like "no sites yet").
  const [loadError, setLoadError] = useState(false);
  // Device check counts per site: one GET /device-checks/summary per load (not per card).
  const [checkSummaries, setCheckSummaries] = useState<Map<number, DeviceCheckSiteSummary>>(new Map());
  // Live refreshes can overlap: only the latest summary request is applied.
  const summarySeq = useRef(0);
  // undefined = modal closed, null = creating new site, Site = editing existing site
  const [modalSite, setModalSite] = useState<Site | null | undefined>(undefined);
  // Selection mode (Obliance "Select"): clicks select sites, a bar shows the count and the actions.
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<number | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);

  // Site create / delete take the 'sites.manage' tenant capability (delete
  // also write permission on the site); edit needs write permission on the site.
  // Full access (platform admin or admin of the current tenant) writes every site.
  const permissions = useAuthStore((s) => s.permissions?.permissions);
  const canManageSites = useTenantCapability('sites.manage');
  const fullAccess = useFullAccess();
  const groupsById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const tree = useGroupStore((s) => s.tree);
  // The sidebar (which normally loads the tree) is not mounted on phones / tablets.
  useEffect(() => {
    if (useGroupStore.getState().tree.length === 0) void useGroupStore.getState().fetchTree();
  }, []);
  const treeNames = useMemo(() => groupNamesFromTree(tree), [tree]);
  const groupNameOf = useCallback(
    (id: number | null) => (id === null ? undefined : treeNames.get(id) ?? groupsById.get(id)?.name),
    [treeNames, groupsById],
  );

  // ── URL filters ──
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const groupFilter = parseGroupFilter(searchParams.get('groupId'));
  const problemsOnly = searchParams.get('problems') === '1';
  const rawSort = searchParams.get('sort');
  const sort: SortKey = SORT_KEYS.includes(rawSort as SortKey) ? (rawSort as SortKey) : 'name';
  const rawView = searchParams.get('view');
  const view: ViewMode = rawView === 'list' || rawView === 'grid' ? rawView : readStoredView();

  const updateParams = useCallback((changes: Record<string, string | null>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Search input: typed locally, written to ?q= after a short pause.
  const [searchInput, setSearchInput] = useState(urlQuery);
  const lastPushedQuery = useRef(urlQuery);
  useEffect(() => {
    // Back / forward or a link changed ?q=: follow it.
    if (urlQuery !== lastPushedQuery.current) {
      lastPushedQuery.current = urlQuery;
      setSearchInput(urlQuery);
    }
  }, [urlQuery]);
  useEffect(() => {
    const value = searchInput.trim();
    if (value === lastPushedQuery.current) return undefined;
    const timer = window.setTimeout(() => {
      lastPushedQuery.current = value;
      updateParams({ q: value || null });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput, updateParams]);

  const setView = (next: ViewMode) => {
    storageSet(VIEW_STORAGE_KEY, next);
    updateParams({ view: next });
  };

  const load = useCallback(async () => {
    // Optional: the cards simply show no check summary when it fails.
    const mine = ++summarySeq.current;
    void deviceChecksApi.summary()
      .then((list) => {
        if (mine === summarySeq.current) setCheckSummaries(new Map(list.map((s) => [s.siteId, s])));
      })
      .catch(() => { /* keep the previous counts */ });
    try {
      const [siteRes, groupRes] = await Promise.all([siteApi.list(), groupsApi.list()]);
      setSites(siteRes.sites);
      setGroups(groupRes);
      setLoadError(false);
    } catch {
      setLoadError(true);
      toast.error(t('sites.failedLoad', 'Failed to load sites'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  // Auto-refresh when probe pushes arrive (devices going online/offline, new
  // discoveries), on a socket resync and on a tenant switch.
  useIpamLiveRefresh(() => void load());

  // A ?groupId= naming a group this tenant does not have (tenant switch, deleted
  // group, stale link) would hide every site: drop it once the groups are known.
  useEffect(() => {
    if (loading || loadError) return;
    if (typeof groupFilter === 'number' && !groupsById.has(groupFilter)) updateParams({ groupId: null });
  }, [loading, loadError, groupFilter, groupsById, updateParams]);

  // Re-check a stale permission map (tenant switch, sites created since it
  // was loaded) before hiding Edit on a site.
  useFreshSitePermissions(
    fullAccess,
    fullAccess ? [] : sites.filter((s) => !canWriteSite(false, permissions, s, groupsById)).map((s) => s.id),
  );

  async function handleDelete(site: Site) {
    const shownName = anonymize(site.name, 'hostname');
    const ok = await confirm({
      title: t('sites.deleteTitle', 'Delete site'),
      message: t('sites.confirmDelete', {
        name: shownName,
        defaultValue: 'Delete site "{{name}}"? This will also delete all its devices and reservations.',
      }),
      danger: true,
      // Type-to-confirm with the site name; in anonymous mode the name is
      // masked, so a fixed word is asked instead of revealing it.
      requireText: isAnonymous ? t('sites.deleteWord', 'DELETE') : site.name.trim(),
    });
    if (!ok) return;
    try {
      await siteApi.remove(site.id);
      toast.success(t('sites.deleted', 'Site deleted'));
      void load();
    } catch (err) {
      toastApiError(err, t('sites.failedDelete', 'Failed to delete site'));
    }
  }

  // ── Filtered + sorted list ──
  const visibleSites = useMemo(() => {
    const q = urlQuery.trim().toLowerCase();
    const filtered = sites.filter((site) => {
      if (q && !site.name.toLowerCase().includes(q) && !(site.description ?? '').toLowerCase().includes(q)) {
        return false;
      }
      if (groupFilter === 'none' && site.groupId !== null) return false;
      if (typeof groupFilter === 'number' && !inGroupSubtree(site.groupId, groupFilter, groupsById)) return false;
      if (problemsOnly && !hasProblems(site, checkSummaries.get(site.id))) return false;
      return true;
    });
    const byName = (a: Site, b: Site) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return filtered.sort((a, b) => {
      if (sort === 'devices') return (b.itemCount ?? 0) - (a.itemCount ?? 0) || byName(a, b);
      if (sort === 'online') {
        // Worst first; sites without devices last.
        const pa = onlinePct(a);
        const pb = onlinePct(b);
        if (pa === null && pb === null) return byName(a, b);
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pa - pb || byName(a, b);
      }
      return byName(a, b);
    });
  }, [sites, urlQuery, groupFilter, groupsById, problemsOnly, checkSummaries, sort]);

  const filtersActive = urlQuery !== '' || groupFilter !== null || problemsOnly;
  const problemCount = useMemo(
    () => sites.filter((s) => hasProblems(s, checkSummaries.get(s.id))).length,
    [sites, checkSummaries],
  );

  const rows: SiteViewProps[] = visibleSites.map((site) => {
    const writable = canWriteSite(fullAccess, permissions, site, groupsById);
    return {
      site,
      checks: checkSummaries.get(site.id),
      groupName: groupNameOf(site.groupId),
      onEdit: writable ? (s: Site) => setModalSite(s) : undefined,
      onDelete: canManageSites && writable ? (s: Site) => void handleDelete(s) : undefined,
      selection: selecting
        ? {
          selected: selectedIds.has(site.id),
          toggle: () => setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(site.id)) next.delete(site.id); else next.add(site.id);
            return next;
          }),
        }
        : undefined,
    };
  });

  // ── Bulk actions on the selection (only the visible selected sites act) ──
  const selectedSites = visibleSites.filter((s) => selectedIds.has(s.id));
  const writableSelected = selectedSites.filter((s) => canWriteSite(fullAccess, permissions, s, groupsById));
  const allVisibleSelected = visibleSites.length > 0 && visibleSites.every((s) => selectedIds.has(s.id));
  const toggleSelecting = () => {
    setSelecting((v) => !v);
    setSelectedIds(new Set());
  };
  const toggleAllVisible = () => {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(visibleSites.map((s) => s.id)));
  };

  async function runBulk(label: string, targets: Site[], fn: (site: Site) => Promise<unknown>) {
    setBulkRunning(true);
    let ok = 0;
    let failed = 0;
    for (const site of targets) {
      try { await fn(site); ok++; } catch { failed++; }
    }
    setBulkRunning(false);
    if (failed === 0) toast.success(t('sites.selection.done', { count: ok, action: label, defaultValue: '{{action}}: {{count}} site(s)' }));
    else toast.error(t('sites.selection.partial', { ok, failed, action: label, defaultValue: '{{action}}: {{ok}} done, {{failed}} failed' }));
    setSelectedIds(new Set());
    void load();
  }

  async function handleBulkMove() {
    const targets = writableSelected.filter((s) => (s.groupId ?? null) !== moveTarget);
    setMoveOpen(false);
    if (targets.length === 0) return;
    await runBulk(t('sites.selection.moved', 'Moved'), targets, (site) => siteApi.update(site.id, { groupId: moveTarget }));
  }

  async function handleBulkDelete() {
    const targets = canManageSites ? writableSelected : [];
    if (targets.length === 0) return;
    const ok = await confirm({
      title: t('sites.selection.deleteTitle', 'Delete sites'),
      message: t('sites.selection.deleteConfirm', { count: targets.length, defaultValue: 'Delete {{count}} site(s)? Their devices and reservations are deleted too.' }),
      danger: true,
      requireText: t('sites.deleteWord', 'DELETE'),
    });
    if (!ok) return;
    await runBulk(t('sites.selection.deleted', 'Deleted'), targets, (site) => siteApi.remove(site.id));
  }

  const bulkItems: ActionMenuItem[] = [
    {
      key: 'move',
      icon: <FolderInput size={15} />,
      label: t('sites.selection.moveTo', 'Move to group…'),
      description: t('sites.selection.count', { count: writableSelected.length, defaultValue: '{{count}} site(s)' }),
      onClick: () => { setMoveTarget(null); setMoveOpen(true); },
      hidden: writableSelected.length === 0,
    },
    {
      key: 'delete',
      icon: <Trash2 size={15} />,
      label: t('sites.selection.delete', 'Delete'),
      description: t('sites.selection.count', { count: writableSelected.length, defaultValue: '{{count}} site(s)' }),
      onClick: () => void handleBulkDelete(),
      hidden: !canManageSites || writableSelected.length === 0,
      danger: true,
      separator: true,
    },
  ];

  const clearFilters = () => {
    setSearchInput('');
    lastPushedQuery.current = '';
    updateParams({ q: null, groupId: null, problems: null });
  };

  const chipCls = (active: boolean) => clsx(
    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors coarse:min-h-11',
    active ? 'bg-accent/15 text-accent' : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="animate-spin text-accent" size={28} />
      </div>
    );
  }

  return (
    <PageContainer
      icon={<MapPin className="h-5 w-5" />}
      title={(
        <span className="inline-flex items-baseline gap-2">
          {t('sites.title', 'Sites')}
          <span className="text-sm font-normal text-text-muted">
            ({filtersActive ? `${visibleSites.length}/${sites.length}` : sites.length})
          </span>
        </span>
      )}
      actions={(
        <>
          <IconButton
            label={t('common.refresh', 'Refresh')}
            icon={<RefreshCw size={16} />}
            size="lg"
            onClick={() => void load()}
          />
          {canManageSites && (
            <Button size="sm" onClick={() => setModalSite(null)} className="gap-1.5">
              <Plus size={15} />
              {t('sites.newSite', 'New Site')}
            </Button>
          )}
        </>
      )}
    >
      {/* Toolbar */}
      {sites.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t('sites.searchPlaceholder', 'Search name or description…')}
              aria-label={t('common.search', 'Search')}
              className="w-full rounded-lg border border-border bg-bg-tertiary py-1.5 pl-9 pr-8 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            {searchInput && (
              <IconButton
                label={t('common.clear', 'Clear')}
                icon={<X size={14} />}
                size="sm"
                variant="plain"
                onClick={() => setSearchInput('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2"
              />
            )}
          </div>

          <div className="flex items-center gap-1 w-full sm:w-56">
            <div className="min-w-0 flex-1">
              <GroupPicker
                value={typeof groupFilter === 'number' ? groupFilter : null}
                onChange={(id) => updateParams({ groupId: id === null ? null : String(id) })}
                tree={tree}
                allowNone={false}
                placeholder={groupFilter === 'none'
                  ? t('sites.ungrouped', 'Ungrouped')
                  : t('sites.allGroups', 'All groups')}
              />
            </div>
            {groupFilter !== null && (
              <IconButton
                label={t('sites.allGroups', 'All groups')}
                icon={<X size={14} />}
                size="sm"
                onClick={() => updateParams({ groupId: null })}
              />
            )}
          </div>

          {fullAccess && (
            <button
              type="button"
              aria-pressed={groupFilter === 'none'}
              onClick={() => updateParams({ groupId: groupFilter === 'none' ? null : 'none' })}
              className={chipCls(groupFilter === 'none')}
            >
              <Folder size={14} />
              {t('sites.ungrouped', 'Ungrouped')}
            </button>
          )}

          <button
            type="button"
            aria-pressed={problemsOnly}
            onClick={() => updateParams({ problems: problemsOnly ? null : '1' })}
            className={chipCls(problemsOnly)}
            title={t('sites.withProblemsHint', 'Sites with offline devices or failing device checks')}
          >
            <AlertTriangle size={14} />
            {t('sites.withProblems', 'With problems')}
            {problemCount > 0 && (
              <span className="rounded-full bg-red-500/15 px-1.5 text-xs text-red-400 tabular-nums">{problemCount}</span>
            )}
          </button>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={toggleSelecting}
              aria-pressed={selecting}
              title={selecting
                ? t('sites.selection.exit', 'Exit selection mode')
                : t('sites.selection.enter', 'Selection mode — click any site to select it')}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors coarse:min-h-11',
                selecting ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              {selecting ? <Check size={14} /> : <MousePointerClick size={14} />}
              <span className="hidden sm:inline">{selecting ? t('sites.selection.active', 'Selecting') : t('sites.selection.select', 'Select')}</span>
            </button>
            <label className="inline-flex items-center gap-1.5 text-sm text-text-muted">
              <ArrowUpDown size={14} aria-hidden="true" />
              <span className="sr-only">{t('sites.sortBy', 'Sort by')}</span>
              <select
                value={sort}
                onChange={(e) => updateParams({ sort: e.target.value === 'name' ? null : e.target.value })}
                className="rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
              >
                <option value="name">{t('sites.sortName', 'Name')}</option>
                <option value="devices">{t('sites.sortDevices', 'Devices')}</option>
                <option value="online">{t('sites.sortOnline', 'Online %')}</option>
              </select>
            </label>
            <div className="inline-flex rounded-lg bg-bg-secondary p-0.5" role="group" aria-label={t('sites.viewMode', 'View')}>
              <IconButton
                label={t('sites.viewGrid', 'Grid')}
                icon={<LayoutGrid size={15} />}
                size="md"
                active={view === 'grid'}
                onClick={() => setView('grid')}
              />
              <IconButton
                label={t('sites.viewList', 'List')}
                icon={<ListIcon size={15} />}
                size="md"
                active={view === 'list'}
                onClick={() => setView('list')}
              />
            </div>
          </div>
        </div>
      )}

      {/* Selection bar — shown as soon as selection mode is on ("0 selected",
          Actions greyed out), so the page does not jump at the first click. */}
      {selecting && sites.length > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-lg bg-accent/10 p-2.5 max-md:flex-wrap">
          <button type="button" onClick={toggleAllVisible} aria-label={t('sites.selection.all', 'Select all')}>
            <SelectBox checked={allVisibleSelected} />
          </button>
          <span className="text-sm font-medium text-text-primary">
            {t('sites.selection.selected', { count: selectedSites.length, defaultValue: '{{count}} selected' })}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <ActionMenu
              items={bulkItems}
              label={t('sites.selection.actions', 'Actions')}
              trigger={(p) => (
                <button
                  {...p}
                  type="button"
                  disabled={bulkRunning || selectedSites.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
                >
                  {bulkRunning ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={14} />}
                  {t('sites.selection.actions', 'Actions')}
                </button>
              )}
            />
            {selectedSites.length > 0 && (
              <IconButton label={t('sites.selection.clear', 'Clear selection')} icon={<X size={14} />} size="sm" onClick={() => setSelectedIds(new Set())} />
            )}
          </div>
        </div>
      )}

      {/* The error block only replaces an empty grid: a failed live refresh
          keeps the sites already shown (the toast reports it). */}
      {loadError && sites.length === 0 ? (
        <LoadError
          message={t('sites.failedLoad', 'Failed to load sites')}
          onRetry={() => { setLoading(true); void load(); }}
        />
      ) : sites.length === 0 ? (
        <EmptyState
          icon={<MapPin className="h-6 w-6" />}
          title={t('sites.noSites', 'No sites yet')}
          description={t('sites.noSitesDesc', 'Sites are logical network locations. Create one to start tracking devices.')}
          action={canManageSites ? (
            <Button size="sm" onClick={() => setModalSite(null)} className="gap-1.5">
              <Plus size={15} />
              {t('sites.createFirst', 'Create your first site')}
            </Button>
          ) : undefined}
        />
      ) : visibleSites.length === 0 ? (
        <EmptyState
          icon={<Search className="h-6 w-6" />}
          title={t('sites.noMatch', 'No site matches these filters')}
          action={(
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              {t('common.clearFilters', 'Clear filters')}
            </Button>
          )}
        />
      ) : view === 'list' ? (
        <SiteTable rows={rows} selecting={selecting} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {rows.map((row) => (
            <SiteCard key={row.site.id} {...row} />
          ))}
        </div>
      )}

      <Modal
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        icon={<FolderInput className="h-4 w-4 text-accent" />}
        title={t('sites.selection.moveTitle', { count: writableSelected.length, defaultValue: 'Move {{count}} site(s)' })}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setMoveOpen(false)}>{t('common.cancel', 'Cancel')}</Button>
            <Button onClick={() => void handleBulkMove()} disabled={!fullAccess && moveTarget === null}>{t('sites.selection.move', 'Move')}</Button>
          </>
        )}
      >
        <div className="space-y-2">
          <p className="text-sm text-text-muted">{t('sites.selection.moveHint', 'Target group (sites you cannot edit are left out).')}</p>
          <GroupPicker value={moveTarget} onChange={setMoveTarget} tree={tree} allowNone={fullAccess}
            placeholder={t('sites.ungrouped', 'Ungrouped')} />
          {selectedSites.length > writableSelected.length && (
            <p className="text-xs text-text-muted">{t('sites.selection.readOnlySkipped', { count: selectedSites.length - writableSelected.length, defaultValue: '{{count}} read-only site(s) will not move.' })}</p>
          )}
        </div>
      </Modal>

      {/* Modal */}
      {modalSite !== undefined && (
        <SiteModal
          site={modalSite}
          groups={groups}
          defaultGroupId={typeof groupFilter === 'number' ? groupFilter : null}
          onClose={() => setModalSite(undefined)}
          onSaved={() => {
            setModalSite(undefined);
            void load();
          }}
        />
      )}
    </PageContainer>
  );
}
