import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Settings,
  Users,
  MapPin,
  Monitor,
  History,
  ShieldCheck,
  Shield,
  Laptop,
  Radar,
  UserCircle,
  LogOut,
  PackageOpen,
  Building2,
  ChevronDown,
  ArrowLeftRight,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Pin,
  PinOff,
  Plus,
  Inbox,
  X,
  Search,
} from 'lucide-react';
import { SOCKET_EVENTS, type Site } from '@oblimap/shared';
import { siteApi } from '@/api/site.api';
import { itemsApi, type ItemListEntry } from '@/api/items.api';
import { dashboardApi } from '@/api/dashboard.api';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import {
  useAuthStore,
  usePageAccess,
  useTenantCapability,
  PAGE_ACCESS,
} from '@/store/authStore';
import { useUiStore } from '@/store/uiStore';
import { useTenantStore, useTenantEpoch } from '@/store/tenantStore';
import { useSocketStore } from '@/store/socketStore';
import { getSocket } from '@/socket/socketClient';
import { useIpamLiveRefresh } from '@/hooks/useIpamLiveRefresh';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useAnonymize } from '@/utils/anonymize';
import { IconButton } from '@/components/common/IconButton';
import { GroupTree } from '@/components/groups/GroupTree';
import { setSiteDragData } from '@/components/devices/GroupSitePanel';

// ── Nav items ────────────────────────────────────────────────────────────────

interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
  /**
   * The user may open the page: the route's gate in App.tsx (platform admin,
   * or the tenant capabilities the server enforces). Absent: everyone.
   */
  allowed?: boolean;
  /** Other path prefixes that belong to this entry (pages reached from the hub, old URLs). */
  match?: readonly string[];
  /** Pending-work count shown as a pill next to the label (hidden when 0). */
  badgeCount?: number;
}

function pathMatches(pathname: string, path: string): boolean {
  return pathname === path || (path !== '/' && pathname.startsWith(path + '/'));
}

function isItemActive(pathname: string, item: NavItem): boolean {
  return pathMatches(pathname, item.path) || (item.match ?? []).some((p) => pathMatches(pathname, p));
}

function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** Sidebar device search: minimum length, debounce, rows shown, server text limit. */
const DEVICE_SEARCH_MIN_LENGTH = 2;
const DEVICE_SEARCH_DEBOUNCE_MS = 300;
const DEVICE_SEARCH_LIMIT = 8;
const DEVICE_SEARCH_MAX_LENGTH = 100;

/** Debounce of the pending-probes badge reload (summary aggregates are not free). */
const PENDING_PROBES_DEBOUNCE_MS = 5000;

// ── Main Sidebar ──────────────────────────────────────────────────────────────

export interface SidebarProps {
  /**
   * 'pinned' = the desktop column (may collapse to the 64 px rail) ·
   * 'floating' = the auto-hide overlay · 'drawer' = inside the phone / tablet
   * off-canvas Drawer (AppLayout, < lg): full width, always expanded, a close
   * button instead of the collapse / float toggles, no resize handle.
   * Default: from the stored floating preference.
   */
  variant?: 'pinned' | 'floating' | 'drawer';
}

export function Sidebar({ variant }: SidebarProps = {}) {
  const { t } = useTranslation();
  const location = useLocation();
  const { user } = useAuthStore();
  const { anonymize } = useAnonymize();
  const {
    sidebarFloating: storedFloating, toggleSidebarFloating,
    sidebarCollapsed: storedCollapsed, toggleSidebarCollapsed,
    openAddProbeModal, setMobileNavOpen,
  } = useUiStore();

  const effectiveVariant = variant ?? (storedFloating ? 'floating' : 'pinned');
  const inDrawer = effectiveVariant === 'drawer';
  const sidebarFloating = effectiveVariant === 'floating';
  // The drawer is always the full, expanded sidebar (the stored preference is untouched).
  const sidebarCollapsed = effectiveVariant === 'pinned' && storedCollapsed;

  const closeDrawer = useCallback(() => setMobileNavOpen(false), [setMobileNavOpen]);

  // Same gates as the routes (App.tsx): PAGE_ACCESS. Groups are managed in
  // the /devices panel (GroupSitePanel): no separate Groups entry.
  const canProbes = usePageAccess(PAGE_ACCESS.probes);
  const canPolicies = usePageAccess(PAGE_ACCESS.policies);
  const canUsers = usePageAccess(PAGE_ACCESS.users);
  const canSecurity = usePageAccess(PAGE_ACCESS.security);
  const canSupervision = usePageAccess(PAGE_ACCESS.supervision);
  const canDiscovery = usePageAccess(PAGE_ACCESS.discovery);
  const canTenants = usePageAccess(PAGE_ACCESS.tenants);
  const canImportExport = usePageAccess(PAGE_ACCESS.importExport);
  const canSettings = usePageAccess(PAGE_ACCESS.settings);
  // The pending-probes badge: only for the holders of 'probes.manage' (the
  // server returns pendingProbes: null to the others).
  const canManageProbes = useTenantCapability('probes.manage');

  const [pendingProbes, setPendingProbes] = useState(0);

  const navItems: NavItem[] = [
    { label: t('nav.dashboard'), path: '/',         icon: <LayoutDashboard size={18} /> },
    // Also the home of the group management (GroupSitePanel; /groups redirects here).
    { label: t('nav.devices', 'Devices'), path: '/devices', icon: <Monitor size={18} />, match: ['/manage/groups'] },
    { label: t('nav.sites'),     path: '/sites',    icon: <MapPin size={18} /> },
    { label: t('nav.history', 'History'), path: '/history', icon: <History size={18} /> },
    {
      label: t('nav.policies', 'Policies'), path: '/policies', icon: <ShieldCheck size={18} />,
      allowed: canPolicies, match: ['/manage/device-checks', '/notifications'],
    },
  ];

  const adminNavItems: NavItem[] = [
    { label: t('nav.users'), path: '/manage/users', icon: <Users size={18} />, allowed: canUsers },
    {
      label: t('nav.security', 'Security'), path: '/manage/security', icon: <Shield size={18} />,
      allowed: canSecurity, match: ['/manage/audit'],
    },
    {
      label: t('nav.supervision', 'Supervision'), path: '/manage/supervision', icon: <Laptop size={18} />,
      allowed: canSupervision,
    },
    {
      label: t('nav.discovery', 'Discovery'), path: '/manage/discovery', icon: <Radar size={18} />,
      allowed: canDiscovery,
      match: ['/manage/probes', '/manage/vendor-rules', '/manage/mac-vendors'],
      badgeCount: canManageProbes ? pendingProbes : undefined,
    },
    {
      label: t('nav.workspace', 'Workspace'), path: '/workspace', icon: <Building2 size={18} />,
      allowed: canTenants, match: ['/manage/tenants'],
    },
    // Import / export keeps its own entry until it is embedded in Settings
    // (it needs more capabilities than the Settings page).
    { label: t('nav.importExport'), path: '/manage/import-export', icon: <PackageOpen size={18} />, allowed: canImportExport },
    { label: t('nav.settings'), path: '/settings', icon: <Settings size={18} />, allowed: canSettings },
  ];

  const [search, setSearch] = useState('');
  const [navMenuOpen, setNavMenuOpen] = usePersistedState<boolean>('sidebar:nav-open', true);
  const [adminMenuOpen, setAdminMenuOpen] = usePersistedState<boolean>('sidebar:admin-open', true);
  const [ungroupedOpen, setUngroupedOpen] = usePersistedState<boolean>('sidebar:ungrouped-open', true);
  // Stacked or side-by-side ("split"); the phone drawer is always stacked.
  const [storedSidebarLayout, setSidebarLayout] = usePersistedState<'stacked' | 'side-by-side'>('sidebar:layout', 'stacked');
  const sidebarLayout = inDrawer ? 'stacked' : storedSidebarLayout;
  const [splitPercent, setSplitPercent] = usePersistedState<number>('sidebar:split-percent', 50);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      if (!splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPercent(Math.max(20, Math.min(80, pct)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [setSplitPercent]);
  const [ungroupedSites, setUngroupedSites] = useState<Site[]>([]);
  const [ungroupedError, setUngroupedError] = useState(false);
  const tenantEpoch = useTenantEpoch();

  // ── Device search (GET /api/items, the sites the user may read): after 2
  // characters, debounced 300 ms, the previous request aborted.
  const deviceQuery = search.trim().slice(0, DEVICE_SEARCH_MAX_LENGTH);
  const [deviceHits, setDeviceHits] = useState<ItemListEntry[]>([]);
  const [deviceTotal, setDeviceTotal] = useState(0);
  const [deviceSearching, setDeviceSearching] = useState(false);
  const [deviceSearchError, setDeviceSearchError] = useState(false);
  useEffect(() => {
    if (deviceQuery.length < DEVICE_SEARCH_MIN_LENGTH) {
      setDeviceHits([]);
      setDeviceTotal(0);
      setDeviceSearching(false);
      setDeviceSearchError(false);
      return;
    }
    const ctrl = new AbortController();
    setDeviceSearching(true);
    const timer = setTimeout(() => {
      itemsApi.list({ q: deviceQuery, pageSize: DEVICE_SEARCH_LIMIT }, ctrl.signal)
        .then((res) => {
          if (ctrl.signal.aborted) return;
          setDeviceHits(res.items);
          setDeviceTotal(res.total);
          setDeviceSearchError(false);
          setDeviceSearching(false);
        })
        .catch(() => {
          if (ctrl.signal.aborted) return;
          setDeviceHits([]);
          setDeviceTotal(0);
          setDeviceSearchError(true);
          setDeviceSearching(false);
        });
    }, DEVICE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // tenantEpoch: a tenant switch searches that tenant's devices.
  }, [deviceQuery, tenantEpoch]);

  const isVisible = (item: NavItem) => item.allowed !== false;
  // The Administration section shows when one of its pages is open to the user.
  const showAdminSection = adminNavItems.some(isVisible);
  // Adding a probe lists the probe API keys ('probes.manage').
  const canAddProbe = canProbes;

  // The Add Probe modal sits below the drawer: close the drawer first.
  const handleAddProbe = () => {
    if (inDrawer) closeDrawer();
    openAddProbeModal();
  };

  // Load ungrouped sites (sites with no group assigned). A response is applied
  // only when it is the latest request and the tenant has not changed since
  // it was sent (rapid double switches).
  const loadSeqRef = useRef(0);
  const loadUngroupedSites = useCallback(() => {
    const seq = ++loadSeqRef.current;
    const epochAtStart = useTenantStore.getState().epoch;
    const isCurrent = () =>
      seq === loadSeqRef.current && epochAtStart === useTenantStore.getState().epoch;
    siteApi.list({ ungrouped: true })
      .then(({ sites }) => {
        if (!isCurrent()) return;
        setUngroupedSites(sites);
        setUngroupedError(false);
      })
      .catch(() => {
        if (!isCurrent()) return;
        setUngroupedError(true);
      });
  }, []);

  // Mount and tenant switch: the previous tenant's list must not stay on screen.
  useEffect(() => {
    setUngroupedSites([]);
    setUngroupedError(false);
    loadUngroupedSites();
  }, [tenantEpoch, loadUngroupedSites]);

  // Live refresh on site / device / hierarchy events and socket resync.
  useIpamLiveRefresh(loadUngroupedSites);

  // ── Pending probes badge (Discovery) ──
  const canManageProbesRef = useRef(canManageProbes);
  canManageProbesRef.current = canManageProbes;
  const pendingSeqRef = useRef(0);
  const loadPendingProbes = useCallback(() => {
    const seq = ++pendingSeqRef.current;
    if (!canManageProbesRef.current) {
      setPendingProbes(0);
      return;
    }
    const epochAtStart = useTenantStore.getState().epoch;
    dashboardApi.summary()
      .then((summary) => {
        if (seq !== pendingSeqRef.current || epochAtStart !== useTenantStore.getState().epoch) return;
        setPendingProbes(summary.pendingProbes ?? 0);
      })
      .catch(() => { /* badge only: keep the last known count */ });
  }, []);

  // Mount, tenant switch, capability gained / lost.
  useEffect(() => {
    setPendingProbes(0);
    loadPendingProbes();
  }, [tenantEpoch, canManageProbes, loadPendingProbes]);

  // Only the probe lifecycle events can change the pending count (approval,
  // registration / deletion of a probe row): the site / device events of
  // useIpamLiveRefresh would recompute the whole dashboard summary on every
  // push. A socket resync re-subscribes here and reloads once.
  const socketStatus = useSocketStore((s) => s.status);
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !canManageProbes) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; loadPendingProbes(); }, PENDING_PROBES_DEBOUNCE_MS);
    };
    const events = [
      SOCKET_EVENTS.PROBE_APPROVED,
      SOCKET_EVENTS.PROBE_DEVICE_UPDATED,
      SOCKET_EVENTS.PROBE_DEVICE_DELETED,
    ];
    for (const ev of events) socket.on(ev, schedule);
    return () => {
      if (timer) clearTimeout(timer);
      for (const ev of events) socket.off(ev, schedule);
    };
  }, [socketStatus, canManageProbes, loadPendingProbes]);

  // Socket reconnected: probe events may have been missed.
  useEffect(() => {
    const onResync = () => loadPendingProbes();
    window.addEventListener('oblimap:resync', onResync);
    return () => window.removeEventListener('oblimap:resync', onResync);
  }, [loadPendingProbes]);

  // Slow fallback poll, in case an event was missed.
  useEffect(() => {
    const interval = setInterval(() => {
      loadUngroupedSites();
      loadPendingProbes();
    }, 60000);
    return () => clearInterval(interval);
  }, [loadUngroupedSites, loadPendingProbes]);

  const renderNavLink = (item: NavItem) => {
    if (!isVisible(item)) return null;
    const isActive = isItemActive(location.pathname, item);
    return (
      <Link
        key={item.path}
        to={item.path}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'flex items-center gap-3 rounded-md px-3 py-2 text-[14px] transition-colors coarse:py-2.5',
          isActive
            ? 'bg-accent/12 text-accent'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        )}
      >
        {item.icon}
        <span className="flex-1 truncate">{item.label}</span>
        {item.badgeCount !== undefined && item.badgeCount > 0 && (
          <span
            className="shrink-0 min-w-[1.25rem] rounded-full border border-red-500/30 bg-red-500/20 px-1.5 py-0.5 text-center text-[10px] font-semibold text-red-400"
            title={t('nav.pendingProbes', '{{count}} probe(s) waiting for approval', { count: item.badgeCount })}
          >
            {badgeText(item.badgeCount)}
          </span>
        )}
      </Link>
    );
  };

  const rawUsername = user?.username ?? '';
  const cleanUsername = rawUsername.startsWith('og_') ? rawUsername.slice(3) : rawUsername;
  // Reproduce the Obliview footer convention: the headline uses displayName
  // (falling back to the cleaned username when missing); the sub-line shows
  // `username · role` in mono.
  const displayedName = anonymize(user?.displayName || cleanUsername, 'username');
  const subLineUsername = anonymize(cleanUsername, 'username');

  // ── Collapsed mode (Obli Design v1) ─────────────────────────────────
  // 64 px icon-only column. Navigation items keep their tooltips, the
  // device tree + search are hidden, the user avatar + logout stay
  // visible at the bottom.
  if (sidebarCollapsed) {
    const allItems = [
      ...navItems,
      ...adminNavItems,
    ].filter(isVisible);
    return (
      <aside className="flex h-full w-16 shrink-0 flex-col bg-bg-secondary">
        <div className="flex h-9 shrink-0 items-center justify-center pt-2">
          <button
            onClick={toggleSidebarCollapsed}
            title={t('nav.expandSidebar', 'Expand sidebar')}
            aria-label={t('nav.expandSidebar', 'Expand sidebar')}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <ChevronsRight size={16} />
          </button>
        </div>

        {canAddProbe && (
          <div className="px-2 pt-1">
            <button
              onClick={handleAddProbe}
              title={t('nav.addProbe')}
              aria-label={t('nav.addProbe')}
              className="flex h-10 w-full items-center justify-center rounded-md bg-accent/12 text-accent transition-colors hover:bg-accent/20"
            >
              <Plus size={16} />
            </button>
          </div>
        )}

        <nav className="flex-1 overflow-y-auto px-2 pt-3 space-y-1">
          {allItems.map((item) => {
            const isActive = isItemActive(location.pathname, item);
            const hasBadge = item.badgeCount !== undefined && item.badgeCount > 0;
            return (
              <Link
                key={item.path}
                to={item.path}
                title={hasBadge ? `${item.label} (${badgeText(item.badgeCount!)})` : item.label}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'relative flex h-10 w-full items-center justify-center rounded-md transition-colors',
                  isActive
                    ? 'bg-accent/12 text-accent'
                    : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
                )}
              >
                {item.icon}
                {hasBadge && (
                  <span className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-red-400" aria-hidden="true" />
                )}
              </Link>
            );
          })}
        </nav>

        {/* User row pinned bottom — avatar from Obligate */}
        <div className="p-2 space-y-1">
          <Link
            to="/profile"
            title={displayedName}
            className={cn(
              'flex h-10 w-full items-center justify-center rounded-md transition-colors',
              location.pathname === '/profile'
                ? 'bg-bg-active text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            {user?.avatar ? (
              <img src={user.avatar} alt="" className="w-6 h-6 rounded-full object-cover" />
            ) : (
              <UserCircle size={18} />
            )}
          </Link>
          <button
            onClick={() => useAuthStore.getState().logout()}
            title={t('nav.signOut')}
            aria-label={t('nav.signOut')}
            className="flex h-10 w-full items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-bg-secondary">

      {/* Sidebar head — collapse + float/pin toggles (a close button in the
          drawer). The logo and tenant selector live in the topbar
          (Header.tsx) so they remain visible when the sidebar is collapsed
          or floating. */}
      <div className="flex h-9 shrink-0 items-center justify-end px-3 pt-2 coarse:h-auto">
        {inDrawer ? (
          <IconButton
            label={t('nav.closeMenu', 'Close menu')}
            icon={<X className="h-4 w-4" />}
            size="md"
            onClick={closeDrawer}
          />
        ) : (
          <div className="flex items-center gap-1">
            {!sidebarFloating && (
              <button
                onClick={toggleSidebarCollapsed}
                title={t('nav.collapseSidebar', 'Collapse sidebar')}
                aria-label={t('nav.collapseSidebar', 'Collapse sidebar')}
                className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                <ChevronsLeft size={15} />
              </button>
            )}
            <button
              onClick={toggleSidebarFloating}
              title={sidebarFloating ? t('nav.pinSidebar', 'Pin sidebar') : t('nav.floatSidebar', 'Float sidebar (auto-hide)')}
              aria-label={sidebarFloating ? t('nav.pinSidebar', 'Pin sidebar') : t('nav.floatSidebar', 'Float sidebar (auto-hide)')}
              className={cn(
                'p-1.5 rounded transition-colors',
                sidebarFloating
                  ? 'text-accent hover:text-accent hover:bg-accent/10'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
              )}
            >
              {sidebarFloating ? <PinOff size={15} /> : <Pin size={15} />}
            </button>
          </div>
        )}
      </div>

      {/* Add Probe button — accent pill */}
      {canAddProbe && (
        <div className="shrink-0 px-3 pt-2">
          <button
            onClick={handleAddProbe}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-accent/12 hover:bg-accent/20 px-3 py-2 text-[13px] font-medium text-accent transition-colors coarse:py-2.5"
          >
            <Plus size={15} />
            {t('nav.addProbe')}
          </button>
        </div>
      )}

      {/* Search */}
      <div className="shrink-0 px-3 py-2.5">
        <input
          type="search"
          placeholder={t('sidebar.searchPlaceholder', 'Search sites, groups, devices…')}
          aria-label={t('common.search', 'Search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full rounded-md bg-bg-tertiary px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Layout (Obliance): stacked = Navigation pinned on top, the Sites
          tree scrolls in the middle, Administration pinned at the bottom
          (both foldable); side-by-side ("split") = Navigation + Administration
          in the left column, Sites in the right one, resizable. The phone
          drawer is always stacked. */}
      {sidebarLayout === 'side-by-side' ? (
        <div ref={splitContainerRef} className="flex min-h-0 flex-1 flex-row overflow-hidden">
          {/* ── Navigation + Administration column ── */}
          <div className="flex min-w-0 flex-col overflow-y-auto overscroll-contain px-2" style={{ width: `${splitPercent}%` }}>
            {/* Main nav — collapsible (Obliance): folding it leaves more room
                for the group tree. Persisted. */}
            <button
              onClick={() => setNavMenuOpen(v => !v)}
              className="flex w-full shrink-0 items-center gap-2 px-1 py-1.5 text-text-muted hover:text-text-secondary transition-colors coarse:py-2.5"
              aria-expanded={navMenuOpen}
              title={navMenuOpen ? t('nav.collapseNav', 'Collapse navigation') : t('nav.expandNav', 'Expand navigation')}
            >
              <ChevronDown size={12} className={cn('transition-transform duration-200', !navMenuOpen && '-rotate-90')} />
              <span className="text-[10px] font-mono uppercase tracking-[0.14em]">{t('nav.navigation', 'Navigation')}</span>
              <div className="flex-1 h-px bg-border" />
            </button>
            {navMenuOpen && (
              <nav className="shrink-0 pb-1 space-y-0.5">
                {navItems.map(renderNavLink)}
              </nav>
            )}

            {/* Administration section — collapsible, shown when one of its hubs
                is open to the user. Inside the scroll region (see above). */}
            {showAdminSection && (
              <div className="mt-1">
                <button
                  onClick={() => setAdminMenuOpen(v => !v)}
                  className="flex w-full items-center gap-2 px-1 py-1.5 text-text-muted hover:text-text-secondary transition-colors coarse:py-2.5"
                  aria-expanded={adminMenuOpen}
                  title={adminMenuOpen ? t('nav.collapseAdmin', 'Collapse administration') : t('nav.expandAdmin', 'Expand administration')}
                >
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-[10px] font-mono uppercase tracking-[0.14em]">
                    {t('nav.administration', 'Administration')}
                  </span>
                  <ChevronDown size={12} className={cn('transition-transform duration-200', !adminMenuOpen && '-rotate-90')} />
                  <div className="flex-1 h-px bg-border" />
                </button>

                {adminMenuOpen && (
                  <nav className="pb-1 space-y-0.5">
                    {adminNavItems.map(renderNavLink)}
                  </nav>
                )}
              </div>
            )}

          </div>

          {/* ── Resize handle ── */}
          <div
            onMouseDown={handleSplitMouseDown}
            className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent/50 active:bg-accent/70"
          />

          {/* ── Sites column ── */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between px-3 py-1.5">
              <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-text-muted">{t('nav.sites', 'Sites')}</span>
              <button
            type="button"
            onClick={() => setSidebarLayout('stacked')}
            title={t('nav.switchStacked', 'Switch to stacked')}
            aria-label={t('nav.switchStacked', 'Switch to stacked')}
            className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary coarse:min-h-10 coarse:min-w-10 coarse:inline-flex coarse:items-center coarse:justify-center"
          >
            <ArrowLeftRight size={12} />
          </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2">
            {/* Devices matching the search (IP, MAC, name, vendor…) in any readable site */}
            {deviceQuery.length >= DEVICE_SEARCH_MIN_LENGTH && (
              <div className="mb-1" aria-live="polite">
                <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">
                  <Search size={11} />
                  <span className="flex-1">{t('sidebar.devices', 'Devices')}</span>
                  {deviceSearching && (
                    <span className="normal-case tracking-normal">{t('common.loading', 'Loading…')}</span>
                  )}
                </div>
                {!deviceSearching && deviceHits.length === 0 && (
                  <p className="px-3 py-1 text-xs text-text-muted">
                    {deviceSearchError
                      ? t('sidebar.deviceSearchFailed', 'Device search unavailable')
                      : t('sidebar.noDevice', 'No matching device')}
                  </p>
                )}
                {deviceHits.map((d) => {
                  const name = d.customName ?? d.hostname;
                  const to = `/sites/${d.siteId}/devices/${d.id}`;
                  return (
                    <Link
                      key={d.id}
                      to={to}
                      title={d.mac ? anonymize(d.mac, 'mac') : undefined}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors coarse:py-2.5',
                        location.pathname === to
                          ? 'bg-bg-active text-text-primary'
                          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                      )}
                    >
                      <Monitor size={13} className="shrink-0 text-accent" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-mono">{anonymize(d.ip, 'ip')}</span>
                        {name && <span> · {anonymize(name, 'hostname')}</span>}
                        <span className="text-text-muted"> · {anonymize(d.siteName, 'hostname')}</span>
                      </span>
                    </Link>
                  );
                })}
                {deviceTotal > deviceHits.length && (
                  <Link
                    to={`/devices?q=${encodeURIComponent(deviceQuery)}`}
                    className="block px-3 py-1 text-xs text-accent hover:underline"
                  >
                    {t('sidebar.allDeviceResults', 'See all {{count}} devices', { count: deviceTotal })}
                  </Link>
                )}
              </div>
            )}

            {/* Group tree — shows group hierarchy for navigating to sites within groups */}
            <div className="flex flex-col gap-0">
              <GroupTree searchQuery={search} />

              {/* Ungrouped sites — a failed load shows a retry link, not an empty list */}
              {ungroupedError && ungroupedSites.length === 0 && (
                <div className="mt-1 flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-muted">
                  <Inbox size={11} className="shrink-0" />
                  <span className="truncate">{t('sidebar.ungroupedLoadFailed', 'Ungrouped sites unavailable')}</span>
                  <button
                    type="button"
                    onClick={loadUngroupedSites}
                    className="shrink-0 text-accent hover:underline"
                  >
                    {t('common.retry', 'Retry')}
                  </button>
                </div>
              )}

              {/* Ungrouped sites — sites with no group assigned */}
              {ungroupedSites.length > 0 && (() => {
                const filtered = search
                  ? ungroupedSites.filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
                  : ungroupedSites;
                if (filtered.length === 0) return null;
                return (
                  <div className="mt-1">
                    {/* Collapsible like a group of the tree (Obliance); a search keeps it open. */}
                    <button
                      type="button"
                      onClick={() => setUngroupedOpen((v) => !v)}
                      aria-expanded={ungroupedOpen || !!search}
                      className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors coarse:py-2.5"
                    >
                      <ChevronRight size={14} className={cn('shrink-0 transition-transform', (ungroupedOpen || !!search) && 'rotate-90')} />
                      <Inbox size={14} className="shrink-0 text-text-muted" />
                      <span className="flex-1 truncate text-left">{t('sidebar.ungrouped', 'Ungrouped')}</span>
                      <span className="shrink-0 text-[10px] text-text-muted">{filtered.length}</span>
                    </button>
                    {(ungroupedOpen || !!search) && filtered.map((site) => {
                      const isActive = location.pathname === `/sites/${site.id}`;
                      const total = site.itemCount ?? 0;
                      const online = site.onlineCount ?? 0;
                      // Draggable onto a group of the tree (GroupNode / GroupSitePanel accept the drop).
                      const draggable = useAuthStore.getState().canWriteSite(site.id, null);
                      return (
                        <Link
                          key={site.id}
                          to={`/sites/${site.id}`}
                          draggable={draggable || undefined}
                          onDragStart={draggable ? (e) => setSiteDragData(e, { id: site.id, name: site.name, groupId: null }) : undefined}
                          className={cn(
                            'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors coarse:py-2.5',
                            isActive
                              ? 'bg-bg-active text-text-primary'
                              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                          )}
                        >
                          <MapPin size={13} className="shrink-0 text-accent" />
                          <span className="truncate flex-1">{anonymize(site.name, 'hostname')}</span>
                          {total > 0 && (
                            <span
                              className={cn(
                                'shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                                online === total
                                  ? 'bg-status-up-bg text-status-up'
                                  : online > total * 0.5
                                    ? 'bg-yellow-500/10 text-yellow-500'
                                    : 'bg-status-down-bg text-status-down',
                              )}
                            >
                              {online}/{total}
                            </span>
                          )}
                        </Link>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Navigation — pinned on top (folds). */}
          <div className="max-h-[45%] shrink-0 overflow-y-auto overscroll-contain px-2">
            {/* Main nav — collapsible (Obliance): folding it leaves more room
                for the group tree. Persisted. */}
            <button
              onClick={() => setNavMenuOpen(v => !v)}
              className="flex w-full shrink-0 items-center gap-2 px-1 py-1.5 text-text-muted hover:text-text-secondary transition-colors coarse:py-2.5"
              aria-expanded={navMenuOpen}
              title={navMenuOpen ? t('nav.collapseNav', 'Collapse navigation') : t('nav.expandNav', 'Expand navigation')}
            >
              <ChevronDown size={12} className={cn('transition-transform duration-200', !navMenuOpen && '-rotate-90')} />
              <span className="text-[10px] font-mono uppercase tracking-[0.14em]">{t('nav.navigation', 'Navigation')}</span>
              <div className="flex-1 h-px bg-border" />
            </button>
            {navMenuOpen && (
              <nav className="shrink-0 pb-1 space-y-0.5">
                {navItems.map(renderNavLink)}
              </nav>
            )}

          </div>

          {/* Sites — the only part that scrolls with the content. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2">
            {!inDrawer && (
              <div className="flex items-center justify-end">
                <button
            type="button"
            onClick={() => setSidebarLayout('side-by-side')}
            title={t('nav.switchSideBySide', 'Switch to side-by-side')}
            aria-label={t('nav.switchSideBySide', 'Switch to side-by-side')}
            className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary coarse:min-h-10 coarse:min-w-10 coarse:inline-flex coarse:items-center coarse:justify-center"
          >
            <ArrowLeftRight size={12} />
          </button>
              </div>
            )}
            {/* Devices matching the search (IP, MAC, name, vendor…) in any readable site */}
            {deviceQuery.length >= DEVICE_SEARCH_MIN_LENGTH && (
              <div className="mb-1" aria-live="polite">
                <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">
                  <Search size={11} />
                  <span className="flex-1">{t('sidebar.devices', 'Devices')}</span>
                  {deviceSearching && (
                    <span className="normal-case tracking-normal">{t('common.loading', 'Loading…')}</span>
                  )}
                </div>
                {!deviceSearching && deviceHits.length === 0 && (
                  <p className="px-3 py-1 text-xs text-text-muted">
                    {deviceSearchError
                      ? t('sidebar.deviceSearchFailed', 'Device search unavailable')
                      : t('sidebar.noDevice', 'No matching device')}
                  </p>
                )}
                {deviceHits.map((d) => {
                  const name = d.customName ?? d.hostname;
                  const to = `/sites/${d.siteId}/devices/${d.id}`;
                  return (
                    <Link
                      key={d.id}
                      to={to}
                      title={d.mac ? anonymize(d.mac, 'mac') : undefined}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors coarse:py-2.5',
                        location.pathname === to
                          ? 'bg-bg-active text-text-primary'
                          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                      )}
                    >
                      <Monitor size={13} className="shrink-0 text-accent" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-mono">{anonymize(d.ip, 'ip')}</span>
                        {name && <span> · {anonymize(name, 'hostname')}</span>}
                        <span className="text-text-muted"> · {anonymize(d.siteName, 'hostname')}</span>
                      </span>
                    </Link>
                  );
                })}
                {deviceTotal > deviceHits.length && (
                  <Link
                    to={`/devices?q=${encodeURIComponent(deviceQuery)}`}
                    className="block px-3 py-1 text-xs text-accent hover:underline"
                  >
                    {t('sidebar.allDeviceResults', 'See all {{count}} devices', { count: deviceTotal })}
                  </Link>
                )}
              </div>
            )}

            {/* Group tree — shows group hierarchy for navigating to sites within groups */}
            <div className="flex flex-col gap-0">
              <GroupTree searchQuery={search} />

              {/* Ungrouped sites — a failed load shows a retry link, not an empty list */}
              {ungroupedError && ungroupedSites.length === 0 && (
                <div className="mt-1 flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-muted">
                  <Inbox size={11} className="shrink-0" />
                  <span className="truncate">{t('sidebar.ungroupedLoadFailed', 'Ungrouped sites unavailable')}</span>
                  <button
                    type="button"
                    onClick={loadUngroupedSites}
                    className="shrink-0 text-accent hover:underline"
                  >
                    {t('common.retry', 'Retry')}
                  </button>
                </div>
              )}

              {/* Ungrouped sites — sites with no group assigned */}
              {ungroupedSites.length > 0 && (() => {
                const filtered = search
                  ? ungroupedSites.filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
                  : ungroupedSites;
                if (filtered.length === 0) return null;
                return (
                  <div className="mt-1">
                    {/* Collapsible like a group of the tree (Obliance); a search keeps it open. */}
                    <button
                      type="button"
                      onClick={() => setUngroupedOpen((v) => !v)}
                      aria-expanded={ungroupedOpen || !!search}
                      className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors coarse:py-2.5"
                    >
                      <ChevronRight size={14} className={cn('shrink-0 transition-transform', (ungroupedOpen || !!search) && 'rotate-90')} />
                      <Inbox size={14} className="shrink-0 text-text-muted" />
                      <span className="flex-1 truncate text-left">{t('sidebar.ungrouped', 'Ungrouped')}</span>
                      <span className="shrink-0 text-[10px] text-text-muted">{filtered.length}</span>
                    </button>
                    {(ungroupedOpen || !!search) && filtered.map((site) => {
                      const isActive = location.pathname === `/sites/${site.id}`;
                      const total = site.itemCount ?? 0;
                      const online = site.onlineCount ?? 0;
                      // Draggable onto a group of the tree (GroupNode / GroupSitePanel accept the drop).
                      const draggable = useAuthStore.getState().canWriteSite(site.id, null);
                      return (
                        <Link
                          key={site.id}
                          to={`/sites/${site.id}`}
                          draggable={draggable || undefined}
                          onDragStart={draggable ? (e) => setSiteDragData(e, { id: site.id, name: site.name, groupId: null }) : undefined}
                          className={cn(
                            'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors coarse:py-2.5',
                            isActive
                              ? 'bg-bg-active text-text-primary'
                              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                          )}
                        >
                          <MapPin size={13} className="shrink-0 text-accent" />
                          <span className="truncate flex-1">{anonymize(site.name, 'hostname')}</span>
                          {total > 0 && (
                            <span
                              className={cn(
                                'shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                                online === total
                                  ? 'bg-status-up-bg text-status-up'
                                  : online > total * 0.5
                                    ? 'bg-yellow-500/10 text-yellow-500'
                                    : 'bg-status-down-bg text-status-down',
                              )}
                            >
                              {online}/{total}
                            </span>
                          )}
                        </Link>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

          </div>

          {/* Administration — pinned at the bottom (folds). */}
          <div className="max-h-[45%] shrink-0 overflow-y-auto overscroll-contain px-2">
            {/* Administration section — collapsible, shown when one of its hubs
                is open to the user. Inside the scroll region (see above). */}
            {showAdminSection && (
              <div className="mt-1">
                <button
                  onClick={() => setAdminMenuOpen(v => !v)}
                  className="flex w-full items-center gap-2 px-1 py-1.5 text-text-muted hover:text-text-secondary transition-colors coarse:py-2.5"
                  aria-expanded={adminMenuOpen}
                  title={adminMenuOpen ? t('nav.collapseAdmin', 'Collapse administration') : t('nav.expandAdmin', 'Expand administration')}
                >
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-[10px] font-mono uppercase tracking-[0.14em]">
                    {t('nav.administration', 'Administration')}
                  </span>
                  <ChevronDown size={12} className={cn('transition-transform duration-200', !adminMenuOpen && '-rotate-90')} />
                  <div className="flex-1 h-px bg-border" />
                </button>

                {adminMenuOpen && (
                  <nav className="pb-1 space-y-0.5">
                    {adminNavItems.map(renderNavLink)}
                  </nav>
                )}
              </div>
            )}

          </div>
        </>
      )}

      {/* User section — Obliview-style footer: displayName headline + mono
          `username · role` sub-line, avatar from Obligate. */}
      <div className="shrink-0 p-2 mt-1 space-y-0.5">
        <Link
          to="/profile"
          className={cn(
            'flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors',
            location.pathname === '/profile'
              ? 'bg-accent/10'
              : 'hover:bg-bg-hover',
          )}
        >
          {user?.avatar ? (
            <img src={user.avatar} alt="" className="w-7 h-7 rounded-full object-cover shrink-0" />
          ) : (
            <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 bg-accent/20 text-accent text-[11px] font-semibold">
              {(displayedName?.[0] ?? '?').toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-text-primary">
              {displayedName}
            </div>
            <div className="truncate font-mono text-[10px] text-text-muted">
              {subLineUsername} · {user?.role ?? ''}
            </div>
          </div>
        </Link>
        <button
          onClick={() => useAuthStore.getState().logout()}
          className="mt-1 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary coarse:py-2.5"
        >
          <LogOut size={14} />
          <span>{t('nav.signOut')}</span>
        </button>
      </div>
    </aside>
  );
}
