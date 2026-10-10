import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import {
  Activity, Bell, BookmarkCheck, BookmarkPlus, Check, Clock, ExternalLink, Globe, History, Info, ListChecks,
  Loader2, Network, Pencil, Radar, RefreshCw, ScrollText, Trash2, Waypoints, X,
} from 'lucide-react';
import type { IpReservation, ItemAlertMode, ItemStatus } from '@oblimap/shared';
import { ITEM_ALERT_MODES, SOCKET_EVENTS } from '@oblimap/shared';
import { itemsApi, type ItemDetailResponse } from '@/api/items.api';
import { eventsApi } from '@/api/events.api';
import { locateSite } from '@/api/tenantLocate.api';
import { siteApi, type SiteProbe } from '@/api/site.api';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { LoadError } from '@/components/common/LoadError';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { DeviceModal } from '@/components/ipam/site/DeviceModal';
import { ReservationModal } from '@/components/ipam/site/ReservationModal';
import TunnelDialog, { WEB_PORTS } from '@/components/ipam/TunnelDialog';
import { DeviceChecksPanel } from '@/components/deviceChecks/DeviceChecksDrawer';
import { DeviceIpHistory } from '@/components/devices/DeviceIpHistory';
import { DeviceFlowsList, WELL_KNOWN_PORT_NAMES } from '@/components/devices/DeviceFlowsList';
import { DeviceActivityPanel } from '@/components/supervision/HistoryPanel';
import { useUrlTab } from '@/hooks/useUrlTab';
import { useIpamLiveRefresh } from '@/hooks/useIpamLiveRefresh';
import { groupPathTo, sitePermissionLevel, useFreshSitePermissions } from '@/hooks/useFreshSitePermissions';
import { getSocket, reconnectSocket } from '@/socket/socketClient';
import { useSocketStore } from '@/store/socketStore';
import { useTenantStore } from '@/store/tenantStore';
import { useAuthStore, useFullAccess, useTenantCapability } from '@/store/authStore';
import { useGroupStore } from '@/store/groupStore';
import { useAnonymize } from '@/utils/anonymize';
import { toastApiError } from '@/utils/apiError';
import { deviceTypeIcon, deviceTypeLabel } from '@/utils/deviceTypes';
import { formatRelative } from '@/utils/formatRelative';
import { reservationStateLabel, reservationStateOf } from '@/utils/exportSite';
import { parseRouteId } from '@/utils/routeId';

/**
 * One device of a site (/sites/:siteId/devices/:itemId), on Obliance's
 * DeviceDetailPage template: back button, inline-renamable title with the
 * status badge and last-seen pill, a sub-line (ip · mac · vendor · site),
 * the actions, then one tab rendered at a time (?tab=).
 *
 * Data: GET /api/items/:id (site read; an item of a site the user cannot
 * read answers 404). A URL whose site is not the item's is redirected to
 * the canonical one. Write actions (rename, edit, reserve, delete) need
 * write permission on the site, tunnels also 'tunnels.use' — the server
 * enforces the same.
 */

// ─── Tabs ─────────────────────────────────────────────────────────────────────

/**
 * Tab ids, in display order. To add a tab: add its id here and an entry in
 * the `tabs` array of the page (label, icon, render).
 */
const DEVICE_TABS = ['overview', 'activity', 'ports', 'checks', 'ip-history', 'flows'] as const;
type DeviceTab = (typeof DEVICE_TABS)[number];

interface DeviceTabDef extends SegmentedTab<DeviceTab> {
  render: () => ReactNode;
}

type PageLoadError = 'forbidden' | 'notFound' | 'error';

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

// ─── Small pieces ─────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<ItemStatus, string> = {
  online: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  offline: 'bg-red-500/15 text-red-400 border-red-500/30',
  reserved: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  unknown: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
};

const STATUS_DOT: Record<ItemStatus, string> = {
  online: 'bg-emerald-500',
  offline: 'bg-red-500',
  reserved: 'bg-blue-500',
  unknown: 'bg-zinc-500',
};

const RESERVATION_STATE_CLASS: Record<string, string> = {
  held: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  free: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  conflict: 'bg-red-500/15 text-red-400 border-red-500/30',
  owner_offline: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
};

/** Where the device type came from (same texts as the device modal). */
const TYPE_SOURCE_FALLBACK: Record<string, string> = {
  manual: 'Set manually: never reclassified automatically.',
  rule: 'Set by a vendor rule.',
  ports: 'Guessed from the open ports.',
  probe: 'Reported by the probe.',
};

/** Web ports with the scheme of their link. */
const WEB_SCHEMES: Record<number, 'http' | 'https'> = { 80: 'http', 443: 'https', 8080: 'http', 8443: 'https' };

function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

function StatusBadge({ status }: { status: ItemStatus }) {
  const { t } = useTranslation();
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium', STATUS_BADGE[status] ?? STATUS_BADGE.unknown)}>
      <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', STATUS_DOT[status] ?? STATUS_DOT.unknown)} aria-hidden="true" />
      {t(`itemStatus.${status}`, status)}
    </span>
  );
}

/**
 * Relative last-seen pill (Obliance LastSeenPill), colour-coded for scan
 * cadences: < 15 min green, < 1 h yellow, < 24 h orange, else red. Ticks
 * every 30 s so the label drifts on its own.
 */
function LastSeenPill({ lastSeenAt }: { lastSeenAt: string | null }) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const time = lastSeenAt ? new Date(lastSeenAt).getTime() : Number.NaN;
  const mins = Number.isFinite(time) ? (Date.now() - time) / 60_000 : Number.POSITIVE_INFINITY;
  const color = !Number.isFinite(mins)
    ? 'bg-bg-tertiary text-text-muted border-transparent'
    : mins < 15
      ? 'bg-green-400/10 text-green-400 border-green-400/30'
      : mins < 60
        ? 'bg-yellow-400/10 text-yellow-400 border-yellow-400/30'
        : mins < 1440
          ? 'bg-orange-400/10 text-orange-400 border-orange-400/30'
          : 'bg-red-400/10 text-red-400 border-red-400/30';
  return (
    <span
      className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', color)}
      title={t('deviceDetail.lastSeenAt', { date: absoluteTime(lastSeenAt), defaultValue: 'Last seen {{date}}' })}
    >
      <Clock className="h-3 w-3" />
      {formatRelative(lastSeenAt, t)}
    </span>
  );
}

function InfoRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,38%)_1fr] gap-3 border-b border-border/60 py-2 text-sm last:border-0">
      <dt className="text-text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-text-primary [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Card({ title, icon, children, actions }: { title: ReactNode; icon?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl bg-bg-secondary p-4 shadow-[var(--shadow-card)]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          {icon}
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function typeSourceText(t: TFunction, source: string | null | undefined): string | null {
  if (!source || !TYPE_SOURCE_FALLBACK[source]) return null;
  return t(`siteDetail.deviceModal.typeSource.${source}`, TYPE_SOURCE_FALLBACK[source]);
}

/** English fallbacks of deviceDetail.alertMode.<mode>. */
const ALERT_MODE_FALLBACK: Record<ItemAlertMode, string> = {
  inherit: 'Follow the site setting',
  always: 'Always alert',
  never: 'Never alert',
};

/**
 * Offline / back-online alerts of the device (site_items.alert_mode): a
 * select for site writers, the current mode for readers. The hint explains
 * the alertOnlyWatchedDevices setting the 'inherit' mode follows.
 */
function AlertModeControl({
  mode, canWrite, saving, onChange,
}: { mode: ItemAlertMode; canWrite: boolean; saving: boolean; onChange: (mode: ItemAlertMode) => void }) {
  const { t } = useTranslation();
  const label = (m: ItemAlertMode) => t(`deviceDetail.alertMode.${m}`, ALERT_MODE_FALLBACK[m]);
  return (
    <div>
      {canWrite ? (
        <div className="flex items-center gap-2">
          <select
            value={mode}
            disabled={saving}
            onChange={(e) => onChange(e.target.value as ItemAlertMode)}
            aria-label={t('deviceDetail.alertMode.label', 'Offline alerts')}
            className="min-w-0 max-w-full rounded-md border border-border bg-bg-secondary px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
          >
            {ITEM_ALERT_MODES.map((m) => <option key={m} value={m}>{label(m)}</option>)}
          </select>
          {saving && <Loader2 className="h-4 w-4 animate-spin text-text-muted" aria-hidden="true" />}
        </div>
      ) : (
        <span>{label(mode)}</span>
      )}
      <span className="mt-1 block text-xs text-text-muted">
        {t(
          'deviceDetail.alertMode.hint',
          'Offline and back-online alerts. "Follow the site setting" alerts unless the "Alert only for watched devices" setting is on; "Always" alerts even then; "Never" raises none.',
        )}
      </span>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function DeviceDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const params = useParams<{ siteId: string; itemId: string }>();
  const routeSiteId = parseRouteId(params.siteId);
  const itemId = parseRouteId(params.itemId);
  const focusRuleId = parseRouteId(searchParams.get('check'));

  const fullAccess = useFullAccess();
  const permissions = useAuthStore((s) => s.permissions?.permissions);
  const groupTree = useGroupStore((s) => s.tree);
  const canManageProbes = useTenantCapability('probes.manage');
  const canUseTunnels = useTenantCapability('tunnels.use');
  const canManageDeviceChecks = useTenantCapability('deviceChecks.manage');
  const confirm = useConfirm();
  const { anonymize } = useAnonymize();

  const [detail, setDetail] = useState<ItemDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<PageLoadError | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped by live events: the shown tab reloads its own data silently.
  const [liveKey, setLiveKey] = useState(0);
  const [checksRefresh, setChecksRefresh] = useState(0);
  const [checksEventsRefresh, setChecksEventsRefresh] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const [reservationOpen, setReservationOpen] = useState(false);
  const [tunnelPort, setTunnelPort] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [savingAlertMode, setSavingAlertMode] = useState(false);
  // Set while this page deletes the device (its own refresh 404 is not news).
  const deletingRef = useRef(false);
  const loadSeq = useRef(0);

  const [tab, selectTab] = useUrlTab(DEVICE_TABS, 'overview');

  // Another device: nothing of the previous one stays on screen.
  useEffect(() => {
    setDetail(null);
    setLoadError(null);
    setLoading(true);
    setRenaming(false);
    setEditOpen(false);
    setReservationOpen(false);
    setTunnelPort(null);
  }, [itemId]);

  // A shared link to a device of another workspace: the site is located
  // (once per device link) and the workspace switched, like SiteDetailPage.
  const locatedRef = useRef<string | null>(null);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  /** Switches to the workspace holding routeSiteId; true when it switched. */
  const switchToSiteTenant = useCallback(async (): Promise<boolean> => {
    if (routeSiteId === null || itemId === null) return false;
    const key = `${routeSiteId}:${itemId}`;
    if (locatedRef.current === key) return false;
    locatedRef.current = key;
    const location = await locateSite(routeSiteId).catch(() => null);
    if (!location || location.currentTenantId === null || location.tenantId === location.currentTenantId) return false;
    setSwitchingTo(location.tenantName);
    try {
      // As the TenantSwitcher: session, socket rooms, tenant-scoped stores.
      await useTenantStore.getState().setCurrentTenant(location.tenantId);
      if (useAuthStore.getState().user) reconnectSocket();
      const groups = useGroupStore.getState();
      await Promise.all([groups.fetchTree(), groups.fetchGroupStats()]).catch(() => undefined);
      return true;
    } catch {
      toast.error(t('tenants.switchFailed', 'Could not switch workspace'));
      return false;
    } finally {
      setSwitchingTo(null);
    }
  }, [routeSiteId, itemId, t]);

  const load = useCallback(async () => {
    const mine = ++loadSeq.current;
    if (itemId === null) {
      setLoadError('notFound');
      setLoading(false);
      return;
    }
    try {
      let res: ItemDetailResponse;
      try {
        res = await itemsApi.get(itemId);
      } catch (err) {
        const status = httpStatus(err);
        if ((status !== 403 && status !== 404) || deletingRef.current) throw err;
        const switched = await switchToSiteTenant();
        if (mine !== loadSeq.current) return;
        if (!switched) throw err;
        res = await itemsApi.get(itemId);
      }
      if (mine !== loadSeq.current) return;
      setDetail(res);
      setLoadError(null);
    } catch (err) {
      if (mine !== loadSeq.current || deletingRef.current) return;
      const status = httpStatus(err);
      if (status === 403 || status === 404) {
        // No (more) read access, or the device / its site is gone.
        setDetail(null);
        setLoadError(status === 403 ? 'forbidden' : 'notFound');
      } else {
        setLoadError('error');
      }
    } finally {
      if (mine === loadSeq.current) setLoading(false);
    }
  }, [itemId, switchToSiteTenant]);

  useEffect(() => { void load(); }, [load]);

  // Live refresh: device status, new devices, site updates (probe pushes),
  // tree changes, socket resyncs and tenant switches.
  useIpamLiveRefresh(() => {
    void load();
    setLiveKey((k) => k + 1);
  });

  const siteId = detail?.site.id ?? null;

  // Canonical URL: the item's own site (an old or hand-written link).
  useEffect(() => {
    if (!detail || itemId === null || detail.item.id !== itemId || detail.site.id === routeSiteId) return;
    navigate(`/sites/${detail.site.id}/devices/${itemId}${location.search}`, { replace: true });
  }, [detail, itemId, routeSiteId, navigate, location.search]);

  // Device check results and alerts of this device refresh the Checks tab.
  const socketStatus = useSocketStore((s) => s.status);
  useEffect(() => {
    const socket = getSocket();
    if (!socket || itemId === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ofThisItem = (p: unknown): boolean =>
      !!p && typeof p === 'object' && (p as { itemId?: unknown }).itemId === itemId;
    const onUpdated = (p: unknown) => {
      if (!ofThisItem(p)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setChecksRefresh((k) => k + 1), 1000);
    };
    const onAlert = (p: unknown) => {
      if (!ofThisItem(p)) return;
      setChecksRefresh((k) => k + 1);
      setChecksEventsRefresh((k) => k + 1);
    };
    const onRulesChanged = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setChecksRefresh((k) => k + 1), 1000);
    };
    socket.on(SOCKET_EVENTS.DEVICE_CHECK_UPDATED, onUpdated);
    socket.on(SOCKET_EVENTS.DEVICE_CHECK_ALERT, onAlert);
    socket.on(SOCKET_EVENTS.DEVICE_CHECK_RULES_CHANGED, onRulesChanged);
    return () => {
      if (timer) clearTimeout(timer);
      socket.off(SOCKET_EVENTS.DEVICE_CHECK_UPDATED, onUpdated);
      socket.off(SOCKET_EVENTS.DEVICE_CHECK_ALERT, onAlert);
      socket.off(SOCKET_EVENTS.DEVICE_CHECK_RULES_CHANGED, onRulesChanged);
    };
  }, [itemId, socketStatus]);

  // Write permission on the item's site (the server enforces it; this only
  // hides the controls that would be refused).
  const siteGroupId = detail?.site.groupId ?? null;
  const groupChain = useMemo(
    () => (siteGroupId === null ? [] : groupPathTo(groupTree, siteGroupId) ?? [siteGroupId]),
    [groupTree, siteGroupId],
  );
  const canWrite = siteId !== null && sitePermissionLevel(fullAccess, permissions, siteId, groupChain) === 'rw';
  useFreshSitePermissions(fullAccess, siteId !== null && !canWrite ? [siteId] : []);
  // A tunnel reaches the site's LAN: 'tunnels.use' plus site write, as the server.
  const tunnelsAllowed = canUseTunnels && canWrite;

  // Probe names for the check cards, loaded on the first visit of the tab.
  const [probes, setProbes] = useState<{ siteId: number; list: SiteProbe[] } | null>(null);
  useEffect(() => {
    if (tab !== 'checks' || siteId === null || probes?.siteId === siteId) return;
    let cancelled = false;
    siteApi.probes(siteId)
      .then((r) => { if (!cancelled) setProbes({ siteId, list: r.probes }); })
      .catch(() => { if (!cancelled) setProbes({ siteId, list: [] }); });
    return () => { cancelled = true; };
  }, [tab, siteId, probes?.siteId]);

  // The site's devices (names and links of the flow peers), loaded on the
  // first visit of the Flows tab.
  const [peers, setPeers] = useState<{ siteId: number; map: Map<string, { itemId: number; name: string | null }> } | null>(null);
  useEffect(() => {
    if (tab !== 'flows' || siteId === null || peers?.siteId === siteId) return;
    let cancelled = false;
    siteApi.listItems(siteId)
      .then((r) => {
        if (cancelled) return;
        const map = new Map<string, { itemId: number; name: string | null }>();
        for (const i of r.items) {
          // Several devices on one IP: the online one wins.
          if (!map.has(i.ip) || i.status === 'online') map.set(i.ip, { itemId: i.id, name: i.customName ?? i.hostname });
        }
        setPeers({ siteId, map });
      })
      .catch(() => { if (!cancelled) setPeers({ siteId, map: new Map() }); });
    return () => { cancelled = true; };
  }, [tab, siteId, peers?.siteId]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const item = detail?.item ?? null;

  const startRename = () => {
    if (!item) return;
    setNameDraft(item.customName ?? '');
    setRenaming(true);
  };

  const saveRename = async () => {
    if (!item || siteId === null || savingName) return;
    const next = nameDraft.trim() || null;
    if (next === (item.customName ?? null)) {
      setRenaming(false);
      return;
    }
    setSavingName(true);
    try {
      await siteApi.updateItem(siteId, item.id, { customName: next });
      toast.success(t('siteDetail.device.updated', 'Device updated'));
      setRenaming(false);
      void load();
    } catch (err) {
      toastApiError(err, t('siteDetail.device.failedUpdate', 'Failed to update device'));
    } finally {
      setSavingName(false);
    }
  };

  const saveAlertMode = async (mode: ItemAlertMode) => {
    if (!item || siteId === null || savingAlertMode || mode === (item.alertMode ?? 'inherit')) return;
    setSavingAlertMode(true);
    try {
      await eventsApi.setAlertMode(siteId, item.id, mode);
      toast.success(t('siteDetail.device.updated', 'Device updated'));
      void load();
    } catch (err) {
      toastApiError(err, t('siteDetail.device.failedUpdate', 'Failed to update device'));
    } finally {
      setSavingAlertMode(false);
    }
  };

  const deleteDevice = async () => {
    if (!item || siteId === null) return;
    const displayName = item.customName ?? item.hostname;
    const shown = displayName ? anonymize(displayName, 'hostname') : anonymize(item.ip, 'ip');
    const ok = await confirm({
      message: t('siteDetail.device.confirmRemove', { name: shown, defaultValue: 'Remove device "{{name}}" from this site?' }),
      danger: true,
    });
    if (!ok) return;
    deletingRef.current = true;
    try {
      await siteApi.removeItem(siteId, item.id);
      toast.success(t('siteDetail.device.removed', 'Device removed'));
      navigate(`/sites/${siteId}`, { replace: true });
    } catch (err) {
      deletingRef.current = false;
      toastApiError(err, t('siteDetail.device.failedRemove', 'Failed to remove device'));
    }
  };

  // ── States without a device ────────────────────────────────────────────────

  const backTo = routeSiteId !== null ? `/sites/${routeSiteId}` : '/sites';

  if (loading && !detail) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3">
        <Loader2 className="animate-spin text-accent" size={28} />
        {switchingTo !== null && (
          <p className="px-4 text-center text-sm text-text-muted" role="status">
            {t('deviceDetail.switchingTenant', { name: switchingTo, defaultValue: 'This device belongs to workspace {{name}} — switching…' })}
          </p>
        )}
      </div>
    );
  }

  if (!detail || !item || siteId === null) {
    return (
      <PageContainer title={t('deviceDetail.title', 'Device')} backTo={backTo}>
        {loadError === 'error' ? (
          <LoadError
            message={t('deviceDetail.failedLoad', 'Could not load the device.')}
            onRetry={() => { setLoading(true); void load(); }}
          />
        ) : (
          <p className="text-center text-text-muted">
            {loadError === 'forbidden'
              ? t('deviceDetail.forbidden', 'You do not have access to this device.')
              : t('deviceDetail.notFound', 'This device does not exist or was removed.')}
          </p>
        )}
        <div className="mt-3 text-center">
          <Link to={backTo} className="text-sm text-accent hover:underline">
            {routeSiteId !== null
              ? t('deviceDetail.backToSite', 'Back to the site')
              : t('siteDetail.backToSites', 'Back to sites')}
          </Link>
        </div>
      </PageContainer>
    );
  }

  // ── Header ──────────────────────────────────────────────────────────────────

  const displayName = item.customName || item.hostname;
  const title = displayName ? anonymize(displayName, 'hostname') : anonymize(item.ip, 'ip');
  const TypeIcon = deviceTypeIcon(item.deviceType);
  const reservation: IpReservation | null = detail.reservation;
  const ports = [...(item.openPorts ?? [])].sort((a, b) => a - b);

  const headerActions = (
    <>
      <IconButton
        label={t('common.refresh', 'Refresh')}
        icon={<RefreshCw className={clsx('h-4 w-4', loading && 'animate-spin')} />}
        size="md"
        onClick={() => { setLoading(true); void load(); setLiveKey((k) => k + 1); setChecksRefresh((k) => k + 1); }}
      />
      {canWrite && (
        <>
          <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-1.5 h-4 w-4" />
            {t('common.edit', 'Edit')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setReservationOpen(true)}>
            <BookmarkPlus className="mr-1.5 h-4 w-4" />
            {reservation
              ? t('deviceTable.editReservation', 'Edit the reservation of this IP')
              : t('deviceTable.reserveIp', 'Reserve this IP')}
          </Button>
          <Button variant="danger" size="sm" onClick={() => void deleteDevice()}>
            <Trash2 className="mr-1.5 h-4 w-4" />
            {t('common.delete', 'Delete')}
          </Button>
        </>
      )}
    </>
  );

  // ── Tab bodies ──────────────────────────────────────────────────────────────

  const overview = (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={t('deviceDetail.overview.identity', 'Identity')} icon={<Info className="h-4 w-4 text-text-muted" />}>
        <dl>
          <InfoRow label={t('siteDetail.device.colIp', 'IP')}>
            <span className="font-mono">{anonymize(item.ip, 'ip')}</span>
          </InfoRow>
          <InfoRow label={t('siteDetail.device.colMac', 'MAC')}>
            {item.mac ? (
              <>
                <span className="font-mono">{anonymize(item.mac, 'mac')}</span>
                {item.macRandomized && (
                  <span
                    className="ml-2 rounded bg-bg-tertiary px-1.5 py-0.5 text-[11px] text-text-muted"
                    title={t('deviceTable.randomMacHint', 'Randomized (private) MAC address: the device may show up again under another MAC')}
                  >
                    {t('deviceTable.randomMac', 'random')}
                  </span>
                )}
              </>
            ) : '—'}
          </InfoRow>
          <InfoRow label={t('deviceDetail.overview.hostname', 'Hostname')}>
            {item.hostname ? anonymize(item.hostname, 'hostname') : '—'}
          </InfoRow>
          <InfoRow label={t('deviceDetail.overview.customName', 'Custom name')}>
            {item.customName ? anonymize(item.customName, 'hostname') : '—'}
          </InfoRow>
          <InfoRow label={t('siteDetail.device.colVendor', 'Vendor')}>{item.vendor ?? '—'}</InfoRow>
          <InfoRow label={t('siteDetail.device.colType', 'Type')}>
            <span className="inline-flex items-center gap-1.5">
              <TypeIcon size={14} className="text-text-muted" />
              {deviceTypeLabel(t, item.deviceType)}
            </span>
            {typeSourceText(t, item.deviceTypeSource) && (
              <span className="block text-xs text-text-muted">{typeSourceText(t, item.deviceTypeSource)}</span>
            )}
          </InfoRow>
          <InfoRow label={t('deviceDetail.overview.origin', 'Origin')}>
            {item.isManual
              ? t('deviceDetail.overview.originManual', 'Added manually')
              : t('deviceDetail.overview.originDiscovered', 'Discovered by a probe')}
          </InfoRow>
        </dl>
      </Card>

      <Card title={t('deviceDetail.overview.presence', 'Presence')} icon={<Activity className="h-4 w-4 text-text-muted" />}>
        <dl>
          <InfoRow label={t('common.status', 'Status')}><StatusBadge status={item.status} /></InfoRow>
          <InfoRow label={t('deviceDetail.overview.firstSeen', 'First seen')}>
            <span title={formatRelative(item.firstSeenAt, t)}>{absoluteTime(item.firstSeenAt)}</span>
          </InfoRow>
          <InfoRow label={t('siteDetail.device.colLastSeen', 'Last seen')}>
            <span title={absoluteTime(item.lastSeenAt)}>{formatRelative(item.lastSeenAt, t)}</span>
          </InfoRow>
          <InfoRow label={t('deviceDetail.overview.discoveredBy', 'Discovered by')}>
            {detail.probe ? (
              canManageProbes ? (
                <Link to={`/manage/probes/${detail.probe.id}`} className="inline-flex items-center gap-1 text-accent hover:underline">
                  <Radar size={13} />
                  {anonymize(detail.probe.name, 'hostname')}
                </Link>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Radar size={13} className="text-text-muted" />
                  {anonymize(detail.probe.name, 'hostname')}
                </span>
              )
            ) : '—'}
          </InfoRow>
          {item.isProbe && (
            <InfoRow label={t('siteDetail.device.probeBadge', 'Probe')}>
              {canManageProbes && item.probeId ? (
                <Link to={`/manage/probes/${item.probeId}`} className="text-accent hover:underline">
                  {t('siteDetail.device.probeBadgeTitle', 'This device is a probe')}
                </Link>
              ) : t('siteDetail.device.probeBadgeTitle', 'This device is a probe')}
            </InfoRow>
          )}
          <InfoRow label={t('deviceDetail.overview.site', 'Site')}>
            <Link to={`/sites/${siteId}`} className="text-accent hover:underline">
              {anonymize(detail.site.name, 'hostname')}
            </Link>
          </InfoRow>
          <InfoRow label={(
            <span className="inline-flex items-center gap-1">
              <Bell className="h-3.5 w-3.5" aria-hidden="true" />
              {t('deviceDetail.alertMode.label', 'Offline alerts')}
            </span>
          )}>
            <AlertModeControl
              mode={item.alertMode ?? 'inherit'}
              canWrite={canWrite}
              saving={savingAlertMode}
              onChange={(mode) => void saveAlertMode(mode)}
            />
          </InfoRow>
        </dl>
      </Card>

      <Card
        title={t('deviceDetail.overview.reservation', 'Reservation')}
        icon={<BookmarkCheck className="h-4 w-4 text-text-muted" />}
        actions={canWrite ? (
          <Button variant="ghost" size="sm" onClick={() => setReservationOpen(true)}>
            {reservation ? t('common.edit', 'Edit') : t('deviceTable.reserveIp', 'Reserve this IP')}
          </Button>
        ) : undefined}
      >
        {reservation ? (
          <dl>
            <InfoRow label={t('common.name', 'Name')}>{anonymize(reservation.name, 'hostname')}</InfoRow>
            <InfoRow label={t('common.status', 'Status')}>
              <span className={clsx('inline-flex rounded-full border px-2 py-0.5 text-xs font-medium', RESERVATION_STATE_CLASS[reservationStateOf(reservation)] ?? RESERVATION_STATE_CLASS.free)}>
                {reservationStateLabel(t, reservationStateOf(reservation))}
              </span>
            </InfoRow>
            {reservation.reservedMac && (
              <InfoRow label={t('deviceDetail.overview.reservedFor', 'Reserved for')}>
                <span className="font-mono">{anonymize(reservation.reservedMac, 'mac')}</span>
              </InfoRow>
            )}
            {reservation.description && (
              <InfoRow label={t('common.description', 'Description')}>
                <span className="whitespace-pre-wrap">{reservation.description}</span>
              </InfoRow>
            )}
          </dl>
        ) : (
          <p className="text-sm text-text-muted">{t('deviceDetail.overview.notReserved', 'This IP is not reserved.')}</p>
        )}
      </Card>

      <Card title={t('deviceDetail.overview.notes', 'Notes')} icon={<Pencil className="h-4 w-4 text-text-muted" />}
        actions={canWrite ? (
          <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)}>{t('common.edit', 'Edit')}</Button>
        ) : undefined}
      >
        {item.notes ? (
          <p className="whitespace-pre-wrap break-words text-sm text-text-primary [overflow-wrap:anywhere]">{item.notes}</p>
        ) : (
          <p className="text-sm text-text-muted">{t('deviceDetail.overview.noNotes', 'No notes.')}</p>
        )}
      </Card>

      {item.mac && (
        <Card title={t('deviceDetail.overview.otherSites', 'Same MAC on other sites')} icon={<Network className="h-4 w-4 text-text-muted" />}>
          {detail.otherSites.length === 0 ? (
            <p className="text-sm text-text-muted">{t('deviceDetail.overview.noOtherSites', 'This MAC address appears on no other site you can see.')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {detail.otherSites.map((o) => (
                <li key={`${o.siteId}:${o.itemId}`}>
                  <Link to={`/sites/${o.siteId}/devices/${o.itemId}`} className="text-accent hover:underline">
                    {anonymize(o.siteName, 'hostname')}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );

  const portsBody = ports.length === 0 ? (
    <EmptyState
      icon={<Globe className="h-6 w-6" />}
      title={t('deviceDetail.ports.empty', 'No open port known')}
      description={t('deviceDetail.ports.emptyHint', 'Open ports are listed after a port scan (Port scan setting of the site or its group).')}
    />
  ) : (
    <div className="rounded-xl bg-bg-secondary shadow-[var(--shadow-card)]">
      <ul>
        {ports.map((port) => {
          const scheme = WEB_SCHEMES[port];
          const hostPart = port === 80 || port === 443 ? '' : `:${port}`;
          const service = WELL_KNOWN_PORT_NAMES[port];
          const shownUrl = scheme ? `${scheme}://${anonymize(item.ip, 'ip')}${hostPart}` : null;
          return (
            <li key={port} className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5 last:border-0">
              <span className="w-16 font-mono text-sm text-text-primary">{port}</span>
              <span className="min-w-0 flex-1 text-sm text-text-secondary">{service ?? t('deviceDetail.ports.unknownService', 'Unknown service')}</span>
              <div className="flex items-center gap-2">
                {tunnelsAllowed && WEB_PORTS.has(port) ? (
                  <button
                    type="button"
                    onClick={() => setTunnelPort(port)}
                    className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-xs text-accent transition-colors hover:bg-accent/20"
                    title={t('siteDetail.device.webAccess', { ip: anonymize(item.ip, 'ip'), port, defaultValue: 'Open {{ip}}:{{port}} (proxy or local)' })}
                  >
                    <Globe size={12} />
                    {t('deviceDetail.ports.open', 'Open')}
                  </button>
                ) : scheme && (
                  <a
                    href={`${scheme}://${item.ip}${hostPart}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-1 text-xs text-blue-400 transition-colors hover:bg-blue-500/20"
                    title={t('siteDetail.device.openUrl', { url: shownUrl, defaultValue: 'Open {{url}}' })}
                  >
                    <ExternalLink size={12} />
                    {t('deviceDetail.ports.open', 'Open')}
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );

  const tabs: DeviceTabDef[] = [
    {
      id: 'overview',
      label: t('deviceDetail.tabs.overview', 'Overview'),
      icon: <Info className="h-4 w-4" />,
      render: () => overview,
    },
    {
      id: 'activity',
      label: t('deviceDetail.tabs.activity', 'Activity'),
      icon: <ScrollText className="h-4 w-4" />,
      render: () => <DeviceActivityPanel itemId={item.id} refreshKey={liveKey} />,
    },
    {
      id: 'ports',
      label: t('deviceDetail.tabs.ports', 'Ports'),
      icon: <Globe className="h-4 w-4" />,
      badge: ports.length > 0 ? <span className="text-xs opacity-75">{ports.length}</span> : undefined,
      render: () => portsBody,
    },
    {
      id: 'checks',
      label: t('deviceDetail.tabs.checks', 'Checks'),
      icon: <ListChecks className="h-4 w-4" />,
      badge: item.hasFailingCheck
        ? <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" aria-label={t('deviceDetail.checksFailing', 'A check fails')} />
        : undefined,
      render: () => (
        <DeviceChecksPanel
          siteId={siteId}
          itemId={item.id}
          focusRuleId={focusRuleId}
          probes={probes?.siteId === siteId ? probes.list : undefined}
          // Run now and the rule link take 'deviceChecks.manage', the probe link 'probes.manage'.
          isAdmin={canManageDeviceChecks}
          canOpenProbes={canManageProbes}
          refreshKey={checksRefresh}
          eventsRefreshKey={checksEventsRefresh}
        />
      ),
    },
    {
      id: 'ip-history',
      label: t('deviceDetail.tabs.ipHistory', 'IP history'),
      icon: <History className="h-4 w-4" />,
      render: () => <DeviceIpHistory itemId={item.id} mac={item.mac} currentIp={item.ip} refreshKey={liveKey} />,
    },
    {
      id: 'flows',
      label: t('deviceDetail.tabs.flows', 'Flows'),
      icon: <Waypoints className="h-4 w-4" />,
      render: () => (
        <DeviceFlowsList
          itemId={item.id}
          ip={item.ip}
          siteId={siteId}
          peers={peers?.siteId === siteId ? peers.map : undefined}
          refreshKey={liveKey}
        />
      ),
    },
  ];
  const activeTab = tabs.find((x) => x.id === tab && !x.hidden) ?? tabs[0];

  return (
    <PageContainer>
      <PageHeader backTo={`/sites/${siteId}`} actions={headerActions}>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <TypeIcon className="h-5 w-5 shrink-0 text-text-muted" aria-hidden="true" />
          {renaming ? (
            <div className="flex min-w-0 items-center gap-1 max-sm:w-full">
              <input
                autoFocus
                value={nameDraft}
                maxLength={255}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveRename();
                  if (e.key === 'Escape') setRenaming(false);
                }}
                placeholder={item.hostname ? anonymize(item.hostname, 'hostname') : anonymize(item.ip, 'ip')}
                aria-label={t('deviceDetail.renameLabel', 'Device name')}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={savingName}
                className="min-w-0 rounded border border-accent bg-bg-tertiary px-2 py-0.5 text-2xl font-semibold text-text-primary focus:outline-none focus:ring-1 focus:ring-accent max-sm:flex-1 max-sm:text-xl"
              />
              <IconButton
                onClick={() => void saveRename()}
                size="sm"
                variant="plain"
                disabled={savingName}
                className="text-green-400 hover:bg-bg-secondary hover:text-green-400"
                label={t('common.save', 'Save')}
                icon={<Check className="h-4 w-4" />}
              />
              <IconButton
                onClick={() => setRenaming(false)}
                size="sm"
                variant="plain"
                className="hover:bg-bg-secondary"
                label={t('common.cancel', 'Cancel')}
                icon={<X className="h-4 w-4" />}
              />
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <h1 className="truncate text-2xl font-semibold text-text-primary max-sm:text-xl">{title}</h1>
              {canWrite && (
                <IconButton
                  onClick={startRename}
                  size="sm"
                  variant="plain"
                  className="hover:bg-bg-secondary"
                  label={t('deviceDetail.rename', 'Rename')}
                  icon={<Pencil className="h-3.5 w-3.5" />}
                />
              )}
            </div>
          )}
          <StatusBadge status={item.status} />
          <LastSeenPill lastSeenAt={item.lastSeenAt} />
          {item.isProbe && (
            <span className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
              <Radar className="h-3 w-3" />
              {t('siteDetail.device.probeBadge', 'Probe')}
            </span>
          )}
          {item.isManual && (
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted">
              {t('siteDetail.device.manualBadge', 'manual')}
            </span>
          )}
        </div>
        <p className="mt-1 break-words text-sm text-text-muted">
          <span className="font-mono">{anonymize(item.ip, 'ip')}</span>
          {item.mac && <> · <span className="font-mono">{anonymize(item.mac, 'mac')}</span></>}
          {item.vendor && <> · {item.vendor}</>}
          {' · '}
          <Link to={`/sites/${siteId}`} className="text-accent hover:underline">{anonymize(detail.site.name, 'hostname')}</Link>
        </p>
      </PageHeader>

      <SegmentedTabs
        tabs={tabs}
        value={activeTab.id}
        onChange={selectTab}
        fill={false}
        className="mb-6"
        ariaLabel={t('deviceDetail.tabsLabel', 'Device sections')}
      />

      {/* Only the active tab is rendered (its data loads on its first view). */}
      <div role="tabpanel">{activeTab.render()}</div>

      {canWrite && editOpen && (
        <DeviceModal
          siteId={siteId}
          item={item}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); void load(); }}
        />
      )}

      {canWrite && reservationOpen && (
        <ReservationModal
          siteId={siteId}
          reservation={reservation}
          prefill={reservation ? undefined : {
            ip: item.ip,
            mac: item.mac,
            itemId: item.id,
            name: item.customName ?? item.hostname ?? '',
            deviceType: item.deviceType !== 'unknown' ? item.deviceType : null,
          }}
          onClose={() => setReservationOpen(false)}
          onSaved={() => { setReservationOpen(false); void load(); }}
        />
      )}

      {tunnelsAllowed && tunnelPort !== null && (
        <TunnelDialog
          siteId={siteId}
          targetIp={item.ip}
          targetPort={tunnelPort}
          onClose={() => setTunnelPort(null)}
        />
      )}
    </PageContainer>
  );
}
