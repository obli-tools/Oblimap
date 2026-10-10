import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Pencil, Trash2, AlertTriangle, Info, FileDown, FileSpreadsheet, Radar, Network,
  ExternalLink, EyeOff, ChevronUp, ChevronDown, ChevronsUpDown, ChevronRight, ChevronLeft, Activity,
  Globe, Search, X, FilterX, Download, BookmarkPlus, BookmarkCheck, Sparkles, Clock, FileQuestion, History,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type {
  SiteItem, IpReservation, ItemStatus, DeviceCheckSummary, DeviceType,
} from '@oblimap/shared';
import { clsx } from 'clsx';
import type { SiteProbe } from '@/api/site.api';
import {
  countUsedHosts, longestMatch, parseCidr, parseSiteSubnets, usableHosts, utilisationTone,
  type Ipv4Net, type SiteSubnet,
} from '@/api/siteSubnets.api';
import { itemsApi, type ItemBulkRequest, type ItemListParams, type ItemListResponse, type ItemSortKey } from '@/api/items.api';
import { deviceChecksApi } from '@/api/deviceChecks.api';
import { useAnonymize } from '@/utils/anonymize';
import { itemMatchesSearch } from '@/utils/itemSearch';
import { DEVICE_TYPE_OPTIONS, deviceTypeIcon, deviceTypeLabel } from '@/utils/deviceTypes';
import { formatRelative } from '@/utils/formatRelative';
import { storageGetJson, storageSet, storageSetJson } from '@/utils/safeStorage';
import { exportSiteCSV, exportSiteExcel, reservationStateLabel, reservationStateOf } from '@/utils/exportSite';
import { toastApiError } from '@/utils/apiError';
import { useSessionState } from '@/hooks/useSessionState';
import { useIpamLiveRefresh } from '@/hooks/useIpamLiveRefresh';
import { useTenantCapability } from '@/store/authStore';
import { useGroupStore } from '@/store/groupStore';
import { WEB_PORTS } from '@/components/ipam/TunnelDialog';
import { DeviceCheckChip } from '@/components/deviceChecks/DeviceCheckChip';
import { deviceCheckSeverityRank } from '@/components/deviceChecks/DeviceChecksDrawer';
import { BulkActionBar } from '@/components/devices/BulkActionBar';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadError } from '@/components/common/LoadError';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { ActionMenu } from '@/components/common/ActionMenu';
import { IconButton } from '@/components/common/IconButton';

/**
 * Device table shared by the site Devices tab and the cross-site /devices
 * list (ported from Obliance components/devices/DeviceTable.tsx): debounced
 * search, status / type chips with counts, vendor and probe filters, quick
 * filters (new, undocumented, conflicts, failing checks, stale),
 * clear-filters, filters seeded from the URL (?q=&status=&type=…) and kept
 * in sessionStorage per `stateKey`, sortable columns, a selection column
 * with a bulk action bar, and a translated export menu.
 *
 *  - mode 'local' (site tab): every filter runs on the `items` given, rows
 *    grouped by the longest matching site subnet (`subnets`), else by /24
 *    (persisted collapse state, paging per subnet, per-subnet select-all,
 *    utilisation bar in the subnet header).
 *  - mode 'server' (/devices): GET /api/items with the filters, server
 *    facets for the chip counts, server paging (?page=) and sort (?sort=&dir=),
 *    site and group columns. `scope` adds the page's site / group filter.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Rows rendered per subnet before "Show more". */
const PAGE_SIZE = 200;
/** Rows per server page. */
const SERVER_PAGE_SIZE = 100;
/** Ids per bulk request (server ITEM_BULK_MAX_IDS). */
const BULK_CHUNK = 1000;
/** Deleting more rows than this asks to type the count. */
const DELETE_TYPE_TO_CONFIRM_OVER = 20;
/** "Run checks now" starts at most this many checks (run-now is per check, rate-limited). */
const RUN_CHECKS_MAX = 20;
/** Chips shown in a device row before "+N". */
const MAX_ROW_CHIPS = 2;
const STALE_DAYS = 30;
const DAY_MS = 86_400_000;
/** Server limit of the search / vendor texts. */
const SERVER_TEXT_MAX = 100;

const STATUS_ORDER: readonly ItemStatus[] = ['online', 'offline', 'reserved', 'unknown'];

/** '' | '24h' | '7d' | an ISO timestamp ("new since my last visit"). */
type NewWithin = string;
type SortKey = 'ip' | 'mac' | 'name' | 'vendor' | 'type' | 'lastSeen' | 'site';
type SortDir = 'asc' | 'desc';
interface SortState { key: SortKey; dir: SortDir }

const SORT_KEYS: readonly SortKey[] = ['ip', 'mac', 'name', 'vendor', 'type', 'lastSeen', 'site'];
/** Columns the server can sort on (GET /api/items ?sort=). */
const SERVER_SORT_KEYS: ReadonlySet<SortKey> = new Set<SortKey>(['ip', 'name', 'lastSeen', 'site']);
const ALL_SORT_KEYS: ReadonlySet<SortKey> = new Set<SortKey>(SORT_KEYS);

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** A valid ?new= value (else ''). */
function parseNewWithin(v: string | null | undefined): NewWithin {
  if (!v) return '';
  if (v === '24h' || v === '7d') return v;
  if (v.length <= 40 && ISO_RE.test(v) && Number.isFinite(Date.parse(v))) return v;
  return '';
}

/** Lower bound of first seen for a ?new= value, or null. */
function newCutOf(v: NewWithin, now: number): number | null {
  if (v === '24h') return now - DAY_MS;
  if (v === '7d') return now - 7 * DAY_MS;
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

// ─── Device checks helpers ────────────────────────────────────────────────────

export function sortChecks(checks: readonly DeviceCheckSummary[] | undefined): DeviceCheckSummary[] {
  return [...(checks ?? [])].sort((a, b) => deviceCheckSeverityRank(a) - deviceCheckSeverityRank(b));
}

export function isFailingCheck(c: DeviceCheckSummary): boolean {
  return c.status === 'fail' || c.status === 'error';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusDot(status: SiteItem['status']) {
  const map: Record<string, string> = {
    online: 'bg-emerald-500',
    offline: 'bg-red-500',
    reserved: 'bg-blue-500',
    unknown: 'bg-zinc-500',
  };
  return map[status] ?? 'bg-zinc-500';
}

function statusBadge(status: SiteItem['status']) {
  const map: Record<string, string> = {
    online: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    offline: 'bg-red-500/15 text-red-400 border-red-500/30',
    reserved: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    unknown: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  };
  return map[status] ?? 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
}

/** Parse an IPv4 address to a comparable number (for sorting). */
function ipToNum(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return 0;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Extract the /24 subnet prefix from an IPv4 address (e.g. "192.168.1"). */
function subnetOf(ip: string): string {
  const parts = ip.split('.');
  if (parts.length === 4) return parts.slice(0, 3).join('.');
  return ip; // non-v4 fallback
}

function sameMac(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
}

function timeOf(ts: string | null | undefined): number {
  if (!ts) return 0;
  const n = new Date(ts).getTime();
  return Number.isNaN(n) ? 0 : n;
}

function compareSiteItems(
  a: SiteItem,
  b: SiteItem,
  key: SortKey,
  dir: SortDir,
  siteNames: ReadonlyMap<number, string> | undefined,
): number {
  let cmp = 0;
  switch (key) {
    case 'ip':
      cmp = ipToNum(a.ip) - ipToNum(b.ip);
      break;
    case 'mac':
      cmp = (a.mac ?? '').localeCompare(b.mac ?? '');
      break;
    case 'name': {
      const an = (a.customName ?? a.hostname ?? '').toLowerCase();
      const bn = (b.customName ?? b.hostname ?? '').toLowerCase();
      cmp = an.localeCompare(bn);
      break;
    }
    case 'vendor':
      cmp = (a.vendor ?? '').localeCompare(b.vendor ?? '');
      break;
    case 'type':
      cmp = (a.deviceType ?? '').localeCompare(b.deviceType ?? '');
      break;
    case 'lastSeen':
      cmp = timeOf(a.lastSeenAt) - timeOf(b.lastSeenAt);
      break;
    case 'site':
      cmp = (siteNames?.get(a.siteId) ?? '').localeCompare(siteNames?.get(b.siteId) ?? '')
        || ipToNum(a.ip) - ipToNum(b.ip);
      break;
  }
  return dir === 'desc' ? -cmp : cmp;
}

// ─── URL / session state ──────────────────────────────────────────────────────

interface FilterState {
  search: string;
  statuses: Set<string>;
  types: Set<string>;
  vendor: string;
  probe: string;
  newWithin: NewWithin;
  failingOnly: boolean;
  hideOffline: boolean;
  staleOnly: boolean;
  /** Reservation conflict (server: or an unresolved IP takeover). */
  conflictOnly: boolean;
  /** No name, unknown type, IP not reserved. */
  undocumented: boolean;
}

const DEFAULT_FILTERS: FilterState = {
  search: '',
  statuses: new Set(),
  types: new Set(),
  vendor: '',
  probe: '',
  newWithin: '',
  failingOnly: false,
  hideOffline: false,
  staleOnly: false,
  conflictOnly: false,
  undocumented: false,
};

/** Query parameters read and written by the table (the page keeps its others). */
const URL_KEYS = [
  'q', 'status', 'type', 'vendor', 'probe', 'new', 'checks', 'stale', 'offline', 'conflict', 'undocumented',
] as const;
/** Server mode only: paging and sort in the URL. */
const SERVER_URL_KEYS = ['page', 'sort', 'dir'] as const;

function listParam(v: string | null, allowed?: readonly string[]): Set<string> {
  if (!v) return new Set();
  const values = v.split(',').map((s) => s.trim()).filter((s) => s && s.length <= 32);
  return new Set(allowed ? values.filter((s) => allowed.includes(s)) : values);
}

/**
 * Filters given by the URL, or null when it carries none (the session state
 * applies). `seedKeys`: other parameters that also mean "a link chose this
 * view" (e.g. the page's ?groupId=), so the session filters do not apply.
 */
function readUrlFilters(params: URLSearchParams, seedKeys: readonly string[]): FilterState | null {
  if (![...URL_KEYS, ...seedKeys].some((k) => params.has(k))) return null;
  const probe = params.get('probe');
  const stale = params.get('stale');
  return {
    search: (params.get('q') ?? '').slice(0, 200),
    statuses: listParam(params.get('status'), STATUS_ORDER),
    types: listParam(params.get('type'), DEVICE_TYPE_OPTIONS),
    vendor: (params.get('vendor') ?? '').slice(0, 200),
    probe: probe && /^[1-9]\d{0,15}$/.test(probe) ? probe : '',
    newWithin: parseNewWithin(params.get('new')),
    failingOnly: params.get('checks') === 'failing',
    staleOnly: stale !== null && /^[1-9]\d{0,4}$/.test(stale),
    hideOffline: params.get('offline') === 'hide',
    conflictOnly: params.get('conflict') === '1' || params.get('conflict') === 'true',
    undocumented: params.get('undocumented') === '1' || params.get('undocumented') === 'true',
  };
}

/** The filters as query parameters (empty values removed). */
function filtersToParams(f: FilterState): Record<(typeof URL_KEYS)[number], string | null> {
  const q = f.search.trim();
  return {
    q: q || null,
    status: f.statuses.size ? [...f.statuses].join(',') : null,
    type: f.types.size ? [...f.types].join(',') : null,
    vendor: f.vendor || null,
    probe: f.probe || null,
    new: f.newWithin || null,
    checks: f.failingOnly ? 'failing' : null,
    stale: f.staleOnly ? '1' : null,
    offline: f.hideOffline ? 'hide' : null,
    conflict: f.conflictOnly ? '1' : null,
    undocumented: f.undocumented ? '1' : null,
  };
}

function sessionKeys(stateKey: string) {
  const p = `oblimap:devtable:${stateKey}:`;
  return {
    search: `${p}search`,
    statuses: `${p}statuses`,
    types: `${p}types`,
    vendor: `${p}vendor`,
    probe: `${p}probe`,
    newWithin: `${p}new`,
    failingOnly: `${p}failing`,
    hideOffline: `${p}hideOffline`,
    staleOnly: `${p}stale`,
    conflictOnly: `${p}conflict`,
    undocumented: `${p}undocumented`,
    sort: `${p}sort`,
  };
}

/** Writes URL-given filters into the session slots (so useSessionState reads them). */
function seedSession(keys: ReturnType<typeof sessionKeys>, f: FilterState): void {
  storageSet(keys.search, JSON.stringify(f.search), 'session');
  storageSet(keys.statuses, JSON.stringify({ __set: [...f.statuses] }), 'session');
  storageSet(keys.types, JSON.stringify({ __set: [...f.types] }), 'session');
  storageSet(keys.vendor, JSON.stringify(f.vendor), 'session');
  storageSet(keys.probe, JSON.stringify(f.probe), 'session');
  storageSet(keys.newWithin, JSON.stringify(f.newWithin), 'session');
  storageSet(keys.failingOnly, JSON.stringify(f.failingOnly), 'session');
  storageSet(keys.hideOffline, JSON.stringify(f.hideOffline), 'session');
  storageSet(keys.staleOnly, JSON.stringify(f.staleOnly), 'session');
  storageSet(keys.conflictOnly, JSON.stringify(f.conflictOnly), 'session');
  storageSet(keys.undocumented, JSON.stringify(f.undocumented), 'session');
}

/** Sort given by the URL (server mode), or null. */
function readUrlSort(params: URLSearchParams): SortState | null {
  const key = params.get('sort') as SortKey | null;
  if (!key || !SERVER_SORT_KEYS.has(key)) return null;
  return { key, dir: params.get('dir') === 'desc' ? 'desc' : 'asc' };
}

/** Page given by the URL (server mode). */
function readUrlPage(params: URLSearchParams): number {
  const raw = params.get('page');
  return raw && /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : 1;
}

/** A Set read back from the session (older or corrupt entries read as empty). */
function asSet(v: unknown): Set<string> {
  return v instanceof Set ? v : new Set();
}

// ─── Open ports badges ────────────────────────────────────────────────────────

// Web ports that get a clickable http/https link
const WEB_PORT_MAP: Record<number, 'http' | 'https'> = {
  80: 'http', 443: 'https', 8080: 'http', 8443: 'https',
};

const PortBadges = memo(function PortBadges({
  ip,
  ports,
  onTunnel,
}: {
  ip: string;
  ports: number[] | null | undefined;
  onTunnel?: (ip: string, port: number) => void;
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  if (!ports || ports.length === 0) return null;
  const shownIp = anonymize(ip, 'ip');
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {ports.map((port) => {
        const scheme = WEB_PORT_MAP[port];
        if (scheme) {
          const hostPart = port === 80 || port === 443 ? '' : `:${port}`;
          const url = `${scheme}://${ip}${hostPart}`;
          // The tunnel is offered on web ports only: the dialog can open
          // their UI; nothing on the page can use a raw TCP tunnel yet.
          const tunnelHere = onTunnel && WEB_PORTS.has(port) ? onTunnel : undefined;
          if (tunnelHere) {
            // Proxy first: the chip opens the access dialog (Proxy / Local tabs).
            return (
              <button
                key={port}
                type="button"
                onClick={(e) => { e.stopPropagation(); tunnelHere(ip, port); }}
                title={t('siteDetail.device.webAccess', { ip: shownIp, port, defaultValue: 'Open {{ip}}:{{port}} (proxy or local)' })}
                className="inline-flex items-center gap-0.5 rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent transition-colors hover:bg-accent/20"
              >
                {port}
                <Globe size={8} />
              </button>
            );
          }
          // No tunnel right here: the direct link is the only access.
          return (
            <a
              key={port}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={t('siteDetail.device.openUrl', { url: `${scheme}://${shownIp}${hostPart}`, defaultValue: 'Open {{url}}' })}
              className="inline-flex items-center gap-0.5 rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 font-mono text-[10px] text-blue-400 transition-colors hover:bg-blue-500/20"
            >
              {port}
              <ExternalLink size={8} />
            </a>
          );
        }
        return (
          <span
            key={port}
            className="inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary"
          >
            {port}
          </span>
        );
      })}
    </div>
  );
});

// ─── Table pieces (module scope: stable component types) ─────────────────────

function DeviceTypeIcon({ type, size = 12 }: { type: string; size?: number }) {
  const Icon = deviceTypeIcon(type);
  return <Icon size={size} />;
}

function SortIcon({ col, sort }: { col: SortKey; sort: SortState }) {
  if (sort.key !== col) return <ChevronsUpDown size={12} className="text-text-muted/40" />;
  return sort.dir === 'asc'
    ? <ChevronUp size={12} className="text-accent" />
    : <ChevronDown size={12} className="text-accent" />;
}

function SortableTh({
  col, sort, onSort, label, className, sortable = true,
}: {
  col: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  label: string;
  className?: string;
  /** false: a plain header (the server cannot sort on this column). */
  sortable?: boolean;
}) {
  const active = sort.key === col;
  if (!sortable) {
    return <th className={clsx('px-4 py-3 text-left', className)}>{label}</th>;
  }
  return (
    <th
      className={clsx('px-4 py-3 text-left', className)}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-text-primary transition-colors"
      >
        {label} <SortIcon col={col} sort={sort} />
      </button>
    </th>
  );
}

/** Checkbox with an indeterminate state (select-all of a table). */
function SelectAllBox({
  checked, indeterminate, disabled, onChange, label,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={label}
      className="accent-accent"
    />
  );
}

interface HeadSelection {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onToggle: () => void;
}

const DeviceTableHead = memo(function DeviceTableHead({
  sort,
  onSort,
  showSite,
  showGroup,
  sortable,
  selection,
}: {
  sort: SortState;
  onSort: (key: SortKey) => void;
  showSite: boolean;
  showGroup: boolean;
  sortable: ReadonlySet<SortKey>;
  /** Selection column: the select-all of this table (null: no column). */
  selection: HeadSelection | null;
}) {
  const { t } = useTranslation();
  return (
    <thead>
      <tr className="border-b border-border text-text-muted text-xs uppercase tracking-wide">
        {selection && (
          <th className="w-8 py-3 pl-4 pr-0 text-left">
            <SelectAllBox
              checked={selection.checked}
              indeterminate={selection.indeterminate}
              disabled={selection.disabled}
              onChange={selection.onToggle}
              label={t('bulk.selectAll', 'Select all the rows of this table')}
            />
          </th>
        )}
        <th className="px-4 py-3 text-left w-10">{t('siteDetail.device.colStatus')}</th>
        <SortableTh col="ip" sort={sort} onSort={onSort} label={t('siteDetail.device.colIp')} sortable={sortable.has('ip')} />
        {showSite && <SortableTh col="site" sort={sort} onSort={onSort} label={t('deviceTable.colSite', 'Site')} sortable={sortable.has('site')} />}
        {showGroup && <th className="px-4 py-3 text-left hidden lg:table-cell">{t('deviceTable.colGroup', 'Group')}</th>}
        <SortableTh col="mac" sort={sort} onSort={onSort} label={t('siteDetail.device.colMac')} className="hidden md:table-cell" sortable={sortable.has('mac')} />
        <SortableTh col="name" sort={sort} onSort={onSort} label={t('siteDetail.device.colName')} sortable={sortable.has('name')} />
        <SortableTh col="vendor" sort={sort} onSort={onSort} label={t('siteDetail.device.colVendor')} className="hidden lg:table-cell" sortable={sortable.has('vendor')} />
        <SortableTh col="type" sort={sort} onSort={onSort} label={t('siteDetail.device.colType')} className="hidden sm:table-cell" sortable={sortable.has('type')} />
        <SortableTh col="lastSeen" sort={sort} onSort={onSort} label={t('siteDetail.device.colLastSeen')} className="hidden xl:table-cell" sortable={sortable.has('lastSeen')} />
        <th className="px-4 py-3 text-right">{t('siteDetail.device.colActions')}</th>
      </tr>
    </thead>
  );
});

/** How the row's IP relates to a reservation of the site. */
type RowReservation =
  | { kind: 'none' }
  /** The item is the reservation's owner. */
  | { kind: 'owner'; reservation: IpReservation }
  /** A reservation exists on the IP for another (or no) owner. */
  | { kind: 'other'; reservation: IpReservation };

const NO_RESERVATION: RowReservation = { kind: 'none' };

interface DeviceRowProps {
  item: SiteItem;
  /** Write permission: edit / reserve / delete actions. */
  canWrite: boolean;
  /** 'probes.manage': the probe badge links to the probe page. */
  canManageProbes: boolean;
  /** Site column (cross-site lists): the site's name, already anonymized. */
  siteLabel?: string;
  /** Group column (server mode): the group's name, already anonymized ('' = no group). */
  groupLabel?: string;
  /** The table has a selection column. */
  selectionColumn?: boolean;
  /** This row may be selected (write on its site). */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (item: SiteItem) => void;
  reservation: RowReservation;
  onOpen: (item: SiteItem) => void;
  onTunnel?: (ip: string, port: number) => void;
  onOpenChecks?: (itemId: number, ruleId: number | null) => void;
  onEdit?: (item: SiteItem) => void;
  onDelete?: (item: SiteItem) => void;
  onReserve?: (item: SiteItem) => void;
}

/**
 * One device row. Memoized: a live update re-renders only the rows whose
 * item changed (the callbacks it gets are stable).
 */
const DeviceRow = memo(function DeviceRow({
  item,
  canWrite,
  canManageProbes,
  siteLabel,
  groupLabel,
  selectionColumn = false,
  selectable = false,
  selected = false,
  onToggleSelect,
  reservation,
  onOpen,
  onTunnel,
  onOpenChecks,
  onEdit,
  onDelete,
  onReserve,
}: DeviceRowProps) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const displayName = item.customName ?? item.hostname;
  const checks = sortChecks(item.checks);
  const shownIp = anonymize(item.ip, 'ip');
  const shownName = displayName ? anonymize(displayName, 'hostname') : shownIp;
  const openLabel = t('deviceTable.openDevice', { name: shownName, defaultValue: 'Open {{name}}' });
  // Cross-site rows carry a flag instead of the check summaries.
  const failingFlag = checks.length === 0 && (item as SiteItem & { hasFailingCheck?: boolean }).hasFailingCheck === true;
  return (
    <tr
      className={clsx(
        'border-b border-border last:border-0 hover:bg-bg-tertiary/50 transition-colors cursor-pointer',
        item.status === 'offline' && !selected && 'opacity-50',
        selected && 'bg-accent/5',
      )}
      onClick={() => onOpen(item)}
    >
      {selectionColumn && (
        <td className="w-8 py-3 pl-4 pr-0" onClick={(e) => e.stopPropagation()}>
          {selectable && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect?.(item)}
              aria-label={t('bulk.selectRow', { name: shownName, defaultValue: 'Select {{name}}' })}
              className="accent-accent"
            />
          )}
        </td>
      )}
      <td className="px-4 py-3">
        <span
          className={clsx('w-2 h-2 rounded-full inline-block', statusDot(item.status))}
          title={t(`itemStatus.${item.status}`, item.status)}
        />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpen(item); }}
            className="text-sm font-mono text-text-primary hover:text-accent transition-colors"
            aria-label={openLabel}
          >
            {shownIp}
          </button>
          {item.hasReservationConflict && (
            <span
              title={t('siteDetail.device.reservationConflictOther', 'This IP is reserved for another device')}
              className="text-orange-400"
            >
              <AlertTriangle size={12} />
            </span>
          )}
          {reservation.kind === 'owner' && (
            <span
              title={t('siteDetail.device.reservedFor', {
                name: anonymize(reservation.reservation.name, 'hostname'),
                state: reservationStateLabel(t, reservationStateOf(reservation.reservation)),
                defaultValue: 'Reserved: {{name}} ({{state}})',
              })}
              className="inline-flex items-center text-emerald-400"
            >
              <BookmarkCheck size={12} />
            </span>
          )}
          {item.isProbe && (canManageProbes ? (
            <Link
              to={`/manage/probes/${item.probeId}`}
              title={t('siteDetail.device.probeBadgeTitle', 'This device is a probe')}
              className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-accent/10 text-accent border-accent/30 hover:bg-accent/20 transition-colors"
              onClick={e => e.stopPropagation()}
            >
              <Radar size={9} />
              {t('siteDetail.device.probeBadge', 'Probe')}
            </Link>
          ) : (
            <span
              title={t('siteDetail.device.probeBadgeTitle', 'This device is a probe')}
              className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-accent/10 text-accent border-accent/30"
            >
              <Radar size={9} />
              {t('siteDetail.device.probeBadge', 'Probe')}
            </span>
          ))}
          {item.isManual && (
            <span className="text-xs text-text-muted bg-bg-tertiary rounded px-1">
              {t('siteDetail.device.manualBadge')}
            </span>
          )}
        </div>
        <PortBadges ip={item.ip} ports={item.openPorts} onTunnel={onTunnel} />
      </td>
      {siteLabel !== undefined && (
        <td className="px-4 py-3">
          <Link
            to={`/sites/${item.siteId}`}
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-text-secondary hover:text-accent transition-colors"
          >
            {siteLabel}
          </Link>
        </td>
      )}
      {groupLabel !== undefined && (
        <td className="px-4 py-3 hidden lg:table-cell">
          <span className="text-xs text-text-secondary">{groupLabel || '—'}</span>
        </td>
      )}
      <td className="px-4 py-3 hidden md:table-cell">
        <span className="text-xs font-mono text-text-secondary">
          {item.mac ? anonymize(item.mac, 'mac') : '—'}
        </span>
        {item.mac && item.macRandomized && (
          <span
            className="ml-1 text-[10px] text-text-muted bg-bg-tertiary rounded px-1"
            title={t('deviceTable.randomMacHint', 'Randomized (private) MAC address: the device may show up again under another MAC')}
          >
            {t('deviceTable.randomMac', 'random')}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        {displayName ? (
          <div>
            <p className="text-sm text-text-primary">{anonymize(displayName, 'hostname')}</p>
            {item.customName && item.hostname && (
              <p className="text-xs text-text-muted">{anonymize(item.hostname, 'hostname')}</p>
            )}
          </div>
        ) : (
          <span className="text-sm text-text-muted">—</span>
        )}
        {failingFlag && (
          <span
            className="mt-1 inline-flex items-center gap-1 rounded-md bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-400"
            title={t('deviceTable.failingCheckHint', 'A device check of this device fails')}
          >
            <Activity size={10} />
            {t('deviceTable.failingCheck', 'Check failing')}
          </span>
        )}
        {checks.length > 0 && onOpenChecks && (
          <div className="flex flex-wrap items-center gap-1 mt-1">
            {checks.slice(0, MAX_ROW_CHIPS).map((c) => (
              <DeviceCheckChip
                key={c.ruleId}
                summary={c}
                className="max-w-[16rem]"
                onClick={() => onOpenChecks(item.id, c.ruleId)}
              />
            ))}
            {checks.length > MAX_ROW_CHIPS && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenChecks(item.id, null); }}
                className="rounded-md bg-bg-tertiary px-1.5 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                title={t('deviceChecks.chip.more', { count: checks.length - MAX_ROW_CHIPS, defaultValue: '{{count}} more checks' })}
              >
                +{checks.length - MAX_ROW_CHIPS}
              </button>
            )}
          </div>
        )}
      </td>
      <td className="px-4 py-3 hidden lg:table-cell">
        <span className="text-xs text-text-secondary">{item.vendor ?? '—'}</span>
      </td>
      <td className="px-4 py-3 hidden sm:table-cell">
        <span
          className={clsx(
            'inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded border',
            statusBadge(item.status),
          )}
        >
          <DeviceTypeIcon type={item.deviceType} size={11} />
          {deviceTypeLabel(t, item.deviceType)}
        </span>
      </td>
      <td className="px-4 py-3 hidden xl:table-cell">
        <span className="text-xs text-text-secondary">{formatRelative(item.lastSeenAt, t)}</span>
      </td>
      <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
        {canWrite && (onEdit || onReserve || onDelete) && (
          <div className="flex items-center justify-end gap-1">
            {onEdit && (
              <IconButton
                label={t('common.edit')}
                icon={<Pencil size={14} />}
                size="sm"
                onClick={() => onEdit(item)}
              />
            )}
            {onReserve && (
              <IconButton
                label={reservation.kind === 'none'
                  ? t('deviceTable.reserveIp', 'Reserve this IP')
                  : t('deviceTable.editReservation', 'Edit the reservation of this IP')}
                icon={<BookmarkPlus size={14} />}
                size="sm"
                onClick={() => onReserve(item)}
              />
            )}
            {onDelete && (
              <IconButton
                label={t('common.delete')}
                icon={<Trash2 size={14} />}
                size="sm"
                variant="danger"
                onClick={() => onDelete(item)}
              />
            )}
          </div>
        )}
      </td>
    </tr>
  );
});

/**
 * The probes reporting the subnet as scanned, then those that discovered
 * items of it (each once, in item order).
 */
function subnetProbes(subnetItems: SiteItem[], probeMap: Map<number, SiteProbe>, scannedBy?: readonly number[]): SiteProbe[] {
  const seen = new Set<number>();
  const result: SiteProbe[] = [];
  for (const id of scannedBy ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const p = probeMap.get(id);
    if (p) result.push(p);
  }
  for (const item of subnetItems) {
    if (item.discoveredByProbeId && !seen.has(item.discoveredByProbeId)) {
      seen.add(item.discoveredByProbeId);
      const p = probeMap.get(item.discoveredByProbeId);
      if (p) result.push(p);
    }
  }
  return result;
}

function inNet(net: Ipv4Net, ip: string): boolean {
  const n = ipToNum(ip);
  return ip.split('.').length === 4 && n >= net.base && n < net.base + 2 ** (32 - net.prefix);
}

/** Utilisation of a subnet header: used / usable host addresses with a bar. */
function SubnetUsage({ used, usable }: { used: number; usable: number }) {
  const { t } = useTranslation();
  const { ratio, barClass } = utilisationTone(used, usable);
  const pct = Math.round(ratio * 100);
  const label = t('subnets.utilisation', {
    used, usable, pct, defaultValue: '{{used}} / {{usable}} addresses used ({{pct}} %)',
  });
  return (
    <span className="ml-auto flex items-center gap-2" title={label}>
      <span
        className="h-1.5 w-20 rounded-full bg-bg-tertiary overflow-hidden"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={usable}
        aria-valuenow={used}
      >
        <span className={clsx('block h-full rounded-full', barClass)} style={{ width: `${Math.max(pct, used > 0 ? 2 : 0)}%` }} />
      </span>
      <span className="text-[11px] text-text-muted tabular-nums whitespace-nowrap">
        {used}/{usable}
      </span>
    </span>
  );
}

function chipClass(active: boolean, tone: 'accent' | 'red' = 'accent'): string {
  return clsx(
    'inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg transition-colors coarse:min-h-9',
    active
      ? tone === 'red'
        ? 'bg-red-500/10 text-red-400'
        : 'bg-accent/10 text-accent'
      : 'bg-bg-secondary text-text-muted hover:bg-bg-hover hover:text-text-primary',
  );
}

const selectClass =
  'bg-bg-tertiary border border-border rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-accent max-w-[14rem]';

// ─── DeviceTable ──────────────────────────────────────────────────────────────

export interface DeviceTableProps {
  /**
   * 'local' (default): every filter runs on `items`. 'server': the rows come
   * from GET /api/items (filters, facets, paging and sort on the server).
   */
  mode?: 'local' | 'server';
  /** Local mode: the rows. Ignored in server mode. */
  items?: SiteItem[];
  /** Server mode: the page's site / group filter (a group includes its sub-groups). */
  scope?: { siteId?: number | null; groupId?: number | null };
  /**
   * URL parameters (besides the table's own) that mean a link chose the view
   * (e.g. ?groupId= of a dashboard card): the URL then seeds the filters
   * instead of the session.
   */
  urlSeedKeys?: readonly string[];
  /**
   * Presets row ("New since my last visit", "Undocumented"): the previous
   * visit (ISO), null on a first visit. Undefined: no presets row.
   */
  lastVisitAt?: string | null;
  /** The site of a single-site table (collapse state, default links). */
  siteId?: number;
  /** Write permission: row actions, subnet delete and (default) the bulk actions. */
  canWrite: boolean;
  /**
   * Per-row write check (cross-site lists): the rows that may be selected
   * for the bulk actions. Default: `canWrite` for every row.
   */
  canWriteItem?: (item: SiteItem) => boolean;
  /** A bulk action changed rows (local mode: reload the items). */
  onBulkDone?: () => void;
  /** Site column (cross-site lists); names from `siteNames` (server mode: from the rows). */
  showSite?: boolean;
  siteNames?: ReadonlyMap<number, string>;
  /**
   * Group the rows by subnet (collapsible sections; local mode): the longest
   * matching entry of `subnets`, else the /24 of the IP.
   */
  groupBySubnet?: boolean;
  /** The site's subnets (GET /sites/:id/subnets) for `groupBySubnet`; null / absent = /24 grouping. */
  subnets?: SiteSubnet[] | null;
  /** Row click. Default: the device page /sites/:siteId/devices/:itemId. */
  onOpenItem?: (item: SiteItem) => void;
  /** Key of the sessionStorage filter / sort state (e.g. `site:12`). */
  stateKey: string;
  /** Probes (subnet badges, probe filter, export column); null = not loaded. */
  probes?: SiteProbe[] | null;
  canManageProbes?: boolean;
  /** Reservations of the site(s): reserved badges, Excel sheet. */
  reservations?: IpReservation[];
  /** Base of the export filenames (the site name). */
  exportName?: string;
  onTunnel?: (ip: string, port: number) => void;
  /** Check chips: opens the device checks drawer (?device=). */
  onOpenChecks?: (itemId: number, ruleId: number | null) => void;
  onEdit?: (item: SiteItem) => void;
  onDelete?: (item: SiteItem) => void;
  /** "Reserve this IP" (or edit its reservation). */
  onReserve?: (item: SiteItem) => void;
  /**
   * Subnet header delete (write only): cidr = the group's subnet (e.g.
   * "10.0.0.0/22" or "192.168.1.0/24"), count = the site's discovered
   * (non-manual) devices inside it, the ones the server deletes.
   */
  onDeleteSubnet?: (siteId: number, cidr: string, count: number) => void;
  /** Extra toolbar buttons (e.g. "Add manually"). */
  toolbarActions?: ReactNode;
  /** Shown when `items` is empty (local mode). */
  emptyState?: ReactNode;
  /** Keep the filters in the query string (default true). */
  syncUrl?: boolean;
}

interface SubnetGroup {
  siteId: number;
  /** The /24 prefix of a fallback group ("192.168.1"), '' otherwise. */
  prefix: string;
  /** The group's CIDR ('' for the ungrouped list or a non-IPv4 address). */
  cidr: string;
  net: Ipv4Net | null;
  /** The site subnet this group is (null: /24 fallback). */
  subnet: SiteSubnet | null;
  items: SiteItem[];
}

type RowGroup = [string, SubnetGroup];

const EMPTY_ITEMS: SiteItem[] = [];
const EMPTY_IDS: ReadonlySet<number> = new Set();

interface BulkTotals { affected: number; ignored: number; skipped: number }

export function DeviceTable({
  mode = 'local',
  items: itemsProp,
  scope,
  urlSeedKeys,
  lastVisitAt,
  siteId,
  canWrite,
  canWriteItem,
  onBulkDone,
  showSite = false,
  siteNames: siteNamesProp,
  groupBySubnet = false,
  subnets,
  onOpenItem,
  stateKey,
  probes,
  canManageProbes = false,
  reservations,
  exportName,
  onTunnel,
  onOpenChecks,
  onEdit,
  onDelete,
  onReserve,
  onDeleteSubnet,
  toolbarActions,
  emptyState,
  syncUrl = true,
}: DeviceTableProps) {
  const server = mode === 'server';
  const { t } = useTranslation();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { anonymize, isAnonymous } = useAnonymize();
  const [searchParams, setSearchParams] = useSearchParams();
  const canManageChecks = useTenantCapability('deviceChecks.manage');
  const groupsMap = useGroupStore((s) => s.groups);

  // ── Filter state: the URL seeds it (an explicit link wins), else the
  // session restores what the user left (back from a device page).
  const keys = useMemo(() => sessionKeys(stateKey), [stateKey]);
  const [urlSeed] = useState<FilterState | null>(() => {
    const seedKeys = server ? [...SERVER_URL_KEYS, ...(urlSeedKeys ?? [])] : (urlSeedKeys ?? []);
    const seed = syncUrl ? readUrlFilters(searchParams, seedKeys) : null;
    if (seed) {
      const k = sessionKeys(stateKey);
      seedSession(k, seed);
      const urlSort = server ? readUrlSort(searchParams) : null;
      if (urlSort) storageSet(k.sort, JSON.stringify(urlSort), 'session');
    }
    return seed;
  });
  const [initialPage] = useState(() => (server && syncUrl ? readUrlPage(searchParams) : 1));
  const init = urlSeed ?? DEFAULT_FILTERS;
  const [search, setSearch] = useSessionState<string>(keys.search, init.search);
  const [statusesRaw, setStatuses] = useSessionState<Set<string>>(keys.statuses, () => new Set(init.statuses));
  const [typesRaw, setTypes] = useSessionState<Set<string>>(keys.types, () => new Set(init.types));
  const [vendor, setVendor] = useSessionState<string>(keys.vendor, init.vendor);
  const [probeRaw, setProbe] = useSessionState<string>(keys.probe, init.probe);
  const [newWithinRaw, setNewWithin] = useSessionState<NewWithin>(keys.newWithin, init.newWithin);
  const [failingOnly, setFailingOnly] = useSessionState<boolean>(keys.failingOnly, init.failingOnly);
  const [hideOffline, setHideOffline] = useSessionState<boolean>(keys.hideOffline, init.hideOffline);
  const [staleOnly, setStaleOnly] = useSessionState<boolean>(keys.staleOnly, init.staleOnly);
  const [conflictOnly, setConflictOnly] = useSessionState<boolean>(keys.conflictOnly, init.conflictOnly);
  const [undocumented, setUndocumented] = useSessionState<boolean>(keys.undocumented, init.undocumented);
  const sortableKeys = server ? SERVER_SORT_KEYS : ALL_SORT_KEYS;
  const defaultSort: SortState = { key: showSite ? 'site' : 'ip', dir: 'asc' };
  const [sortRaw, setSort] = useSessionState<SortState>(keys.sort, defaultSort);
  const statuses = asSet(statusesRaw);
  const types = asSet(typesRaw);
  // The server has no probe filter (cross-site list).
  const probe = server ? '' : probeRaw;
  const newWithin = parseNewWithin(newWithinRaw);
  const sort: SortState = sortRaw && sortableKeys.has(sortRaw.key) && (sortRaw.dir === 'asc' || sortRaw.dir === 'desc')
    ? sortRaw
    : defaultSort;

  // Debounced texts (the input stays responsive on large sites; one request per pause).
  const [debounced, setDebounced] = useState({ search, vendor });
  useEffect(() => {
    const timer = setTimeout(() => setDebounced({ search, vendor }), 250);
    return () => clearTimeout(timer);
  }, [search, vendor]);
  const debouncedSearch = debounced.search;
  // Local mode: the vendor is an exact select (no debounce needed).
  const vendorFilter = server ? debounced.vendor.trim() : vendor;

  const statusKey = [...statuses].join(',');
  const typeKey = [...types].join(',');
  const scopeSiteId = server ? (scope?.siteId ?? null) : null;
  const scopeGroupId = server ? (scope?.groupId ?? null) : null;

  /** Everything that selects the rows (sort aside): a change resets the page and the selection. */
  const filterKey = JSON.stringify([
    debouncedSearch.trim(), statusKey, typeKey, vendorFilter, probe, newWithin, failingOnly, hideOffline,
    staleOnly, conflictOnly, undocumented, scopeSiteId, scopeGroupId,
  ]);

  // ── Server paging: back to page 1 whenever the filters or the sort change.
  const pageKey = server ? `${filterKey}|${sort.key}|${sort.dir}` : filterKey;
  const [pageState, setPageState] = useState(() => ({ key: pageKey, page: initialPage }));
  const page = pageState.key === pageKey ? pageState.page : 1;
  const pageKeyRef = useRef(pageKey);
  pageKeyRef.current = pageKey;
  const goToPage = useCallback((p: number) => {
    setPageState({ key: pageKeyRef.current, page: Math.max(1, p) });
  }, []);

  // ── Keep the filters in the URL (replace: no history entry per keystroke).
  useEffect(() => {
    if (!syncUrl) return;
    const wanted: Record<string, string | null> = filtersToParams({
      search: debouncedSearch, statuses: new Set(statusKey ? statusKey.split(',') : []),
      types: new Set(typeKey ? typeKey.split(',') : []), vendor, probe, newWithin,
      failingOnly, hideOffline, staleOnly, conflictOnly, undocumented,
    });
    if (server) {
      const isDefaultSort = sort.key === defaultSort.key && sort.dir === 'asc';
      wanted.page = page > 1 ? String(page) : null;
      wanted.sort = isDefaultSort ? null : sort.key;
      wanted.dir = isDefaultSort || sort.dir === 'asc' ? null : 'desc';
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(wanted)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      return next.toString() === prev.toString() ? prev : next;
    }, { replace: true });
    // defaultSort.key derives from showSite.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncUrl, server, debouncedSearch, statusKey, typeKey, vendor, probe, newWithin, failingOnly, hideOffline,
    staleOnly, conflictOnly, undocumented, page, sort.key, sort.dir, showSite, setSearchParams]);

  // ── Server data ──
  const [serverData, setServerData] = useState<ItemListResponse | null>(null);
  const [serverLoading, setServerLoading] = useState(server);
  const [serverError, setServerError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const serverParams = useMemo<ItemListParams | null>(() => {
    if (!server) return null;
    let status = (statusKey ? statusKey.split(',') : []) as ItemStatus[];
    if (hideOffline) status = (status.length > 0 ? status : [...STATUS_ORDER]).filter((s) => s !== 'offline');
    return {
      q: debouncedSearch.trim().slice(0, SERVER_TEXT_MAX) || undefined,
      status,
      type: (typeKey ? typeKey.split(',') : []) as DeviceType[],
      vendor: vendorFilter.slice(0, SERVER_TEXT_MAX) || undefined,
      siteId: scopeSiteId ?? undefined,
      groupId: scopeGroupId ?? undefined,
      new: newWithin || undefined,
      conflict: conflictOnly || undefined,
      checks: failingOnly ? 'failing' : undefined,
      undocumented: undocumented || undefined,
      stale: staleOnly ? STALE_DAYS : undefined,
      sort: sort.key as ItemSortKey,
      dir: sort.dir,
      page,
      pageSize: SERVER_PAGE_SIZE,
    };
  }, [server, statusKey, typeKey, hideOffline, debouncedSearch, vendorFilter, scopeSiteId, scopeGroupId, newWithin,
    conflictOnly, failingOnly, undocumented, staleOnly, sort.key, sort.dir, page]);
  const serverParamsKey = serverParams ? JSON.stringify(serverParams) : '';
  // "Hide offline" with only the offline status chip: nothing can match (as in
  // local mode). The status list sent is then empty (= every status), so the
  // rows are dropped and only the status facets (which ignore their own filter) kept.
  const noStatusLeft = server && hideOffline && statusKey !== ''
    && statusKey.split(',').every((s) => s === 'offline');

  useEffect(() => {
    if (!serverParams) return;
    const ctrl = new AbortController();
    setServerLoading(true);
    itemsApi.list(serverParams, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setServerData(noStatusLeft
          ? { ...res, items: [], total: 0, page: 1, facets: { status: res.facets.status, type: {} } }
          : res);
        setServerError(false);
        setServerLoading(false);
        // The page emptied (rows deleted meanwhile): go to the last page.
        const requested = serverParams.page ?? 1;
        if (res.items.length === 0 && res.total > 0 && requested > 1) {
          goToPage(Math.ceil(res.total / Math.max(1, res.pageSize)));
        }
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        setServerError(true);
        setServerLoading(false);
      });
    return () => ctrl.abort();
    // serverParamsKey: the content of serverParams.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverParamsKey, noStatusLeft, reloadTick, goToPage]);

  // Live updates (devices, sites, tree, socket resync, tenant switch): reload the page.
  const serverRef = useRef(server);
  serverRef.current = server;
  const reloadServer = useCallback(() => {
    if (serverRef.current) setReloadTick((n) => n + 1);
  }, []);
  useIpamLiveRefresh(reloadServer);

  const items = server ? (serverData?.items ?? EMPTY_ITEMS) : (itemsProp ?? EMPTY_ITEMS);

  /** Site names: given, plus (server mode) the rows' own. */
  const siteNames = useMemo<ReadonlyMap<number, string> | undefined>(() => {
    if (!server) return siteNamesProp;
    const map = new Map(siteNamesProp ?? []);
    for (const i of serverData?.items ?? []) map.set(i.siteId, i.siteName);
    return map;
  }, [server, siteNamesProp, serverData]);

  // ── Collapse state of the subnets (localStorage, per site).
  const collapseKey = `oblimap:collapsed-subnets:${siteId ?? stateKey}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const raw = storageGetJson<unknown>(collapseKey, []);
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  });
  const toggleCollapse = useCallback((group: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group); else next.add(group);
      // Storage unavailable (e.g. the ObliTools iframe): the collapse still works for this page.
      storageSetJson(collapseKey, [...next]);
      return next;
    });
  }, [collapseKey]);

  // Rows shown per group ("Show more").
  const [limits, setLimits] = useState<Record<string, number>>({});

  const onSort = useCallback((key: SortKey) => {
    if (!sortableKeys.has(key)) return;
    setSort((prev) => {
      const cur = prev && sortableKeys.has(prev.key) ? prev : defaultSort;
      return cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSort, sortableKeys, showSite]);

  // Row click: stable callback (the rows are memoized).
  const openRef = useRef(onOpenItem);
  openRef.current = onOpenItem;
  const onOpen = useCallback((item: SiteItem) => {
    if (openRef.current) openRef.current(item);
    else navigate(`/sites/${item.siteId}/devices/${item.id}`);
  }, [navigate]);

  const probeMap = useMemo(() => {
    const map = new Map<number, SiteProbe>();
    for (const p of probes ?? []) map.set(p.id, p);
    return map;
  }, [probes]);

  // Reservation of each item's IP (owner or not), stable per render of the
  // data so the memoized rows keep their render.
  const { rowReservations, reservedKeys } = useMemo(() => {
    const byIp = new Map<string, IpReservation>();
    for (const r of reservations ?? []) byIp.set(`${r.siteId}|${r.ip}`, r);
    const map = new Map<number, RowReservation>();
    if (byIp.size > 0) {
      for (const item of items) {
        const r = byIp.get(`${item.siteId}|${item.ip}`);
        if (!r) continue;
        const owner = r.itemId === item.id || sameMac(r.reservedMac, item.mac);
        map.set(item.id, { kind: owner ? 'owner' : 'other', reservation: r });
      }
    }
    return { rowReservations: map, reservedKeys: new Set(byIp.keys()) };
  }, [items, reservations]);

  /** No name, unknown type, IP not reserved (as the server's ?undocumented=1). */
  const isUndocumented = useCallback((i: SiteItem) =>
    !(i.customName ?? '').trim() && i.deviceType === 'unknown' && !reservedKeys.has(`${i.siteId}|${i.ip}`),
  [reservedKeys]);

  // ── Facets (local: over the items matching the text search; server: its facets).
  const searchFn = isAnonymous ? anonymize : undefined;
  const searched = useMemo(
    () => (server || !debouncedSearch.trim() ? items : items.filter((i) => itemMatchesSearch(i, debouncedSearch, searchFn))),
    [server, items, debouncedSearch, searchFn],
  );
  const facets = useMemo(() => {
    const status = new Map<string, number>();
    const type = new Map<string, number>();
    const vendors = new Map<string, number>();
    const probeIds = new Map<number, number>();
    let failing = 0;
    let anyChecks = false;
    let conflicts = 0;
    let undocumentedCount = 0;
    if (server) {
      for (const [k, v] of Object.entries(serverData?.facets.status ?? {})) if (v) status.set(k, v);
      for (const [k, v] of Object.entries(serverData?.facets.type ?? {})) if (v) type.set(k, v);
      // Counts the server does not give: the chips stay available.
      anyChecks = true;
      conflicts = -1;
      undocumentedCount = -1;
    } else {
      for (const i of searched) {
        status.set(i.status, (status.get(i.status) ?? 0) + 1);
        type.set(i.deviceType, (type.get(i.deviceType) ?? 0) + 1);
        if (i.vendor) vendors.set(i.vendor, (vendors.get(i.vendor) ?? 0) + 1);
        if (i.discoveredByProbeId) probeIds.set(i.discoveredByProbeId, (probeIds.get(i.discoveredByProbeId) ?? 0) + 1);
        if ((i.checks?.length ?? 0) > 0) anyChecks = true;
        if ((i.checks ?? []).some(isFailingCheck)) failing++;
        if (i.hasReservationConflict) conflicts++;
        if (isUndocumented(i)) undocumentedCount++;
      }
    }
    return {
      status,
      type: [...type.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      vendors: [...vendors.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      probeIds: [...probeIds.entries()],
      failing,
      anyChecks,
      conflicts,
      undocumented: undocumentedCount,
    };
  }, [server, serverData, searched, isUndocumented]);

  // Site subnets, most specific first (longest-prefix match).
  const parsedSubnets = useMemo(() => parseSiteSubnets(server ? null : subnets), [server, subnets]);

  // ── Filter + sort + group (local); the server already did it.
  const { filtered, groups } = useMemo((): { filtered: SiteItem[]; groups: RowGroup[] } => {
    if (server) {
      return {
        filtered: items,
        groups: items.length > 0 ? [['*', { siteId: 0, prefix: '', cidr: '', net: null, subnet: null, items }]] : [],
      };
    }
    const now = Date.now();
    const newCut = newCutOf(newWithin, now);
    const staleCut = now - STALE_DAYS * DAY_MS;
    const probeId = probe ? Number(probe) : null;
    const list = searched.filter((i) => {
      if (statuses.size > 0 && !statuses.has(i.status)) return false;
      if (types.size > 0 && !types.has(i.deviceType)) return false;
      if (vendor && i.vendor !== vendor) return false;
      if (probeId !== null && i.discoveredByProbeId !== probeId) return false;
      if (newCut !== null && timeOf(i.firstSeenAt) < newCut) return false;
      if (failingOnly && !(i.checks ?? []).some(isFailingCheck)) return false;
      if (hideOffline && i.status === 'offline') return false;
      if (staleOnly && timeOf(i.lastSeenAt) >= staleCut) return false;
      if (conflictOnly && !i.hasReservationConflict) return false;
      if (undocumented && !isUndocumented(i)) return false;
      return true;
    });
    list.sort((a, b) => compareSiteItems(a, b, sort.key, sort.dir, siteNames));

    const grouped = new Map<string, SubnetGroup>();
    if (groupBySubnet) {
      for (const item of list) {
        // The site subnets describe the table's own site only.
        const match = siteId !== undefined && item.siteId === siteId ? longestMatch(parsedSubnets, item.ip) : null;
        let base: string;
        let group: Omit<SubnetGroup, 'items'>;
        if (match) {
          // A declared /24 keeps the historical key ("192.168.1"), so the
          // collapse state stored before real subnets existed still applies.
          base = match.net.prefix === 24 ? subnetOf(item.ip) : match.subnet.cidr;
          group = { siteId: item.siteId, prefix: '', cidr: match.subnet.cidr, net: match.net, subnet: match.subnet };
        } else {
          // /24 fallback: the historical key (the stored collapse state still applies).
          const prefix = subnetOf(item.ip);
          const net = parseCidr(`${prefix}.0/24`);
          base = prefix;
          group = { siteId: item.siteId, prefix, cidr: net ? `${prefix}.0/24` : '', net, subnet: null };
        }
        const key = showSite ? `${item.siteId}|${base}` : base;
        const g = grouped.get(key);
        if (g) g.items.push(item);
        else grouped.set(key, { ...group, items: [item] });
      }
    } else if (list.length > 0) {
      grouped.set('*', { siteId: siteId ?? 0, prefix: '', cidr: '', net: null, subnet: null, items: list });
    }
    const ordered = [...grouped.entries()].sort(([, a], [, b]) =>
      (showSite ? (siteNames?.get(a.siteId) ?? '').localeCompare(siteNames?.get(b.siteId) ?? '') : 0)
      || (a.net?.base ?? 0) - (b.net?.base ?? 0)
      || (a.net?.prefix ?? 0) - (b.net?.prefix ?? 0));
    return { filtered: list, groups: ordered };
    // statusKey / typeKey: the sets' content (new Set objects on each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, items, searched, statusKey, typeKey, vendor, probe, newWithin, failingOnly, hideOffline, staleOnly,
    conflictOnly, undocumented, isUndocumented, sort.key, sort.dir, groupBySubnet, showSite, siteNames, siteId,
    parsedSubnets]);

  // ── Subnet headers: utilisation (devices + reservations of the site, every
  // filter aside, as the server counts it) and the devices a delete removes.
  const subnetStats = useMemo(() => {
    const map = new Map<string, { used: number; usable: number; deletable: number }>();
    if (server || !groupBySubnet) return map;
    for (const [key, g] of groups) {
      if (!g.net) continue;
      const net = g.net;
      const siteItems = items.filter((i) => i.siteId === g.siteId);
      const ips = [
        ...siteItems.map((i) => i.ip),
        ...(reservations ?? []).filter((r) => r.siteId === g.siteId).map((r) => r.ip),
      ];
      const deletable = siteItems.filter((i) => !i.isManual && inNet(net, i.ip)).length;
      map.set(key, { used: countUsedHosts(net, ips), usable: usableHosts(net.prefix), deletable });
    }
    return map;
  }, [server, groupBySubnet, groups, items, reservations]);

  const offlineCount = facets.status.get('offline') ?? 0;
  const activeFilterCount =
    (debouncedSearch.trim() ? 1 : 0) + statuses.size + types.size + (vendorFilter ? 1 : 0) + (probe ? 1 : 0)
    + (newWithin ? 1 : 0) + (failingOnly ? 1 : 0) + (hideOffline ? 1 : 0) + (staleOnly ? 1 : 0)
    + (conflictOnly ? 1 : 0) + (undocumented ? 1 : 0);

  const clearFilters = useCallback(() => {
    setSearch('');
    setDebounced({ search: '', vendor: '' });
    setStatuses(new Set());
    setTypes(new Set());
    setVendor('');
    setProbe('');
    setNewWithin('');
    setFailingOnly(false);
    setHideOffline(false);
    setStaleOnly(false);
    setConflictOnly(false);
    setUndocumented(false);
  }, [setSearch, setStatuses, setTypes, setVendor, setProbe, setNewWithin, setFailingOnly, setHideOffline,
    setStaleOnly, setConflictOnly, setUndocumented]);

  const toggleIn = (setter: (fn: (prev: Set<string>) => Set<string>) => void, value: string) => {
    setter((prev) => {
      const next = new Set(asSet(prev));
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  };

  // ── Selection: cleared whenever the filters (server: or the page) change.
  const selKey = server ? `${filterKey}|p${page}` : filterKey;
  const selKeyRef = useRef(selKey);
  selKeyRef.current = selKey;
  const [selState, setSelState] = useState<{ key: string; ids: ReadonlySet<number> }>({ key: selKey, ids: EMPTY_IDS });
  useEffect(() => {
    setSelState((prev) => (prev.key === selKey ? prev : { key: selKey, ids: EMPTY_IDS }));
  }, [selKey]);
  const selectedIds = selState.key === selKey ? selState.ids : EMPTY_IDS;

  const canSelectItem = useCallback(
    (item: SiteItem) => (canWriteItem ? canWriteItem(item) : canWrite),
    [canWriteItem, canWrite],
  );
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  // Rows gone since (a live refresh) drop out of the selection.
  const selectedItems = useMemo(
    () => [...selectedIds].map((id) => itemById.get(id)).filter((i): i is SiteItem => !!i),
    [selectedIds, itemById],
  );
  const selectionColumn = filtered.some(canSelectItem);

  const setRowsSelected = useCallback((rows: SiteItem[], on: boolean) => {
    setSelState((prev) => {
      const next = new Set(prev.key === selKeyRef.current ? prev.ids : EMPTY_IDS);
      for (const r of rows) {
        if (on) next.add(r.id); else next.delete(r.id);
      }
      return { key: selKeyRef.current, ids: next };
    });
  }, []);
  const onToggleSelect = useCallback((item: SiteItem) => {
    setSelState((prev) => {
      const next = new Set(prev.key === selKeyRef.current ? prev.ids : EMPTY_IDS);
      if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
      return { key: selKeyRef.current, ids: next };
    });
  }, []);
  const clearSelection = useCallback(() => {
    setSelState({ key: selKeyRef.current, ids: EMPTY_IDS });
  }, []);

  const headSelection = (rows: SiteItem[]): HeadSelection | null => {
    if (!selectionColumn) return null;
    const selectable = rows.filter(canSelectItem);
    const n = selectable.reduce((acc, i) => acc + (selectedIds.has(i.id) ? 1 : 0), 0);
    return {
      checked: selectable.length > 0 && n === selectable.length,
      indeterminate: n > 0 && n < selectable.length,
      disabled: selectable.length === 0,
      onToggle: () => setRowsSelected(selectable, n !== selectable.length),
    };
  };

  // ── Export (the rows shown or the selection, real values; warned in anonymous mode).
  const probeNames = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of probes ?? []) map.set(p.id, p.name);
    return map;
  }, [probes]);
  const doExport = async (format: 'csv' | 'xlsx', rows: SiteItem[] = filtered) => {
    if (isAnonymous) {
      const ok = await confirm({
        title: t('deviceTable.export.anonymousTitle', 'Anonymous mode is on'),
        message: t('deviceTable.export.anonymousWarning', 'The export contains the real IP addresses, MAC addresses and names, not the masked values shown on screen. Export anyway?'),
        confirmLabel: t('deviceTable.export.confirm', 'Export'),
      });
      if (!ok) return;
    }
    const base = {
      t,
      siteName: exportName ?? t('deviceTable.export.defaultName', 'devices'),
      items: rows,
      probeNames,
      siteNames: showSite ? siteNames : undefined,
    };
    const saved = format === 'csv'
      ? await exportSiteCSV(base)
      : await exportSiteExcel({ ...base, reservations: reservations ?? [] });
    if (!saved) toast.error(t('deviceTable.export.failed', 'The export could not be saved'));
  };

  // ── Bulk actions (one site at a time: POST /api/items/bulk).
  const selectedSiteIds = useMemo(() => new Set(selectedItems.map((i) => i.siteId)), [selectedItems]);
  const mixedSites = selectedSiteIds.size > 1;
  const bulkSiteId = selectedSiteIds.size === 1 ? [...selectedSiteIds][0] : null;
  const bulkCanWrite = selectedItems.length > 0 && selectedItems.every(canSelectItem);
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkSiteLabel = bulkSiteId !== null
    ? anonymize(siteNames?.get(bulkSiteId) ?? exportName ?? `#${bulkSiteId}`, 'hostname')
    : undefined;
  const checkStateIds = useMemo(
    () => selectedItems.flatMap((i) => (i.checks ?? []).map((c) => c.stateId)),
    [selectedItems],
  );

  const afterBulk = () => {
    clearSelection();
    if (server) setReloadTick((n) => n + 1);
    else onBulkDone?.();
  };

  /** Sends the action for the selection (chunks of BULK_CHUNK ids); null on failure (already reported). */
  const runBulk = async (build: (siteId: number, ids: number[]) => ItemBulkRequest): Promise<BulkTotals | null> => {
    if (bulkSiteId === null || !bulkCanWrite) return null;
    const ids = selectedItems.map((i) => i.id);
    const totals: BulkTotals = { affected: 0, ignored: 0, skipped: 0 };
    setBulkBusy(true);
    try {
      for (let i = 0; i < ids.length; i += BULK_CHUNK) {
        const res = await itemsApi.bulk(build(bulkSiteId, ids.slice(i, i + BULK_CHUNK)));
        totals.affected += res.affected;
        totals.ignored += res.ignored;
        totals.skipped += res.skipped ?? 0;
      }
      return totals;
    } catch (err) {
      toastApiError(err, t('bulk.failed', 'The bulk action failed'));
      // An earlier chunk may have gone through: show the current state.
      if (totals.affected > 0) afterBulk();
      return null;
    } finally {
      setBulkBusy(false);
    }
  };

  const reportIgnored = (totals: BulkTotals) => {
    if (totals.ignored > 0) {
      toast(t('bulk.ignored', {
        count: totals.ignored,
        defaultValue_one: '{{count}} device was no longer there',
        defaultValue_other: '{{count}} devices were no longer there',
      }));
    }
  };

  const bulkSetType = async (deviceType: DeviceType) => {
    const totals = await runBulk((sid, ids) => ({ siteId: sid, ids, action: 'setType', params: { deviceType } }));
    if (!totals) return;
    toast.success(t('bulk.typeSet', {
      count: totals.affected,
      type: deviceTypeLabel(t, deviceType),
      defaultValue_one: '{{count}} device set to {{type}}',
      defaultValue_other: '{{count}} devices set to {{type}}',
    }));
    reportIgnored(totals);
    afterBulk();
  };

  const bulkReserve = async () => {
    const count = selectedItems.length;
    const ok = await confirm({
      title: t('bulk.reserveTitle', 'Reserve IP addresses'),
      message: t('bulk.reserveConfirm', {
        count,
        defaultValue_one: 'Reserve the IP address of the selected device for it?',
        defaultValue_other: 'Reserve the IP addresses of the {{count}} selected devices for them?',
      }),
      confirmLabel: t('bulk.reserve', 'Reserve IPs'),
    });
    if (!ok) return;
    const totals = await runBulk((sid, ids) => ({ siteId: sid, ids, action: 'reserve' }));
    if (!totals) return;
    toast.success(t('bulk.reserved', {
      count: totals.affected,
      defaultValue_one: '{{count}} IP address reserved',
      defaultValue_other: '{{count}} IP addresses reserved',
    }));
    if (totals.skipped > 0) {
      toast(t('bulk.reserveSkipped', {
        count: totals.skipped,
        defaultValue_one: '{{count}} skipped (already reserved, not IPv4 or duplicate)',
        defaultValue_other: '{{count}} skipped (already reserved, not IPv4 or duplicates)',
      }));
    }
    reportIgnored(totals);
    afterBulk();
  };

  const bulkDelete = async () => {
    const count = selectedItems.length;
    const ok = await confirm({
      title: t('bulk.deleteTitle', 'Delete devices'),
      message: t('bulk.deleteConfirm', {
        count,
        defaultValue_one: 'Delete the selected device? It comes back if a probe sees it again.',
        defaultValue_other: 'Delete the {{count}} selected devices? They come back if a probe sees them again.',
      }),
      danger: true,
      requireText: count > DELETE_TYPE_TO_CONFIRM_OVER ? String(count) : undefined,
      confirmLabel: t('common.delete', 'Delete'),
    });
    if (!ok) return;
    const totals = await runBulk((sid, ids) => ({ siteId: sid, ids, action: 'delete' }));
    if (!totals) return;
    toast.success(t('bulk.deleted', {
      count: totals.affected,
      defaultValue_one: '{{count}} device deleted',
      defaultValue_other: '{{count}} devices deleted',
    }));
    reportIgnored(totals);
    afterBulk();
  };

  /** Run-now is per check state (rate-limited): at most RUN_CHECKS_MAX of them. */
  const bulkRunChecks = async () => {
    const ids = checkStateIds.slice(0, RUN_CHECKS_MAX);
    if (ids.length === 0) return;
    setBulkBusy(true);
    let started = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await deviceChecksApi.runNow(id);
        started++;
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    if (started > 0) {
      toast.success(t('bulk.checksStarted', {
        count: started,
        defaultValue_one: '{{count}} check started',
        defaultValue_other: '{{count}} checks started',
      }));
    }
    if (failed > 0) {
      toast.error(t('bulk.checksFailed', {
        count: failed,
        defaultValue_one: '{{count}} check could not be started (no connected probe able to run it?)',
        defaultValue_other: '{{count}} checks could not be started (no connected probe able to run them?)',
      }));
    }
    if (checkStateIds.length > RUN_CHECKS_MAX) {
      toast(t('bulk.checksCapped', {
        max: RUN_CHECKS_MAX,
        total: checkStateIds.length,
        defaultValue: 'Only the first {{max}} of {{total}} checks were started',
      }));
    }
  };

  const probeOptions = facets.probeIds
    .map(([id, count]) => ({ id, count, name: probeMap.get(id)?.name ?? `#${id}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // A single group shows its header too when it is a declared subnet (name, utilisation).
  const showGroupHeaders = !server && groupBySubnet
    && (groups.length > 1 || showSite || groups.some(([, g]) => g.subnet !== null));
  const showGroupColumn = server && showSite;
  const showPresets = lastVisitAt !== undefined;
  const lastVisitActive = !!lastVisitAt && newWithin === lastVisitAt;
  const serverTotal = serverData?.total ?? 0;
  const serverPageSize = serverData?.pageSize ?? SERVER_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(serverTotal / serverPageSize));

  const groupLabelOf = (item: SiteItem): string => {
    const gid = (item as SiteItem & { groupId?: number | null }).groupId ?? null;
    if (gid === null) return '';
    return anonymize(groupsMap.get(gid)?.name ?? `#${gid}`, 'hostname');
  };

  if (!server && items.length === 0) {
    return (
      <div>
        {toolbarActions && <div className="flex justify-end gap-2 mb-4">{toolbarActions}</div>}
        {emptyState ?? (
          <EmptyState
            icon={<Info className="h-6 w-6" />}
            title={t('siteDetail.device.noDevices')}
            description={t('siteDetail.device.noDevicesDesc')}
          />
        )}
      </div>
    );
  }

  const undocumentedChip = (
    <button
      type="button"
      aria-pressed={undocumented}
      onClick={() => setUndocumented(!undocumented)}
      className={chipClass(undocumented)}
      title={t('deviceTable.undocumentedHint', 'No name, type unknown and IP not reserved: devices nobody documented yet')}
    >
      <FileQuestion size={12} />
      {t('deviceTable.undocumented', 'Undocumented')}
      {facets.undocumented >= 0 && <span className="opacity-60">({facets.undocumented})</span>}
    </button>
  );

  let countText: string;
  if (server) {
    countText = serverTotal === 0
      ? t('deviceTable.noneFound', 'No device')
      : t('deviceTable.range', {
        from: (page - 1) * serverPageSize + 1,
        to: (page - 1) * serverPageSize + items.length,
        total: serverTotal,
        defaultValue: '{{from}}–{{to}} of {{total}} devices',
      });
  } else {
    countText = activeFilterCount > 0
      ? t('deviceTable.shownOf', { shown: filtered.length, total: items.length, defaultValue: '{{shown}} of {{total}} devices' })
      : t('siteDetail.statDevices', { count: items.length });
  }

  return (
    <div>
      {/* Toolbar: search, selects, export, page actions */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[12rem] max-w-md">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value.slice(0, server ? SERVER_TEXT_MAX : 200))}
            placeholder={server
              ? t('deviceTable.searchPlaceholderServer', 'Search IP, MAC, name, vendor, notes…')
              : t('deviceTable.searchPlaceholder', 'Search IP, MAC, name, vendor, notes, port…')}
            aria-label={t('common.search', 'Search')}
            className="w-full bg-bg-tertiary border border-border rounded-lg pl-8 pr-8 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
          {search && (
            <button
              type="button"
              onClick={() => { setSearch(''); setDebounced((d) => ({ ...d, search: '' })); }}
              aria-label={t('common.clear', 'Clear')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {server ? (
          <input
            type="search"
            value={vendor}
            onChange={(e) => setVendor(e.target.value.slice(0, SERVER_TEXT_MAX))}
            placeholder={t('deviceTable.vendorFilter', 'Vendor')}
            aria-label={t('deviceTable.vendorFilter', 'Vendor')}
            className={clsx(selectClass, 'w-36 placeholder:text-text-muted')}
          />
        ) : (facets.vendors.length > 0 || vendor) && (
          <select
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            aria-label={t('deviceTable.vendorFilter', 'Vendor')}
            className={selectClass}
          >
            <option value="">{t('deviceTable.allVendors', 'All vendors')}</option>
            {vendor && !facets.vendors.some(([v]) => v === vendor) && <option value={vendor}>{vendor}</option>}
            {facets.vendors.map(([v, count]) => (
              <option key={v} value={v}>{v} ({count})</option>
            ))}
          </select>
        )}
        {!server && (probeOptions.length > 1 || probe) && (
          <select
            value={probe}
            onChange={(e) => setProbe(e.target.value)}
            aria-label={t('deviceTable.probeFilter', 'Discovering probe')}
            className={selectClass}
          >
            <option value="">{t('deviceTable.allProbes', 'All probes')}</option>
            {probe && !probeOptions.some((p) => String(p.id) === probe) && (
              <option value={probe}>{probeMap.get(Number(probe))?.name ? anonymize(probeMap.get(Number(probe))!.name, 'hostname') : `#${probe}`}</option>
            )}
            {probeOptions.map((p) => (
              <option key={p.id} value={String(p.id)}>{anonymize(p.name, 'hostname')} ({p.count})</option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-2">
          <ActionMenu
            label={t('deviceTable.export.menu', 'Export')}
            items={[
              {
                key: 'csv',
                icon: <FileDown size={14} />,
                label: t('deviceTable.export.csv', 'CSV'),
                description: server
                  ? t('deviceTable.export.pageHint', 'The devices of this page')
                  : t('deviceTable.export.csvHint', 'The devices shown'),
                onClick: () => void doExport('csv'),
              },
              {
                key: 'xlsx',
                icon: <FileSpreadsheet size={14} />,
                label: t('deviceTable.export.excel', 'Excel'),
                description: reservations
                  ? t('deviceTable.export.excelHint', 'The devices shown + the reservations')
                  : server
                    ? t('deviceTable.export.pageHint', 'The devices of this page')
                    : t('deviceTable.export.csvHint', 'The devices shown'),
                onClick: () => void doExport('xlsx'),
              },
            ]}
            trigger={(p) => (
              <button
                {...p}
                type="button"
                disabled={filtered.length === 0}
                className="inline-flex items-center gap-1.5 rounded-md bg-bg-tertiary px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 disabled:cursor-not-allowed"
                title={t('deviceTable.export.title', 'Export the devices shown')}
              >
                <Download size={14} />
                {t('deviceTable.export.menu', 'Export')}
              </button>
            )}
          />
          {toolbarActions}
        </div>
      </div>

      {/* Presets (cross-site list): discovery queue shortcuts */}
      {showPresets && (
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
            {t('deviceTable.presets', 'Presets')}
          </span>
          <button
            type="button"
            aria-pressed={lastVisitActive}
            disabled={!lastVisitAt}
            onClick={() => { if (lastVisitAt) setNewWithin(lastVisitActive ? '' : lastVisitAt); }}
            className={clsx(chipClass(lastVisitActive), 'disabled:opacity-50')}
            title={lastVisitAt
              ? t('deviceTable.newSinceVisitHint', {
                when: formatRelative(lastVisitAt, t),
                defaultValue: 'Devices first seen since your last visit ({{when}})',
              })
              : t('deviceTable.firstVisitHint', 'Available from your next visit of this page')}
          >
            <History size={12} />
            {t('deviceTable.newSinceVisit', 'New since my last visit')}
          </button>
          {undocumentedChip}
        </div>
      )}

      {/* Chips: status, type, quick filters, clear */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {STATUS_ORDER.filter((s) => (facets.status.get(s) ?? 0) > 0 || statuses.has(s)).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={statuses.has(s)}
            onClick={() => toggleIn(setStatuses, s)}
            className={chipClass(statuses.has(s))}
          >
            <span className={clsx('w-2 h-2 rounded-full', statusDot(s))} />
            {t(`itemStatus.${s}`, s)}
            <span className="opacity-60">({facets.status.get(s) ?? 0})</span>
          </button>
        ))}
        {facets.type.length > 1 || types.size > 0 ? (
          <>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            {facets.type.map(([type, count]) => (
              <button
                key={type}
                type="button"
                aria-pressed={types.has(type)}
                onClick={() => toggleIn(setTypes, type)}
                className={chipClass(types.has(type))}
              >
                <DeviceTypeIcon type={type} size={12} />
                {deviceTypeLabel(t, type)}
                <span className="opacity-60">({count})</span>
              </button>
            ))}
            {[...types].filter((type) => !facets.type.some(([x]) => x === type)).map((type) => (
              <button
                key={type}
                type="button"
                aria-pressed
                onClick={() => toggleIn(setTypes, type)}
                className={chipClass(true)}
              >
                <DeviceTypeIcon type={type} size={12} />
                {deviceTypeLabel(t, type)}
                <span className="opacity-60">(0)</span>
              </button>
            ))}
          </>
        ) : null}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <button
          type="button"
          aria-pressed={newWithin === '24h'}
          onClick={() => setNewWithin(newWithin === '24h' ? '' : '24h')}
          className={chipClass(newWithin === '24h')}
          title={t('deviceTable.new24hHint', 'Devices first seen in the last 24 hours')}
        >
          <Sparkles size={12} />
          {t('deviceTable.new24h', 'New (24 h)')}
        </button>
        <button
          type="button"
          aria-pressed={newWithin === '7d'}
          onClick={() => setNewWithin(newWithin === '7d' ? '' : '7d')}
          className={chipClass(newWithin === '7d')}
          title={t('deviceTable.new7dHint', 'Devices first seen in the last 7 days')}
        >
          <Sparkles size={12} />
          {t('deviceTable.new7d', 'New (7 d)')}
        </button>
        {newWithin && newWithin !== '24h' && newWithin !== '7d' && !lastVisitActive && (
          <button
            type="button"
            aria-pressed
            onClick={() => setNewWithin('')}
            className={chipClass(true)}
          >
            <Sparkles size={12} />
            {t('deviceTable.newSince', { when: formatRelative(newWithin, t), defaultValue: 'New since {{when}}' })}
          </button>
        )}
        {(facets.anyChecks || failingOnly) && (
          <button
            type="button"
            onClick={() => setFailingOnly(!failingOnly)}
            aria-pressed={failingOnly}
            className={chipClass(failingOnly, 'red')}
            title={t('deviceChecks.devicesTab.failingOnlyHint', 'Show only the devices with a failing or erroring check')}
          >
            <Activity size={12} />
            {failingOnly && !server
              ? t('deviceChecks.devicesTab.failingOnlyOn', { count: facets.failing, defaultValue: 'Failing checks only ({{count}})' })
              : t('deviceChecks.devicesTab.failingOnly', 'Failing checks only')}
          </button>
        )}
        {(facets.conflicts !== 0 || conflictOnly) && (
          <button
            type="button"
            onClick={() => setConflictOnly(!conflictOnly)}
            aria-pressed={conflictOnly}
            className={chipClass(conflictOnly, 'red')}
            title={server
              ? t('deviceTable.conflictsHintServer', 'IP reserved for another device, or an unresolved IP takeover')
              : t('deviceTable.conflictsHint', 'IP reserved for another device')}
          >
            <AlertTriangle size={12} />
            {t('deviceTable.conflicts', 'Conflicts')}
            {facets.conflicts > 0 && <span className="opacity-60">({facets.conflicts})</span>}
          </button>
        )}
        {(offlineCount > 0 || hideOffline) && (
          <button
            type="button"
            onClick={() => setHideOffline(!hideOffline)}
            aria-pressed={hideOffline}
            className={chipClass(hideOffline)}
          >
            <EyeOff size={12} />
            {hideOffline
              ? t('siteDetail.device.offlineHidden', { count: offlineCount })
              : t('siteDetail.device.hideOffline')}
          </button>
        )}
        <button
          type="button"
          aria-pressed={staleOnly}
          onClick={() => setStaleOnly(!staleOnly)}
          className={chipClass(staleOnly)}
          title={t('deviceTable.staleHint', { days: STALE_DAYS, defaultValue: 'Devices not seen for more than {{days}} days' })}
        >
          <Clock size={12} />
          {t('deviceTable.stale', { days: STALE_DAYS, defaultValue: 'Stale (> {{days}} d)' })}
        </button>
        {!showPresets && (facets.undocumented !== 0 || undocumented) && undocumentedChip}
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg text-text-muted hover:text-text-primary transition-colors coarse:min-h-9"
          >
            <FilterX size={12} />
            {t('deviceTable.clearFilters', 'Clear filters')}
          </button>
        )}
        <span className="ml-auto text-xs text-text-muted">{countText}</span>
      </div>

      <BulkActionBar
        count={selectedItems.length}
        siteLabel={bulkSiteLabel}
        mixedSites={mixedSites}
        canWrite={bulkCanWrite}
        busy={bulkBusy}
        onSetType={(type) => { void bulkSetType(type); }}
        onReserve={() => { void bulkReserve(); }}
        onDelete={() => { void bulkDelete(); }}
        onExport={() => { void doExport('csv', selectedItems); }}
        onRunChecks={canManageChecks && checkStateIds.length > 0 ? () => { void bulkRunChecks(); } : undefined}
        onClear={clearSelection}
      />

      {server && serverError && !serverData ? (
        <LoadError onRetry={() => setReloadTick((n) => n + 1)} />
      ) : server && serverLoading && !serverData ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner size="lg" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-bg-secondary rounded-xl p-8 text-center">
          <p className="text-text-muted text-sm">
            {server && activeFilterCount === 0
              ? t('deviceTable.emptyScope', 'No device here yet.')
              : t('deviceChecks.devicesTab.noMatch', 'No device matches the current filters.')}
          </p>
          {activeFilterCount > 0 && (
            <button type="button" onClick={clearFilters} className="mt-2 text-sm text-accent hover:underline">
              {t('deviceTable.clearFilters', 'Clear filters')}
            </button>
          )}
        </div>
      ) : (
        <div className={clsx('space-y-4 transition-opacity', server && serverLoading && 'opacity-60')}>
          {server && serverError && (
            <p role="alert" className="text-xs text-red-400">
              {t('deviceTable.reloadFailed', 'The list could not be refreshed: the rows shown may be out of date.')}
            </p>
          )}
          {groups.map(([groupKey, group]) => {
            const isCollapsed = showGroupHeaders && collapsed.has(groupKey);
            const limit = server ? group.items.length : (limits[groupKey] ?? PAGE_SIZE);
            const shown = group.items.slice(0, limit);
            const remaining = group.items.length - shown.length;
            const probesForSubnet = showGroupHeaders ? subnetProbes(group.items, probeMap, group.subnet?.probeIds) : [];
            const stats = showGroupHeaders ? subnetStats.get(groupKey) : undefined;
            return (
              <div key={groupKey} className="bg-bg-secondary rounded-xl overflow-hidden">
                {showGroupHeaders && (
                  <div className="px-4 py-2 bg-bg-tertiary/40 border-b border-border flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleCollapse(groupKey)}
                      aria-expanded={!isCollapsed}
                      className="flex items-center gap-2 select-none"
                    >
                      {isCollapsed
                        ? <ChevronRight size={14} className="text-text-muted" />
                        : <ChevronDown size={14} className="text-text-muted" />}
                      <Network size={14} className="text-accent" />
                      <span className="text-sm font-medium text-text-primary font-mono">
                        {group.net
                          ? `${anonymize(group.cidr.split('/')[0], 'ip')}/${group.net.prefix}`
                          : anonymize(group.prefix, 'ip')}
                      </span>
                    </button>
                    {group.subnet?.name && (
                      <span
                        className="text-sm text-text-secondary truncate max-w-[16rem]"
                        title={group.subnet.description ? anonymize(group.subnet.description, 'hostname') : undefined}
                      >
                        {anonymize(group.subnet.name, 'hostname')}
                      </span>
                    )}
                    {group.subnet?.vlan != null && (
                      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary">
                        {t('subnets.vlanBadge', { vlan: group.subnet.vlan, defaultValue: 'VLAN {{vlan}}' })}
                      </span>
                    )}
                    {group.subnet?.gateway && (
                      <span className="hidden sm:inline text-[11px] text-text-muted font-mono">
                        {t('subnets.gatewayShort', { ip: anonymize(group.subnet.gateway, 'ip'), defaultValue: 'gw {{ip}}' })}
                      </span>
                    )}
                    {showSite && (
                      <span className="text-xs text-text-secondary">
                        {anonymize(siteNames?.get(group.siteId) ?? `#${group.siteId}`, 'hostname')}
                      </span>
                    )}
                    <span className="text-xs text-text-muted">
                      ({t('siteDetail.subnetDeviceCount', {
                        count: group.items.length,
                        defaultValue_one: '{{count}} device',
                        defaultValue_other: '{{count}} devices',
                      })})
                    </span>
                    {probesForSubnet.map(p => (canManageProbes ? (
                      <Link
                        key={p.id}
                        to={`/manage/probes/${p.id}`}
                        className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                      >
                        <Radar size={10} />
                        {anonymize(p.name, 'hostname')}
                      </Link>
                    ) : (
                      <span
                        key={p.id}
                        className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-accent/10 text-accent"
                      >
                        <Radar size={10} />
                        {anonymize(p.name, 'hostname')}
                      </span>
                    )))}
                    {stats && <SubnetUsage used={stats.used} usable={stats.usable} />}
                    {canWrite && onDeleteSubnet && group.cidr && stats && (
                      <IconButton
                        label={t('siteDetail.device.deleteSubnet')}
                        icon={<Trash2 size={14} />}
                        size="sm"
                        variant="danger"
                        disabled={stats.deletable === 0}
                        // The site's discovered devices in the whole CIDR, filters or not.
                        onClick={() => onDeleteSubnet(group.siteId, group.cidr, stats.deletable)}
                      />
                    )}
                  </div>
                )}
                {!isCollapsed && (
                  <>
                    <TableScroll className="rounded-none">
                      <table className="w-full">
                        <DeviceTableHead
                          sort={sort}
                          onSort={onSort}
                          showSite={showSite}
                          showGroup={showGroupColumn}
                          sortable={sortableKeys}
                          selection={headSelection(shown)}
                        />
                        <tbody>
                          {shown.map(item => (
                            <DeviceRow
                              key={item.id}
                              item={item}
                              canWrite={canWrite}
                              canManageProbes={canManageProbes}
                              siteLabel={showSite ? anonymize(siteNames?.get(item.siteId) ?? `#${item.siteId}`, 'hostname') : undefined}
                              groupLabel={showGroupColumn ? groupLabelOf(item) : undefined}
                              selectionColumn={selectionColumn}
                              selectable={selectionColumn && canSelectItem(item)}
                              selected={selectedIds.has(item.id)}
                              onToggleSelect={onToggleSelect}
                              reservation={rowReservations.get(item.id) ?? NO_RESERVATION}
                              onOpen={onOpen}
                              onTunnel={onTunnel}
                              onOpenChecks={onOpenChecks}
                              onEdit={onEdit}
                              onDelete={onDelete}
                              onReserve={onReserve}
                            />
                          ))}
                        </tbody>
                      </table>
                    </TableScroll>
                    {remaining > 0 && (
                      <div className="border-t border-border px-4 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => setLimits((prev) => ({ ...prev, [groupKey]: limit + PAGE_SIZE }))}
                          className="text-sm text-accent hover:underline"
                        >
                          {t('deviceTable.showMore', {
                            count: Math.min(PAGE_SIZE, remaining),
                            remaining,
                            defaultValue: 'Show {{count}} more ({{remaining}} hidden)',
                          })}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}

          {/* Server paging */}
          {server && pageCount > 1 && (
            <nav
              className="flex flex-wrap items-center justify-center gap-2"
              aria-label={t('deviceTable.pagination', 'Pages')}
            >
              <IconButton
                label={t('deviceTable.prevPage', 'Previous page')}
                icon={<ChevronLeft size={16} />}
                size="md"
                disabled={page <= 1 || serverLoading}
                onClick={() => goToPage(page - 1)}
              />
              <span className="text-sm text-text-secondary">
                {t('deviceTable.pageOf', { page, pages: pageCount, defaultValue: 'Page {{page}} of {{pages}}' })}
              </span>
              <IconButton
                label={t('deviceTable.nextPage', 'Next page')}
                icon={<ChevronRight size={16} />}
                size="md"
                disabled={page >= pageCount || serverLoading}
                onClick={() => goToPage(page + 1)}
              />
            </nav>
          )}
        </div>
      )}
    </div>
  );
}
