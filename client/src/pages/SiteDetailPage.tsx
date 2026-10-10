import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { siteApi, type SiteProbe } from '../api/site.api';
import type { Site, SiteItem, IpReservation, DeviceCheckAlertState } from '@oblimap/shared';
import { SubnetHeatmap, type HeatmapTarget } from '@/components/ipam/SubnetHeatmap';
import { NetworkStarmap } from '@/components/ipam/NetworkStarmap';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { NotificationBindingsPanel } from '@/components/notifications/NotificationBindingsPanel';
import { NotificationBindingsGuard } from '@/components/notifications/NotificationBindingsGuard';
import TunnelDialog from '@/components/ipam/TunnelDialog';
import { DeviceChecksDrawer } from '@/components/deviceChecks/DeviceChecksDrawer';
import { SiteChecksSummary, summarizeItemChecks } from '@/components/deviceChecks/SiteChecksSummary';
import {
  DevicesTab, ALERT_STATES, isCheckSummary, positiveInt, sortChecks, upsertCheck,
} from '@/components/ipam/site/DevicesTab';
import { ReservationsTab } from '@/components/ipam/site/ReservationsTab';
import { ReservationModal, type ReservationPrefill } from '@/components/ipam/site/ReservationModal';
import { SiteHeader } from '@/components/ipam/site/SiteHeader';
import { SiteProbesTab } from '@/components/ipam/site/SiteProbesTab';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { LoadError } from '@/components/common/LoadError';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useUrlTab } from '@/hooks/useUrlTab';
import {
  findGroupNode, groupPathTo, sitePermissionLevel, useFreshSitePermissions,
} from '@/hooks/useFreshSitePermissions';
import { getSocket, reconnectSocket } from '@/socket/socketClient';
import { useAuthStore, useFullAccess, useTenantCapability } from '@/store/authStore';
import { useGroupStore } from '@/store/groupStore';
import { useTenantStore } from '@/store/tenantStore';
import { locateSite } from '@/api/tenantLocate.api';
import { useAnonymize } from '@/utils/anonymize';
import { toastApiError } from '@/utils/apiError';
import { SOCKET_EVENTS } from '@oblimap/shared';

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type Tab = 'devices' | 'reservations' | 'heatmap' | 'map' | 'probes' | 'settings' | 'notifications';

/** ?tab= values: the tabs, plus 'networkMap' (the map tab's former id, kept for old links). */
const URL_TABS = ['devices', 'reservations', 'heatmap', 'map', 'probes', 'settings', 'notifications', 'networkMap'] as const;

type SiteLoadError = 'forbidden' | 'notFound' | 'error';

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function SiteDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const siteId = positiveInt(id) ?? 0;
  const [searchParams, setSearchParams] = useSearchParams();

  // Platform admin or admin of the current tenant: 'rw' on every site.
  const fullAccess = useFullAccess();
  const permissions = useAuthStore((s) => s.permissions?.permissions);
  const groupTree = useGroupStore((s) => s.tree);
  // Tenant capabilities (the server enforces the same ones on those routes;
  // platform and tenant admins hold them all).
  const canManageSettings = useTenantCapability('settings');
  const canManageNotifications = useTenantCapability('notifications.manage');
  const canManageProbes = useTenantCapability('probes.manage');
  const canUseTunnels = useTenantCapability('tunnels.use');
  const canManageDeviceChecks = useTenantCapability('deviceChecks.manage');
  const canManageSites = useTenantCapability('sites.manage');
  const confirm = useConfirm();
  const { isAnonymous, anonymize } = useAnonymize();

  const [site, setSite] = useState<Site | null>(null);
  const [items, setItems] = useState<SiteItem[]>([]);
  const [reservations, setReservations] = useState<IpReservation[]>([]);
  // The site's probes (GET /sites/:id/probes, site read); null = not loaded.
  const [probes, setProbes] = useState<SiteProbe[] | null>(null);
  const [probesError, setProbesError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<SiteLoadError | null>(null);
  const [tunnelTarget, setTunnelTarget] = useState<{ ip: string; port: number } | null>(null);
  // Bumped by socket events so an open drawer reloads (states / histories).
  const [drawerRefresh, setDrawerRefresh] = useState(0);
  const [drawerEventsRefresh, setDrawerEventsRefresh] = useState(0);
  // Reservation modal opened from a device row ("Reserve this IP") or the heatmap.
  const [reservationModal, setReservationModal] = useState<
    { reservation: IpReservation | null; prefill?: ReservationPrefill } | null
  >(null);
  // Set while this page deletes the site (its own SITE_DELETED is not news).
  const deletingRef = useRef(false);
  const loadSeq = useRef(0);
  // Cross-workspace lookup of this site (GET /tenants/locate-site), run once
  // per site id and shared by every load: a load that starts while the
  // workspace switch is in flight awaits it instead of concluding not-found.
  // `promise` resolves to true when the session moved to the site's tenant.
  const locateRef = useRef<{ siteId: number; promise: Promise<boolean> } | null>(null);
  // Bumped when a deep-link workspace switch completes: a fetch started
  // before it (old tenant) is retried once instead of being trusted.
  const switchGen = useRef(0);
  // Name of the workspace being switched to for a deep link (inline notice).
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  // Device checks drawer: ?device=<itemId>&check=<ruleId> (row chips, live-alert links).
  const drawerItemId = positiveInt(searchParams.get('device'));
  const drawerRuleId = positiveInt(searchParams.get('check'));
  const drawerItemRef = useRef<number | null>(drawerItemId);
  drawerItemRef.current = drawerItemId;
  // Latest items for the socket handlers (rules carried by this site's devices).
  const itemsRef = useRef<SiteItem[]>(items);
  itemsRef.current = items;

  const openChecks = useCallback((itemId: number, ruleId: number | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('device', String(itemId));
      if (ruleId !== null) next.set('check', String(ruleId));
      else next.delete('check');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const closeChecks = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('device');
      next.delete('check');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Active tab: kept in ?tab= so a tab can be linked to (none = devices).
  const [urlTab, selectTab] = useUrlTab(URL_TABS, 'devices');
  const requestedTab: Tab = urlTab === 'networkMap' ? 'map' : urlTab;

  // Another site: nothing of the previous one stays on screen.
  useEffect(() => {
    setSite(null);
    setItems([]);
    setReservations([]);
    setProbes(null);
    setProbesError(false);
    setLoadError(null);
    setReservationModal(null);
    setSwitchingTo(null);
    setLoading(true);
  }, [siteId]);

  // Tenant switch for a deep link to a site of another workspace, as the
  // TenantSwitcher does it: session, socket rooms, tenant-scoped stores
  // (permissions follow the tenant store on their own).
  const switchTenant = useCallback(async (tenantId: number) => {
    await useTenantStore.getState().setCurrentTenant(tenantId);
    if (useAuthStore.getState().user) reconnectSocket();
    const groups = useGroupStore.getState();
    await Promise.all([groups.fetchTree(), groups.fetchGroupStats()]).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const mine = ++loadSeq.current;
    if (!siteId) {
      setLoadError('notFound');
      setLoading(false);
      return;
    }
    const fetchAll = () => Promise.all([
      siteApi.get(siteId),
      siteApi.listItems(siteId),
      siteApi.listReservations(siteId),
      // The probe list never fails the page: the Probes tab reports it.
      siteApi.probes(siteId).then((r) => r.probes).catch(() => null),
    ]);
    try {
      let results: Awaited<ReturnType<typeof fetchAll>>;
      const genAtStart = switchGen.current;
      try {
        results = await fetchAll();
      } catch (err) {
        const status = httpStatus(err);
        if (status !== 403 && status !== 404) throw err;
        let entry = locateRef.current;
        if (entry && entry.siteId === siteId) {
          // Already looked up (once per site, so a site deleted later never
          // loops). Wait for a switch still in flight; retry once when the
          // workspace changed after this fetch started, else conclude.
          const switched = await entry.promise;
          if (mine !== loadSeq.current) return;
          if (!switched || switchGen.current === genAtStart) throw err;
        } else {
          // A shared link to a site of another workspace: find its tenant
          // and switch. The lookup runs to completion even when this load is
          // superseded, so the newer load can await it.
          entry = {
            siteId,
            promise: (async () => {
              const location = await locateSite(siteId).catch(() => null);
              if (!location || location.currentTenantId === null || location.tenantId === location.currentTenantId) return false;
              setSwitchingTo(location.tenantName);
              try {
                await switchTenant(location.tenantId);
              } catch {
                setSwitchingTo(null);
                toast.error(t('tenants.switchFailed', 'Could not switch workspace'));
                return false;
              }
              switchGen.current += 1;
              return true;
            })(),
          };
          locateRef.current = entry;
          const switched = await entry.promise;
          if (mine !== loadSeq.current) return;
          if (!switched) throw err;
        }
        results = await fetchAll();
      }
      const [siteRes, itemsRes, resvRes, probesRes] = results;
      if (mine !== loadSeq.current) return;
      setSwitchingTo(null);
      setSite(siteRes.site);
      setItems(itemsRes.items);
      setReservations(resvRes.reservations);
      // A failed probe reload keeps the list already shown.
      if (probesRes) setProbes(probesRes);
      setProbesError(probesRes === null);
      setLoadError(null);
    } catch (err) {
      if (mine !== loadSeq.current) return;
      setSwitchingTo(null);
      const status = httpStatus(err);
      if (status === 403 || status === 404) {
        // No (more) read access, or the site is gone.
        setSite(null);
        setItems([]);
        setReservations([]);
        setProbes(null);
        setLoadError(status === 403 ? 'forbidden' : 'notFound');
      } else {
        setLoadError('error');
        toast.error(t('siteDetail.failedLoad'));
      }
    } finally {
      if (mine === loadSeq.current) setLoading(false);
    }
  }, [siteId, t, switchTenant]);

  useEffect(() => { void load(); }, [load]);

  // Stable callbacks for the device rows (memoized rows keep their render).
  const refresh = useCallback(() => { void load(); }, [load]);
  const openTunnel = useCallback((ip: string, port: number) => setTunnelTarget({ ip, port }), []);

  // Latest translate / navigate for the socket handlers (no re-subscription).
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const tRef = useRef(t);
  tRef.current = t;

  // Tabs whose panel was opened at least once for this site. The heavy
  // panels (heatmap, network map, probes, settings, notifications) mount on
  // first visit only and then stay mounted so their state survives tab
  // switches.
  const visitedTabs = useRef<{ siteId: number; tabs: Set<Tab> }>({ siteId, tabs: new Set() });
  if (visitedTabs.current.siteId !== siteId) visitedTabs.current = { siteId, tabs: new Set() };

  // Live-refresh: when a device on THIS site changes status or a new device is
  // discovered here, reload the items list automatically (debounced 1.5 s).
  // Device check results and alerts patch the items in place (no reload);
  // only a change of a rule carried here reloads them.
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !siteId) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let drawerTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReload = (payload?: { siteId?: number }) => {
      if (payload?.siteId !== undefined && payload.siteId !== siteId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 1500);
    };

    const onItemStatus = (p: { siteId?: number }) => scheduleReload(p);
    const onNewDevice  = (p: { siteId?: number }) => scheduleReload(p);
    // SITE_UPDATED {siteId}: this site changed (config, or a probe push).
    const onSiteUpdated = (p: unknown) => {
      const sid = p && typeof p === 'object' ? positiveInt((p as { siteId?: unknown }).siteId) : null;
      if (sid === siteId) scheduleReload({ siteId: sid });
    };
    // SITE_DELETED {siteId}: the open site was deleted in another session.
    const onSiteDeleted = (p: unknown) => {
      const sid = p && typeof p === 'object' ? positiveInt((p as { siteId?: unknown }).siteId) : null;
      if (sid !== siteId) return;
      if (timer) clearTimeout(timer);
      if (deletingRef.current) return;
      toast(tRef.current('siteDetail.deletedElsewhere', 'This site was deleted'));
      navigateRef.current('/sites');
    };

    // DEVICE_CHECK_UPDATED {siteId, itemId, ruleId, summary}: the summary
    // replaces the item's check of that rule.
    const onCheckUpdated = (p: unknown) => {
      if (!p || typeof p !== 'object') return;
      const payload = p as { siteId?: unknown; itemId?: unknown; summary?: unknown };
      if (payload.siteId !== siteId) return;
      const itemId = positiveInt(payload.itemId);
      const summary = payload.summary;
      if (itemId === null || !isCheckSummary(summary)) return;
      setItems((prev) => {
        const idx = prev.findIndex((i) => i.id === itemId);
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = { ...prev[idx], checks: upsertCheck(prev[idx].checks, summary) };
        return next;
      });
      if (drawerItemRef.current === itemId) {
        if (drawerTimer) clearTimeout(drawerTimer);
        drawerTimer = setTimeout(() => setDrawerRefresh((k) => k + 1), 1000);
      }
    };

    // DEVICE_CHECK_ALERT {siteId, itemId, ruleId, from, to}: alert state of
    // the chip, and a full refresh of an open drawer on that device.
    const onCheckAlert = (p: unknown) => {
      if (!p || typeof p !== 'object') return;
      const payload = p as { siteId?: unknown; itemId?: unknown; ruleId?: unknown; to?: unknown };
      if (payload.siteId !== siteId) return;
      const itemId = positiveInt(payload.itemId);
      const ruleId = positiveInt(payload.ruleId);
      if (itemId === null) return;
      const to = payload.to;
      if (ruleId !== null && typeof to === 'string' && ALERT_STATES.has(to)) {
        setItems((prev) => {
          const idx = prev.findIndex((i) => i.id === itemId);
          const checks = idx >= 0 ? prev[idx].checks : undefined;
          if (!checks || !checks.some((c) => c.ruleId === ruleId)) return prev;
          const next = [...prev];
          next[idx] = {
            ...prev[idx],
            checks: sortChecks(checks.map((c) => (c.ruleId === ruleId ? { ...c, alertState: to as DeviceCheckAlertState } : c))),
          };
          return next;
        });
      }
      if (drawerItemRef.current === itemId) {
        setDrawerRefresh((k) => k + 1);
        setDrawerEventsRefresh((k) => k + 1);
      }
    };

    // DEVICE_CHECK_RULES_CHANGED {ruleId} (admin room): a rule was edited,
    // disabled or deleted. No event removes its checks from the items, so
    // the items are reloaded (debounced) when a device here carries it; an
    // open drawer reloads its cards. A new rule's checks arrive through
    // DEVICE_CHECK_UPDATED. Members (not in the admin room) see the change
    // on the next reload.
    const onRulesChanged = (p: unknown) => {
      const ruleId = p && typeof p === 'object' ? positiveInt((p as { ruleId?: unknown }).ruleId) : null;
      if (ruleId === null) return;
      if (itemsRef.current.some((i) => i.checks?.some((c) => c.ruleId === ruleId))) scheduleReload();
      if (drawerItemRef.current !== null) {
        if (drawerTimer) clearTimeout(drawerTimer);
        drawerTimer = setTimeout(() => setDrawerRefresh((k) => k + 1), 1000);
      }
    };

    socket.on(SOCKET_EVENTS.ITEM_STATUS_CHANGED,        onItemStatus);
    socket.on(SOCKET_EVENTS.NEW_DEVICE_DISCOVERED,      onNewDevice);
    socket.on(SOCKET_EVENTS.DEVICE_CHECK_UPDATED,       onCheckUpdated);
    socket.on(SOCKET_EVENTS.DEVICE_CHECK_ALERT,         onCheckAlert);
    socket.on(SOCKET_EVENTS.DEVICE_CHECK_RULES_CHANGED, onRulesChanged);
    socket.on(SOCKET_EVENTS.SITE_UPDATED,               onSiteUpdated);
    socket.on(SOCKET_EVENTS.SITE_DELETED,               onSiteDeleted);

    return () => {
      if (timer) clearTimeout(timer);
      if (drawerTimer) clearTimeout(drawerTimer);
      socket.off(SOCKET_EVENTS.SITE_UPDATED,               onSiteUpdated);
      socket.off(SOCKET_EVENTS.SITE_DELETED,               onSiteDeleted);
      socket.off(SOCKET_EVENTS.ITEM_STATUS_CHANGED,        onItemStatus);
      socket.off(SOCKET_EVENTS.NEW_DEVICE_DISCOVERED,      onNewDevice);
      socket.off(SOCKET_EVENTS.DEVICE_CHECK_UPDATED,       onCheckUpdated);
      socket.off(SOCKET_EVENTS.DEVICE_CHECK_ALERT,         onCheckAlert);
      socket.off(SOCKET_EVENTS.DEVICE_CHECK_RULES_CHANGED, onRulesChanged);
    };
  }, [siteId, load]);

  // Write permission on the site (the server enforces it; this only hides
  // the controls that would be refused).
  const siteGroupId = site?.groupId ?? null;
  const groupChain = useMemo(
    () => (siteGroupId === null ? [] : groupPathTo(groupTree, siteGroupId) ?? [siteGroupId]),
    [groupTree, siteGroupId],
  );
  const groupName = useMemo(
    () => (siteGroupId === null ? null : findGroupNode(groupTree, siteGroupId)?.name ?? null),
    [groupTree, siteGroupId],
  );
  const canWrite = sitePermissionLevel(fullAccess, permissions, siteId, groupChain) === 'rw';
  useFreshSitePermissions(fullAccess, site && !canWrite ? [site.id] : []);
  const checkCounts = useMemo(() => summarizeItemChecks(items), [items]);
  // "Reserve this IP" of a device row: its reservation when the IP has one,
  // else a new one prefilled with the device (owner = its MAC and item).
  const reservationsRef = useRef<IpReservation[]>(reservations);
  reservationsRef.current = reservations;
  const reserveItem = useCallback((item: SiteItem) => {
    const existing = reservationsRef.current.find((r) => r.ip === item.ip);
    if (existing) {
      setReservationModal({ reservation: existing });
      return;
    }
    setReservationModal({
      reservation: null,
      prefill: {
        ip: item.ip,
        mac: item.mac,
        itemId: item.id,
        name: item.customName ?? item.hostname ?? '',
        deviceType: item.deviceType !== 'unknown' ? item.deviceType : null,
      },
    });
  }, []);

  // Heatmap: a device opens its page; a reservation its edit (writers) or
  // the Reservations tab; a free IP a new reservation (writers only — the
  // heatmap makes free cells clickable only for them).
  const onHeatmapCell = useCallback((ip: string, target: HeatmapTarget) => {
    if (target?.kind === 'item') {
      navigate(`/sites/${siteId}/devices/${target.item.id}`);
    } else if (target?.kind === 'reservation') {
      if (canWrite) setReservationModal({ reservation: target.reservation });
      else selectTab('reservations');
    } else if (canWrite) {
      setReservationModal({ reservation: null, prefill: { ip } });
    }
  }, [navigate, siteId, canWrite, selectTab]);

  // Delete the site (sites.manage + site write, as the server requires).
  const deleteSite = useCallback(async () => {
    if (!site) return;
    const ok = await confirm({
      title: t('sites.deleteTitle', 'Delete site'),
      message: t('sites.confirmDelete', {
        name: anonymize(site.name, 'hostname'),
        defaultValue: 'Delete site "{{name}}"? This will also delete all its devices and reservations.',
      }),
      danger: true,
      // Type-to-confirm with the site name; in anonymous mode the name is
      // masked, so a fixed word is asked instead of revealing it.
      requireText: isAnonymous ? t('sites.deleteWord', 'DELETE') : site.name.trim(),
    });
    if (!ok) return;
    deletingRef.current = true;
    try {
      await siteApi.remove(site.id);
      toast.success(t('sites.deleted', 'Site deleted'));
      void useGroupStore.getState().fetchTree();
      navigate('/sites');
    } catch (err) {
      deletingRef.current = false;
      toastApiError(err, t('sites.failedDelete', 'Failed to delete site'));
    }
  }, [site, confirm, t, anonymize, isAnonymous, navigate]);

  const onSiteSaved = useCallback((saved: Site) => {
    setSite((prev) => (prev ? { ...prev, ...saved } : saved));
    // The group (and the sidebar tree) may have changed.
    void useGroupStore.getState().fetchTree();
    void load();
  }, [load]);

  // Probe names for the device checks drawer (it only reads id / name / hostname).
  const drawerProbes = useMemo(
    () => (probes ?? []).map((p) => ({ id: p.id, name: p.name, hostname: p.name })),
    [probes],
  );

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 h-48">
        <Loader2 className="animate-spin text-accent" size={28} />
        {switchingTo !== null && (
          <p className="text-sm text-text-muted text-center px-4" role="status">
            {t('siteDetail.switchingTenant', 'This site belongs to workspace {{name}} — switching…', {
              name: switchingTo,
            })}
          </p>
        )}
      </div>
    );
  }

  if (!site) {
    return (
      <PageContainer>
        {loadError === 'error' ? (
          <LoadError
            message={t('siteDetail.failedLoad')}
            onRetry={() => { setLoading(true); void load(); }}
          />
        ) : (
          <p className="text-center text-text-muted">
            {loadError === 'forbidden'
              ? t('siteDetail.forbidden', 'You do not have access to this site.')
              : t('siteDetail.notFound')}
          </p>
        )}
        <div className="mt-3 text-center">
          <Link to="/sites" className="text-accent hover:underline text-sm">
            {t('siteDetail.backToSites')}
          </Link>
        </div>
      </PageContainer>
    );
  }

  const onlineCount = items.filter((i) => i.status === 'online').length;
  const offlineCount = items.filter((i) => i.status === 'offline').length;

  // Settings tab: 'settings' capability; notification bindings:
  // 'notifications.manage'; tunnels: 'tunnels.use' plus write permission on
  // the site (a tunnel reaches the site's LAN) — as the server requires.
  // The Probes tab is open to every site reader (GET /sites/:id/probes).
  const tunnelsAllowed = canUseTunnels && canWrite;
  const tabs: { id: Tab; label: string; hidden?: boolean }[] = [
    { id: 'devices',       label: t('siteDetail.tabDevices',      { count: items.length }) },
    { id: 'reservations',  label: t('siteDetail.tabReservations', { count: reservations.length }) },
    { id: 'heatmap',       label: t('siteDetail.tabHeatmap') },
    { id: 'map',           label: t('siteDetail.tabNetworkMap') },
    { id: 'probes',        label: t('siteDetail.tabProbes', { count: probes?.length ?? 0, defaultValue: 'Probes ({{count}})' }) },
    { id: 'settings',      label: t('siteDetail.tabSettings'),      hidden: !canManageSettings },
    { id: 'notifications', label: t('siteDetail.tabNotifications'), hidden: !canManageNotifications },
  ];
  // A ?tab= this user does not get falls back to the devices tab.
  const tab: Tab = tabs.some((x) => x.id === requestedTab && !x.hidden) ? requestedTab : 'devices';
  visitedTabs.current.tabs.add(tab);
  const visited = visitedTabs.current.tabs;
  const panelClass = (tabId: Tab) => (tab !== tabId ? 'invisible pointer-events-none' : '');

  return (
    <PageContainer>
      <SiteHeader
        site={site}
        groupName={groupName}
        canWrite={canWrite}
        onRefresh={refresh}
        onSaved={onSiteSaved}
        onDelete={canManageSites && canWrite ? () => void deleteSite() : undefined}
      >
        {/* Stats line */}
        <div className="mt-2 flex items-center gap-4 flex-wrap text-sm text-text-secondary">
          <span>{t('siteDetail.statDevices', { count: items.length })}</span>
          <span className="text-emerald-400">{t('siteDetail.statOnline', { count: onlineCount })}</span>
          {offlineCount > 0 && (
            <span className="text-red-400">{t('siteDetail.statOffline', { count: offlineCount })}</span>
          )}
          <span>{t('siteDetail.statReservations', { count: reservations.length })}</span>
          <SiteChecksSummary counts={checkCounts} variant="inline" />
        </div>
      </SiteHeader>

      <SegmentedTabs
        tabs={tabs}
        value={tab}
        onChange={selectTab}
        fill={false}
        className="mb-6"
        ariaLabel={t('siteDetail.tabsLabel', 'Site sections')}
      />

      {/* Tab content — panels stacked in one grid cell so the container's
          height equals max(mounted panels); non-active panels are invisible
          and non-interactive. Devices and reservations are always mounted
          (cheap, and they hold filter / sort state); the other panels mount
          on their first visit, so the Devices tab loads no flows, settings
          or bindings, and the network map animates only while shown. */}
      <div style={{ display: 'grid' }}>
        <div style={{ gridArea: '1/1' }} className={panelClass('devices')}>
          <DevicesTab
            key={siteId}
            siteId={siteId}
            siteName={site.name}
            items={items}
            reservations={reservations}
            probes={probes}
            canWrite={canWrite}
            canManageProbes={canManageProbes}
            onRefresh={refresh}
            onTunnel={tunnelsAllowed ? openTunnel : undefined}
            onOpenChecks={openChecks}
            onReserve={canWrite ? reserveItem : undefined}
          />
        </div>
        <div style={{ gridArea: '1/1' }} className={panelClass('reservations')}>
          <ReservationsTab
            key={siteId}
            siteId={siteId}
            reservations={reservations}
            items={items}
            canWrite={canWrite}
            onRefresh={refresh}
          />
        </div>
        {visited.has('heatmap') && (
          <div style={{ gridArea: '1/1' }} className={panelClass('heatmap')}>
            <SubnetHeatmap
              siteId={siteId || undefined}
              items={items}
              reservations={reservations}
              onCellClick={onHeatmapCell}
              canReserve={canWrite}
            />
          </div>
        )}
        {visited.has('map') && (
          <div style={{ gridArea: '1/1' }} className={panelClass('map')}>
            <NetworkStarmap siteId={siteId} items={items} active={tab === 'map'} canWrite={canWrite} />
          </div>
        )}
        {visited.has('probes') && (
          <div style={{ gridArea: '1/1' }} className={panelClass('probes')}>
            <SiteProbesTab probes={probes} error={probesError} onRetry={refresh} canManageProbes={canManageProbes} />
          </div>
        )}
        {canManageSettings && visited.has('settings') && (
          <div style={{ gridArea: '1/1' }} className={panelClass('settings')}>
            <SettingsPanel scope="site" scopeId={siteId} />
          </div>
        )}
        {canManageNotifications && visited.has('notifications') && (
          <div style={{ gridArea: '1/1' }} className={panelClass('notifications')}>
            <NotificationBindingsGuard scope="site" scopeId={siteId}>
              <NotificationBindingsPanel scope="site" scopeId={siteId} />
            </NotificationBindingsGuard>
          </div>
        )}
      </div>

      {/* Tunnel dialog: the probe is chosen in the dialog before opening. */}
      {tunnelsAllowed && tunnelTarget && (
        <TunnelDialog
          siteId={siteId}
          targetIp={tunnelTarget.ip}
          targetPort={tunnelTarget.port}
          onClose={() => setTunnelTarget(null)}
        />
      )}

      {/* Reservation from a device row or a heatmap cell (site write). */}
      {canWrite && reservationModal && (
        <ReservationModal
          siteId={siteId}
          reservation={reservationModal.reservation}
          prefill={reservationModal.prefill}
          items={items}
          onClose={() => setReservationModal(null)}
          onSaved={() => { setReservationModal(null); refresh(); }}
        />
      )}

      {/* Device checks drawer */}
      {drawerItemId !== null && (
        <DeviceChecksDrawer
          siteId={siteId}
          itemId={drawerItemId}
          item={items.find((i) => i.id === drawerItemId) ?? null}
          focusRuleId={drawerRuleId}
          probes={drawerProbes}
          // Run now and the rule link take 'deviceChecks.manage'.
          isAdmin={canManageDeviceChecks}
          refreshKey={drawerRefresh}
          eventsRefreshKey={drawerEventsRefresh}
          onClose={closeChecks}
        />
      )}
    </PageContainer>
  );
}
