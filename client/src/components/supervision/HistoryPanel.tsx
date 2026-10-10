import { useCallback, useEffect, useMemo, useRef, useState, type ElementType } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertTriangle, ArrowRightLeft, Eraser, History, Pencil, PlusCircle, Radar, RefreshCw, Repeat,
  ShieldAlert, Sparkles, Trash2, User, Wifi, WifiOff,
} from 'lucide-react';
import { ITEM_EVENT_KINDS, type GroupTreeNode, type ItemEventKind, type SiteItemEvent } from '@oblimap/shared';
import { eventsApi } from '@/api/events.api';
import { siteApi, type SiteListItem } from '@/api/site.api';
import { useGroupStore } from '@/store/groupStore';
import { useTenantStore } from '@/store/tenantStore';
import { useIpamLiveRefresh } from '@/hooks/useIpamLiveRefresh';
import { findGroupNode } from '@/hooks/useFreshSitePermissions';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadError } from '@/components/common/LoadError';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { IconButton } from '@/components/common/IconButton';
import { useAnonymize, type anonymize as anonymizeFnType } from '@/utils/anonymize';
import { deviceTypeLabel } from '@/utils/deviceTypes';
import { cn } from '@/utils/cn';

/*
 * Device event history (site_item_events, migration 052) on Obliance's
 * HistoryPage pattern: filters on top, events newest first grouped by day,
 * one line per event with its kind, the device (link to its page), the site
 * and who caused it (user or probe).
 *
 *  - HistoryPanel: the tenant's history (/history), limited by the server
 *    to the sites the user may read; group / site / kind / period filters;
 *    live refresh on IPAM socket events (SITE_UPDATED…).
 *  - DeviceActivityPanel: one device's history (device page, Activity tab).
 *
 * Every IP, MAC and name goes through anonymize() (anonymous mode).
 */

type AnonymizeFn = typeof anonymizeFnType;

// ─── Kinds ────────────────────────────────────────────────────────────────────

/** Icon, colour and English label (fallback of itemEvents.kinds.<kind>) of each kind. */
const KIND_META: Record<ItemEventKind, { Icon: ElementType; color: string; bg: string; label: string }> = {
  discovered: { Icon: Sparkles, color: 'text-blue-400', bg: 'bg-blue-400/10', label: 'Discovered' },
  ip_changed: { Icon: ArrowRightLeft, color: 'text-violet-400', bg: 'bg-violet-400/10', label: 'IP changed' },
  offline: { Icon: WifiOff, color: 'text-red-400', bg: 'bg-red-400/10', label: 'Offline' },
  online: { Icon: Wifi, color: 'text-green-400', bg: 'bg-green-400/10', label: 'Back online' },
  takeover: { Icon: ShieldAlert, color: 'text-amber-400', bg: 'bg-amber-400/10', label: 'IP takeover' },
  ip_reassigned: { Icon: Repeat, color: 'text-sky-400', bg: 'bg-sky-400/10', label: 'IP reassigned' },
  created: { Icon: PlusCircle, color: 'text-accent', bg: 'bg-accent/10', label: 'Added manually' },
  edited: { Icon: Pencil, color: 'text-text-secondary', bg: 'bg-bg-tertiary', label: 'Edited' },
  deleted: { Icon: Trash2, color: 'text-red-400', bg: 'bg-red-400/10', label: 'Deleted' },
  purged: { Icon: Eraser, color: 'text-orange-400', bg: 'bg-orange-400/10', label: 'Purged (stale)' },
};

function kindMeta(kind: string) {
  return KIND_META[kind as ItemEventKind] ?? { Icon: AlertTriangle, color: 'text-text-muted', bg: 'bg-bg-tertiary', label: kind };
}

export function itemEventKindLabel(t: TFunction, kind: string): string {
  return t(`itemEvents.kinds.${kind}`, kindMeta(kind).label);
}

/** English fallbacks of itemEvents.fields.<field> (fields of an 'edited' event). */
const FIELD_LABELS: Record<string, string> = {
  customName: 'name',
  deviceType: 'type',
  notes: 'notes',
  status: 'status',
  alertMode: 'alerts',
};

// ─── Periods ──────────────────────────────────────────────────────────────────

const PERIODS = ['24h', '7d', '30d'] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_MS: Record<Period, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
};
const PERIOD_FALLBACK: Record<Period, string> = { '24h': '24 h', '7d': '7 days', '30d': '30 days' };

/** Most events one view asks for (the server's maximum). */
const EVENTS_LIMIT = 500;

function periodLabel(t: TFunction, p: Period): string {
  return t(`history.periods.${p}`, PERIOD_FALLBACK[p]);
}

function PeriodSelector({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex rounded-md bg-bg-tertiary p-0.5" role="group" aria-label={t('history.period', 'Period')}>
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          aria-pressed={value === p}
          onClick={() => onChange(p)}
          className={cn(
            'rounded px-2.5 py-1 text-xs font-medium transition-colors',
            value === p ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary',
          )}
        >
          {periodLabel(t, p)}
        </button>
      ))}
    </div>
  );
}

// ─── Event lines ──────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** One-line description of the event's details (anonymized), or null. */
function describeEvent(e: SiteItemEvent, t: TFunction, anonymize: AnonymizeFn): string | null {
  const d = e.details ?? {};
  switch (e.kind) {
    case 'ip_changed': {
      const oldIp = str(d.oldIp);
      const newIp = str(d.newIp) ?? e.ip;
      if (!newIp) return null;
      return oldIp
        ? t('itemEvents.details.ipChanged', { oldIp: anonymize(oldIp, 'ip'), newIp: anonymize(newIp, 'ip'), defaultValue: '{{oldIp}} → {{newIp}}' })
        : t('itemEvents.details.ipNow', { ip: anonymize(newIp, 'ip'), defaultValue: 'Now {{ip}}' });
    }
    case 'offline': {
      const missed = num(d.missedScans);
      return missed !== null
        ? t('itemEvents.details.missedScans', { count: missed, defaultValue: 'After {{count}} scans without an answer' })
        : null;
    }
    case 'takeover':
    case 'ip_reassigned': {
      const oldMac = str(d.oldMac);
      return oldMac
        ? t('itemEvents.details.previousOwner', { mac: anonymize(oldMac, 'mac'), defaultValue: 'Previously used by {{mac}}' })
        : null;
    }
    case 'discovered': {
      const parts = [str(d.vendor), str(d.hostname) ? anonymize(str(d.hostname), 'hostname') : null].filter(Boolean);
      const type = str(d.deviceType);
      if (type && type !== 'unknown') parts.push(deviceTypeLabel(t, type));
      return parts.length > 0 ? parts.join(' · ') : null;
    }
    case 'created': {
      const type = str(d.deviceType);
      return type && type !== 'unknown' ? deviceTypeLabel(t, type) : null;
    }
    case 'edited': {
      const fields = Array.isArray(d.fields) ? d.fields.filter((f): f is string => typeof f === 'string') : [];
      if (fields.length === 0) return null;
      const labels = fields.map((f) => t(`itemEvents.fields.${f}`, FIELD_LABELS[f] ?? f));
      return t('itemEvents.details.changed', { fields: labels.join(', '), defaultValue: 'Changed: {{fields}}' });
    }
    case 'purged': {
      const days = num(d.staleDeviceDays);
      return days !== null
        ? t('itemEvents.details.staleDays', { count: days, defaultValue: 'Not seen for {{count}} days' })
        : null;
    }
    case 'deleted': {
      const subnet = str(d.subnet);
      return subnet ? t('itemEvents.details.subnetDeleted', { subnet: anonymize(subnet, 'ip'), defaultValue: 'Subnet {{subnet}} deleted' }) : null;
    }
    default:
      return null;
  }
}

/** Display name of the event's device (anonymized). */
function deviceLabel(e: SiteItemEvent, anonymize: AnonymizeFn): string {
  const name = e.itemName ?? str(e.details?.name);
  if (name) return anonymize(name, /^(?:\d{1,3}\.){3}\d{1,3}$/.test(name) ? 'ip' : 'hostname');
  if (e.ip) return anonymize(e.ip, 'ip');
  if (e.mac) return anonymize(e.mac, 'mac');
  return '—';
}

function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'invalid';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayHeading(key: string, sample: string, t: TFunction, locale: string): string {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 3_600_000);
  if (key === localDayKey(today.toISOString())) return t('history.today', 'Today');
  if (key === localDayKey(yesterday.toISOString())) return t('history.yesterday', 'Yesterday');
  const d = new Date(sample);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function timeOf(iso: string, locale: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '—';
}

export interface EventTimelineProps {
  events: SiteItemEvent[];
  /** Device name / link on each line (off on the device's own page). */
  showDevice?: boolean;
  /** Site link on each line. */
  showSite?: boolean;
}

/** Events grouped by local day, newest first (as the server sends them). */
export function EventTimeline({ events, showDevice = true, showSite = true }: EventTimelineProps) {
  const { t, i18n } = useTranslation();
  const { anonymize } = useAnonymize();

  const days = useMemo(() => {
    const out: Array<{ key: string; sample: string; events: SiteItemEvent[] }> = [];
    for (const e of events) {
      const key = localDayKey(e.createdAt);
      const last = out[out.length - 1];
      if (last && last.key === key) last.events.push(e);
      else out.push({ key, sample: e.createdAt, events: [e] });
    }
    return out;
  }, [events]);

  return (
    <div className="space-y-5">
      {days.map((day) => (
        <section key={day.key}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
            {dayHeading(day.key, day.sample, t, i18n.language)}
          </h3>
          <ul className="divide-y divide-border/60 rounded-xl bg-bg-secondary shadow-[var(--shadow-card)]">
            {day.events.map((e) => {
              const meta = kindMeta(e.kind);
              const description = describeEvent(e, t, anonymize);
              const device = deviceLabel(e, anonymize);
              return (
                <li key={e.id} className="flex items-start gap-3 px-4 py-2.5">
                  <span className="w-12 shrink-0 pt-0.5 font-mono text-xs text-text-muted" title={new Date(e.createdAt).toLocaleString(i18n.language)}>
                    {timeOf(e.createdAt, i18n.language)}
                  </span>
                  <span className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full', meta.bg)} aria-hidden="true">
                    <meta.Icon className={cn('h-3.5 w-3.5', meta.color)} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                      <span className={cn('font-medium', meta.color)}>{itemEventKindLabel(t, e.kind)}</span>
                      {showDevice && (
                        e.itemId !== null ? (
                          <Link to={`/sites/${e.siteId}/devices/${e.itemId}`} className="min-w-0 truncate text-text-primary hover:text-accent hover:underline">
                            {device}
                          </Link>
                        ) : (
                          <span className="min-w-0 truncate text-text-secondary">{device}</span>
                        )
                      )}
                      {showDevice && e.ip && device !== anonymize(e.ip, 'ip') && (
                        <span className="font-mono text-xs text-text-muted">{anonymize(e.ip, 'ip')}</span>
                      )}
                      {!showDevice && e.mac && (
                        <span className="font-mono text-xs text-text-muted">{anonymize(e.mac, 'mac')}</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-muted">
                      {description && <span className="break-words [overflow-wrap:anywhere]">{description}</span>}
                      {showSite && (
                        <Link to={`/sites/${e.siteId}`} className="text-accent hover:underline">
                          {anonymize(e.siteName, 'hostname')}
                        </Link>
                      )}
                      {e.actorUserId !== null ? (
                        <span className="inline-flex items-center gap-1">
                          <User className="h-3 w-3" aria-hidden="true" />
                          {e.actorUsername
                            ? anonymize(e.actorUsername, 'username')
                            : t('history.deletedUser', 'Deleted user')}
                        </span>
                      ) : e.probeId !== null ? (
                        <span className="inline-flex items-center gap-1">
                          <Radar className="h-3 w-3" aria-hidden="true" />
                          {e.probeName ? anonymize(e.probeName, 'hostname') : t('history.deletedProbe', 'Deleted probe')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** A refresh failed while earlier results of the same filters are shown. */
function RefreshFailedNotice({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
      <span>{t('history.refreshFailed', 'Could not refresh the history: the events below may be out of date.')}</span>
      <button type="button" onClick={onRetry} className="font-medium underline hover:no-underline">
        {t('common.retry', 'Retry')}
      </button>
    </div>
  );
}

function TruncatedNotice() {
  const { t } = useTranslation();
  return (
    <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
      {t('history.truncated', 'Only the most recent events are shown. Narrow the filters or the period to see older ones.')}
    </p>
  );
}

// ─── Shared loader ────────────────────────────────────────────────────────────

interface EventsState {
  events: SiteItemEvent[];
  truncated: boolean;
  loading: boolean;
  failed: boolean;
}

const INITIAL_STATE: EventsState = { events: [], truncated: false, loading: true, failed: false };

/**
 * Loads events with `fetcher` whenever it changes (a new filter), dropping
 * late answers of earlier requests. `reload` refetches silently.
 * `resetKey` names the filters (not the time window): when it changes, the
 * previous results are cleared so a failed request never leaves another
 * filter's (or another workspace's) events on screen as the current answer.
 */
function useEventsLoader(
  fetcher: ((signal: AbortSignal) => Promise<{ events: SiteItemEvent[]; truncated: boolean }>) | null,
  resetKey: string,
) {
  const [state, setState] = useState<EventsState>(INITIAL_STATE);
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const resetKeyRef = useRef(resetKey);

  const run = useCallback(async (silent: boolean) => {
    abortRef.current?.abort();
    const seq = ++seqRef.current;
    if (!fetcher) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey;
      setState(INITIAL_STATE);
    } else if (!silent) {
      setState((s) => ({ ...s, loading: true, failed: false }));
    }
    try {
      const res = await fetcher(ctrl.signal);
      if (seq !== seqRef.current) return;
      setState({ events: res.events ?? [], truncated: !!res.truncated, loading: false, failed: false });
    } catch {
      if (seq !== seqRef.current || ctrl.signal.aborted) return;
      setState((s) => ({ ...s, loading: false, failed: true }));
    }
  }, [fetcher, resetKey]);

  useEffect(() => {
    void run(false);
  }, [run]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { ...state, reload: (silent = true) => void run(silent) };
}

// ─── Tenant history (/history) ────────────────────────────────────────────────

/** Groups of the tree, depth-first, with their depth (select options). */
function flattenGroups(nodes: GroupTreeNode[], depth = 0, out: Array<{ id: number; name: string; depth: number }> = []) {
  for (const n of nodes) {
    out.push({ id: n.id, name: n.name, depth });
    flattenGroups(n.children ?? [], depth + 1, out);
  }
  return out;
}

function subtreeIds(node: GroupTreeNode, out: Set<number> = new Set()): Set<number> {
  out.add(node.id);
  for (const c of node.children ?? []) subtreeIds(c, out);
  return out;
}

const SELECT_CLASS = 'min-w-0 max-w-full rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';

export function HistoryPanel() {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const tenantId = useTenantStore((s) => s.currentTenantId);
  const tree = useGroupStore((s) => s.tree);
  const fetchTree = useGroupStore((s) => s.fetchTree);

  const [groupId, setGroupId] = useState<number | null>(null);
  const [siteId, setSiteId] = useState<number | null>(null);
  const [kinds, setKinds] = useState<ItemEventKind[]>([]);
  const [period, setPeriod] = useState<Period>('24h');
  const [sites, setSites] = useState<SiteListItem[]>([]);
  // Bumped to recompute the window ("the last 24 h" moves with time).
  const [windowTick, setWindowTick] = useState(0);

  // Another tenant: its own groups / sites (ids never overlap).
  useEffect(() => {
    setGroupId(null);
    setSiteId(null);
    let cancelled = false;
    siteApi.list()
      .then((r) => { if (!cancelled) setSites(r.sites); })
      .catch(() => { if (!cancelled) setSites([]); });
    if (useGroupStore.getState().tree.length === 0) void fetchTree();
    return () => { cancelled = true; };
  }, [tenantId, fetchTree]);

  const groupOptions = useMemo(() => flattenGroups(tree), [tree]);
  const siteOptions = useMemo(() => {
    const list = groupId === null
      ? sites
      : (() => {
        const node = findGroupNode(tree, groupId);
        const ids = node ? subtreeIds(node) : new Set([groupId]);
        return sites.filter((s) => s.groupId !== null && ids.has(s.groupId));
      })();
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [sites, tree, groupId]);

  // A site outside the chosen group is dropped.
  useEffect(() => {
    if (siteId !== null && sites.length > 0 && !siteOptions.some((s) => s.id === siteId)) setSiteId(null);
  }, [siteId, siteOptions, sites.length]);

  const kindsKey = kinds.join(',');
  const fetcher = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - PERIOD_MS[period]);
    const selectedKinds = kindsKey ? (kindsKey.split(',') as ItemEventKind[]) : [];
    return (signal: AbortSignal) => eventsApi.list({
      ...(siteId !== null ? { siteId } : groupId !== null ? { groupId } : {}),
      kinds: selectedKinds,
      from: from.toISOString(),
      to: to.toISOString(),
      limit: EVENTS_LIMIT,
    }, signal);
    // windowTick: a refresh moves the window to now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, groupId, kindsKey, period, windowTick, tenantId]);

  const { events, truncated, loading, failed, reload } = useEventsLoader(
    fetcher,
    `${tenantId}|${siteId}|${groupId}|${kindsKey}|${period}`,
  );

  // Live: probe pushes (SITE_UPDATED), status changes, new devices, tree
  // changes, resyncs, tenant switches → the window moves to now.
  useIpamLiveRefresh(() => setWindowTick((n) => n + 1), 3000);

  const toggleKind = (k: ItemEventKind) => {
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  };

  const filtered = siteId !== null || groupId !== null || kinds.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <label htmlFor="history-group" className="mb-1 block text-xs text-text-muted">{t('history.group', 'Group')}</label>
          <select
            id="history-group"
            value={groupId ?? ''}
            onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : null)}
            className={cn(SELECT_CLASS, 'w-56')}
          >
            <option value="">{t('history.allGroups', 'All groups')}</option>
            {groupOptions.map((g) => (
              <option key={g.id} value={g.id}>
                {`${'  '.repeat(g.depth)}${anonymize(g.name, 'hostname')}`}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="history-site" className="mb-1 block text-xs text-text-muted">{t('history.site', 'Site')}</label>
          <select
            id="history-site"
            value={siteId ?? ''}
            onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : null)}
            className={cn(SELECT_CLASS, 'w-56')}
          >
            <option value="">{t('history.allSites', 'All sites')}</option>
            {siteOptions.map((s) => (
              <option key={s.id} value={s.id}>{anonymize(s.name, 'hostname')}</option>
            ))}
          </select>
        </div>
        <div>
          <span className="mb-1 block text-xs text-text-muted">{t('history.period', 'Period')}</span>
          <PeriodSelector value={period} onChange={setPeriod} />
        </div>
        <div className="ml-auto">
          <IconButton
            label={t('common.refresh', 'Refresh')}
            icon={<RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />}
            size="md"
            onClick={() => setWindowTick((n) => n + 1)}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('history.kinds', 'Event kinds')}>
        <button
          type="button"
          aria-pressed={kinds.length === 0}
          onClick={() => setKinds([])}
          className={cn(
            'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
            kinds.length === 0 ? 'border-accent bg-accent/15 text-accent' : 'border-border text-text-muted hover:text-text-primary',
          )}
        >
          {t('history.allKinds', 'All events')}
        </button>
        {ITEM_EVENT_KINDS.map((k) => {
          const meta = kindMeta(k);
          const on = kinds.includes(k);
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              onClick={() => toggleKind(k)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                on ? cn('border-current', meta.bg, meta.color) : 'border-border text-text-muted hover:text-text-primary',
              )}
            >
              <meta.Icon className="h-3 w-3" aria-hidden="true" />
              {itemEventKindLabel(t, k)}
            </button>
          );
        })}
      </div>

      {loading && events.length === 0 ? (
        <div className="flex h-40 items-center justify-center"><LoadingSpinner /></div>
      ) : failed && events.length === 0 ? (
        <LoadError message={t('history.loadFailed', 'Could not load the history.')} onRetry={() => reload(false)} />
      ) : events.length === 0 ? (
        <EmptyState
          icon={<History className="h-6 w-6" />}
          title={t('history.empty', 'No event in this period')}
          description={filtered
            ? t('history.emptyFiltered', 'Nothing matches these filters. Widen the period or clear a filter.')
            : t('history.emptyHint', 'Devices discovered, going offline or back online, IP changes and manual edits on the sites you can see are listed here.')}
        />
      ) : (
        <>
          {failed && <RefreshFailedNotice onRetry={() => reload(false)} />}
          {truncated && <TruncatedNotice />}
          <EventTimeline events={events} />
        </>
      )}
    </div>
  );
}

// ─── One device (device page, Activity tab) ───────────────────────────────────

export interface DeviceActivityPanelProps {
  itemId: number;
  /** Bumped by the page on live events: reloads silently. */
  refreshKey?: number;
}

export function DeviceActivityPanel({ itemId, refreshKey = 0 }: DeviceActivityPanelProps) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>('30d');
  const [windowTick, setWindowTick] = useState(0);

  const fetcher = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - PERIOD_MS[period]);
    return (signal: AbortSignal) => eventsApi.forItem(itemId, {
      from: from.toISOString(),
      to: to.toISOString(),
      limit: EVENTS_LIMIT,
    }, signal);
    // windowTick / refreshKey: a refresh moves the window to now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, period, windowTick, refreshKey]);

  const { events, truncated, loading, failed, reload } = useEventsLoader(fetcher, `${itemId}|${period}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodSelector value={period} onChange={setPeriod} />
        <IconButton
          label={t('common.refresh', 'Refresh')}
          icon={<RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />}
          size="md"
          onClick={() => setWindowTick((n) => n + 1)}
        />
      </div>
      {loading && events.length === 0 ? (
        <div className="flex h-32 items-center justify-center"><LoadingSpinner /></div>
      ) : failed && events.length === 0 ? (
        <LoadError message={t('history.loadFailed', 'Could not load the history.')} onRetry={() => reload(false)} />
      ) : events.length === 0 ? (
        <EmptyState
          icon={<History className="h-6 w-6" />}
          title={t('history.empty', 'No event in this period')}
          description={t('deviceDetail.activity.emptyHint', 'Discovery, offline / online changes, IP changes and manual edits of this device are listed here.')}
        />
      ) : (
        <>
          {failed && <RefreshFailedNotice onRetry={() => reload(false)} />}
          {truncated && <TruncatedNotice />}
          <EventTimeline events={events} showDevice={false} showSite={false} />
        </>
      )}
    </div>
  );
}
