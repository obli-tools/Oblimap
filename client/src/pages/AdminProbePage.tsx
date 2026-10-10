import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Radar, Plus, Trash2, CheckCircle, XCircle, Key, Monitor, Eye, Copy, AlertCircle, AlertTriangle,
  Loader2, RefreshCw, Search, ChevronDown, ArrowUp, ArrowDown, PauseCircle, PlayCircle, Pencil, Check, X, Ban,
  ArrowUpCircle, Building2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { probeApi, type ProbeBulkAction, type ProbeBulkResult, type ProbeFleetUpdatePreview } from '../api/probe.api';
import { siteApi } from '../api/site.api';
import type { Probe, ProbeApiKey, Site } from '@oblimap/shared';
import { clsx } from 'clsx';
import { useUiStore } from '@/store/uiStore';
import { useTenantStore } from '@/store/tenantStore';
import { useTenantCapability } from '@/store/authStore';
import { useAnonymize } from '../utils/anonymize';
import { copyText } from '../utils/clipboard';
import { apiErrorBody, toastApiError } from '../utils/apiError';
import { storageGet, storageSet } from '../utils/safeStorage';
import { useIpamLiveRefresh } from '../hooks/useIpamLiveRefresh';
import { useSessionState } from '../hooks/useSessionState';
import { useUrlTab } from '../hooks/useUrlTab';
import { PageContainer, useEmbedded } from '@/components/common/PageContainer';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { IconButton } from '@/components/common/IconButton';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { TableScroll } from '@/components/common/TableScroll';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadError } from '@/components/common/LoadError';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { LastSeen, ProbeStatusBadge, useProbeLiveRefresh } from '@/components/probes/ProbeStatusBadge';
import { CreateSitesFromProbesModal } from '@/components/probes/CreateSitesFromProbesModal';

// ─── Shared helpers (also used by ProbeDetailPage) ───────────────────────────

/** HTTP status of a failed axios request. */
function errorStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

/** True for the 409 the server answers to commands / suspension of a refused or suspended probe. */
export function isProbeNotApproved(err: unknown): boolean {
  return errorStatus(err) === 409 && apiErrorBody(err)?.error === 'probe_not_approved';
}

/**
 * Sends a probe command and reports how it went: 'sent' when the server
 * delivered it over the WebSocket, 'queued' otherwise (HTTP-mode probes get
 * it on their next push). Resolves true on success.
 */
export async function sendProbeCommand(id: number, command: string, t: TFunction): Promise<boolean> {
  try {
    const { delivered } = await probeApi.sendCommand(id, command);
    toast.success(delivered
      ? t('probesPage.commandSent', 'Command sent')
      : t('probesPage.commandQueued', 'Queued until the probe next contacts the server'));
    return true;
  } catch (err) {
    if (isProbeNotApproved(err)) {
      toast.error(t('probesPage.probeNotApproved', 'This probe is refused or suspended: it cannot receive commands'));
    } else {
      toastApiError(err, t('probesPage.detail.failedCommand', 'Failed to send command'));
    }
    return false;
  }
}

/** A probe the server accepts commands for (refused / suspended ones are refused at every contact). */
export function canReceiveCommands(probe: Pick<Probe, 'status'>): boolean {
  return probe.status === 'approved' || probe.status === 'pending';
}

/**
 * Cancels a probe's queued command (or its pending uninstall) and says what
 * actually happened: nothing is cancelled when the command was delivered, or
 * the state changed, in between. Resolves true when the call succeeded.
 */
export async function cancelProbeCommand(probe: Pick<Probe, 'id' | 'uninstallCommandedAt'>, t: TFunction): Promise<boolean> {
  try {
    const result = await probeApi.cancelCommand(probe.id) as { cancelled: string | null; uninstallCleared?: boolean };
    // Older servers return only `cancelled`: a pending uninstall that was
    // already delivered is cleared with `cancelled: null` there.
    const cleared = result.cancelled !== null
      || result.uninstallCleared === true
      || (result.uninstallCleared === undefined && !!probe.uninstallCommandedAt);
    if (cleared) toast.success(t('probesPage.commandCancelled', 'Queued command cancelled'));
    else toast(t('probesPage.nothingToCancel', 'Nothing to cancel: the command was already delivered'));
    return true;
  } catch (err) {
    toastApiError(err, t('probesPage.failedCancelCommand', 'Failed to cancel the command'));
    return false;
  }
}

/** Translated name of a probe command (the wire value otherwise). */
export function probeCommandLabel(command: string, t: TFunction): string {
  switch (command) {
    case 'uninstall': return t('probesPage.detail.uninstall', 'Uninstall');
    case 'update': return t('probesPage.detail.updateProbe', 'Update probe');
    case 'rescan': return t('probesPage.detail.forceRescan', 'Force rescan');
    default: return command;
  }
}

/** 'No site — scans ignored' badge for approved probes without a site. */
export function NoSiteBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400',
        className,
      )}
      title={t('probesPage.noSiteHint', 'Assign the probe to a site: until then its scans are ignored')}
    >
      <AlertTriangle size={11} /> {t('probesPage.noSiteBadge', 'No site — scans ignored')}
    </span>
  );
}

/**
 * Site picker shown when approving a probe that has no site and whose API
 * key has no default site. 'Skip' approves without a site (allowed: the
 * probe's scans are ignored until a site is assigned).
 */
export function ApproveSiteModal({
  probe,
  sites,
  onClose,
  onApprove,
}: {
  probe: Probe | null;
  sites: Site[];
  onClose: () => void;
  onApprove: (probe: Probe, siteId: number | undefined) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const [siteId, setSiteId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setSiteId(''); setBusy(false); }, [probe?.id]);

  async function run(target: number | undefined) {
    if (!probe) return;
    setBusy(true);
    try {
      await onApprove(probe, target);
    } finally {
      setBusy(false);
    }
  }

  const sortedSites = useMemo(() => [...sites].sort((a, b) => a.name.localeCompare(b.name)), [sites]);

  return (
    <Modal
      open={probe !== null}
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      phoneLayout="sheet"
      icon={<CheckCircle size={16} className="text-accent" />}
      title={t('probesPage.approveTitle', 'Approve {{name}}', {
        name: probe ? anonymize(probe.name ?? probe.hostname, 'hostname') : '',
      })}
      footer={(
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void run(undefined)}
            disabled={busy}
          >
            {t('probesPage.approveWithoutSite', 'Skip (no site)')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void run(siteId === '' ? undefined : siteId)}
            disabled={busy || siteId === ''}
            className="gap-1.5"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
            {t('probesPage.detail.approve', 'Approve')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">
          {t('probesPage.approvePickSite', 'This probe has no site and its API key has no default site. Choose the site its scans belong to: without a site, its scans are ignored.')}
        </p>
        <label className="block">
          <span className="mb-1.5 block text-sm text-text-muted">{t('probesPage.detail.assignedSite', 'Assigned site')}</span>
          <select
            value={siteId}
            onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : '')}
            className="w-full rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/60"
            autoFocus
          >
            <option value="">{t('probesPage.chooseSite', 'Choose a site…')}</option>
            {sortedSites.map((s) => (
              <option key={s.id} value={s.id}>{anonymize(s.name, 'hostname')}</option>
            ))}
          </select>
        </label>
        {sortedSites.length === 0 && (
          <p className="text-xs text-amber-400">{t('probesPage.noSitesYet', 'No site exists yet: create one, or approve without a site and assign it later.')}</p>
        )}
      </div>
    </Modal>
  );
}

/** Whether approving `probe` should ask for a site first. */
export function approveNeedsSite(probe: Probe, keys: ProbeApiKey[]): boolean {
  if (probe.siteId) return false;
  const key = probe.apiKeyId != null ? keys.find((k) => k.id === probe.apiKeyId) : undefined;
  return !key?.defaultSiteId;
}

// ─── URL / session filters ───────────────────────────────────────────────────

// 'nosite' is not a status: probes not attached to any site (whatever their status).
const STATUS_FILTERS = ['all', 'pending', 'approved', 'refused', 'suspended', 'nosite'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];
const CONN_FILTERS = ['all', 'online', 'offline'] as const;
type ConnFilter = typeof CONN_FILTERS[number];

const FILTER_PARAMS = ['status', 'siteId', 'q', 'conn', 'outdated'] as const;
type FilterParam = typeof FILTER_PARAMS[number];
const SESSION_PREFIX = 'oblimap:probes:filter:';

interface ProbeFilters {
  status: StatusFilter;
  /** '' = all sites, 'none' = probes without a site, else a site id */
  siteId: string;
  q: string;
  conn: ConnFilter;
  /** '1' = only the probes running an older version than the server ships */
  outdated: '' | '1';
}

function normaliseFilters(raw: Record<FilterParam, string>): ProbeFilters {
  return {
    status: (STATUS_FILTERS as readonly string[]).includes(raw.status) ? raw.status as StatusFilter : 'all',
    siteId: raw.siteId === 'none' || /^\d+$/.test(raw.siteId) ? raw.siteId : '',
    q: raw.q.slice(0, 200),
    conn: (CONN_FILTERS as readonly string[]).includes(raw.conn) ? raw.conn as ConnFilter : 'all',
    outdated: raw.outdated === '1' ? '1' : '',
  };
}

/**
 * Filters live in the URL (?status=&siteId=&q=&conn=&outdated=, deep-linkable). A URL
 * that carries none of them is seeded from sessionStorage (the filters the
 * user left when opening a probe); a URL that carries any of them is the
 * whole state (a deep link is never mixed with stale session filters).
 */
function useProbeFilters(): [ProbeFilters, (key: FilterParam, value: string) => void, () => void] {
  const [params, setParams] = useSearchParams();
  const anyInUrl = FILTER_PARAMS.some((k) => params.has(k));

  const raw = {} as Record<FilterParam, string>;
  for (const k of FILTER_PARAMS) {
    raw[k] = anyInUrl ? (params.get(k) ?? '') : (storageGet(SESSION_PREFIX + k, 'session') ?? '');
  }
  const filters = normaliseFilters(raw);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const defaults: Record<FilterParam, string> = { status: 'all', siteId: '', q: '', conn: 'all', outdated: '' };
  const isDefault = (k: FilterParam, v: string) => v === '' || v === defaults[k];

  // Seed the URL from the session once, so the address bar shows the filters.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (anyInUrl) return;
    const current = filtersRef.current;
    if (FILTER_PARAMS.every((k) => isDefault(k, current[k]))) return;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const k of FILTER_PARAMS) if (!isDefault(k, current[k])) next.set(k, current[k]);
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the effective filters into the session.
  useEffect(() => {
    for (const k of FILTER_PARAMS) storageSet(SESSION_PREFIX + k, filters[k], 'session');
  }, [filters.status, filters.siteId, filters.q, filters.conn, filters.outdated]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFilter = useCallback((key: FilterParam, value: string) => {
    const current = { ...filtersRef.current, [key]: value } as Record<FilterParam, string>;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const k of FILTER_PARAMS) {
        if (isDefault(k, current[k])) next.delete(k);
        else next.set(k, current[k]);
      }
      return next;
    }, { replace: true });
    storageSet(SESSION_PREFIX + key, value, 'session');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setParams]);

  const resetFilters = useCallback(() => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const k of FILTER_PARAMS) next.delete(k);
      return next;
    }, { replace: true });
    for (const k of FILTER_PARAMS) storageSet(SESSION_PREFIX + k, '', 'session');
  }, [setParams]);

  return [filters, setFilter, resetFilters];
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

type SortKey = 'name' | 'site' | 'status' | 'version' | 'lastSeen';
interface SortState { key: SortKey; dir: 'asc' | 'desc' }

function statusRank(p: Probe): number {
  if (p.status === 'pending') return 0;
  if (p.status === 'approved') return p.online === true ? 1 : 2;
  if (p.status === 'suspended') return 3;
  return 4;
}

function SortTh({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={clsx('px-4 py-3 text-left', className)}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={clsx(
          'inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-text-primary',
          active && 'text-text-primary',
        )}
      >
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  );
}

// ─── API Keys section ────────────────────────────────────────────────────────

function KeyNameCell({ apiKey, onRenamed }: { apiKey: ProbeApiKey; onRenamed: () => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(apiKey.name);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!editing) setValue(apiKey.name); }, [apiKey.name, editing]);

  async function save() {
    const name = value.trim();
    if (!name || name === apiKey.name) { setEditing(false); return; }
    setSaving(true);
    try {
      await probeApi.updateKey(apiKey.id, { name });
      toast.success(t('probesPage.apiKeys.renamed', 'API key renamed'));
      setEditing(false);
      onRenamed();
    } catch (err) {
      toastApiError(err, t('probesPage.apiKeys.failedUpdate', 'Failed to update the API key'));
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <span className="group inline-flex items-center gap-1">
        <span className="text-sm font-medium text-text-primary">{apiKey.name}</span>
        <IconButton
          label={t('probesPage.apiKeys.rename', 'Rename')}
          icon={<Pencil size={12} />}
          size="xs"
          variant="plain"
          onClick={() => setEditing(true)}
          className="can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100"
        />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="text"
        value={value}
        autoFocus
        maxLength={100}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); }
        }}
        aria-label={t('probesPage.apiKeys.rename', 'Rename')}
        className="w-40 rounded-md bg-bg-tertiary px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/60"
      />
      <IconButton
        label={t('common.save', 'Save')}
        icon={saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
        size="sm"
        variant="primary"
        disabled={saving || !value.trim()}
        onClick={() => void save()}
      />
      <IconButton
        label={t('common.cancel', 'Cancel')}
        icon={<X size={13} />}
        size="sm"
        onClick={() => setEditing(false)}
      />
    </span>
  );
}

function ApiKeysSection({
  keys,
  sites,
  onRefresh,
}: {
  keys: ProbeApiKey[];
  sites: Site[];
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const confirm = useConfirm();
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeySiteId, setNewKeySiteId] = useState<number | ''>('');
  const [creating, setCreating] = useState(false);
  const [newlyCreated, setNewlyCreated] = useState<ProbeApiKey | null>(null);
  const [savingSiteFor, setSavingSiteFor] = useState<number | null>(null);

  const sortedSites = useMemo(() => [...sites].sort((a, b) => a.name.localeCompare(b.name)), [sites]);

  async function handleCreate() {
    const name = newKeyName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const { key } = await probeApi.createKey(name, newKeySiteId === '' ? null : newKeySiteId);
      setNewlyCreated(key);
      setNewKeyName('');
      setNewKeySiteId('');
      onRefresh();
      toast.success(t('probesPage.apiKeys.created', 'API key created'));
    } catch (err) {
      toastApiError(err, t('probesPage.apiKeys.failedCreate', 'Failed to create API key'));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(k: ProbeApiKey) {
    const count = k.probeCount ?? 0;
    const ok = await confirm({
      title: t('probesPage.apiKeys.deleteKey', 'Delete key'),
      message: count > 0
        ? t('probesPage.apiKeys.confirmDeleteCount', {
          count,
          defaultValue: '{{count}} probes use this key. Delete it? They stop authenticating.',
        })
        : t('probesPage.apiKeys.confirmDelete', 'Delete this API key? Any probes using it will stop authenticating.'),
      danger: true,
    });
    if (!ok) return;
    try {
      await probeApi.deleteKey(k.id);
      if (newlyCreated?.id === k.id) setNewlyCreated(null);
      onRefresh();
      toast.success(t('probesPage.apiKeys.deleted', 'API key deleted'));
    } catch (err) {
      toastApiError(err, t('probesPage.apiKeys.failedDelete', 'Failed to delete key'));
    }
  }

  async function handleDefaultSite(k: ProbeApiKey, value: string) {
    const defaultSiteId = value ? Number(value) : null;
    setSavingSiteFor(k.id);
    try {
      await probeApi.updateKey(k.id, { defaultSiteId });
      toast.success(t('probesPage.apiKeys.defaultSiteSaved', 'Default site saved'));
      onRefresh();
    } catch (err) {
      toastApiError(err, t('probesPage.apiKeys.failedUpdate', 'Failed to update the API key'));
    } finally {
      setSavingSiteFor(null);
    }
  }

  function copyKey(key: string) {
    void copyText(key).then((ok) => {
      if (ok) toast.success(t('probesPage.apiKeys.copied', 'Copied!'));
      else toast.error(t('common.copyFailed', 'Could not copy — select and copy manually'));
    });
  }

  function siteLabel(k: ProbeApiKey): string {
    if (!k.defaultSiteId) return '';
    const name = sites.find((s) => s.id === k.defaultSiteId)?.name ?? k.defaultSiteName;
    return name ? anonymize(name, 'hostname') : t('probesPage.siteNumber', 'Site #{{id}}', { id: k.defaultSiteId });
  }

  return (
    <div className="space-y-4">
      {/* Create form */}
      <div className="rounded-xl bg-bg-secondary p-5">
        <h3 className="mb-1 text-sm font-medium text-text-primary">{t('probesPage.apiKeys.create', 'Create')}</h3>
        <p className="mb-3 text-xs text-text-muted">
          {t('probesPage.apiKeys.defaultSiteHint', 'Probes registered with a key that has a default site are assigned to it when approved.')}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            placeholder={t('probesPage.apiKeys.namePlaceholder', 'Key name (e.g. Production)')}
            value={newKeyName}
            maxLength={100}
            onChange={(e) => setNewKeyName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
            className="flex-1 rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/60"
          />
          <select
            value={newKeySiteId}
            onChange={(e) => setNewKeySiteId(e.target.value ? Number(e.target.value) : '')}
            aria-label={t('probesPage.apiKeys.defaultSite', 'Default site')}
            className="rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/60 sm:w-56"
          >
            <option value="">{t('probesPage.apiKeys.noDefaultSite', 'No default site')}</option>
            {sortedSites.map((s) => (
              <option key={s.id} value={s.id}>{anonymize(s.name, 'hostname')}</option>
            ))}
          </select>
          <Button
            onClick={() => void handleCreate()}
            disabled={creating || !newKeyName.trim()}
            className="gap-1.5 px-3"
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {t('probesPage.apiKeys.create', 'Create')}
          </Button>
        </div>

        {newlyCreated && (
          <div className="mt-3 rounded-lg bg-emerald-500/10 p-3">
            <p className="mb-1 text-xs font-medium text-emerald-400">
              {t('probesPage.apiKeys.keyCreated', '✓ Key created — copy it now')}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all text-xs text-text-primary">{newlyCreated.key}</code>
              <IconButton
                label={t('probesPage.apiKeys.copyKey', 'Copy key')}
                icon={<Copy size={14} />}
                variant="primary"
                onClick={() => copyKey(newlyCreated.key)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Keys list */}
      {keys.length === 0 ? (
        <EmptyState icon={<Key className="h-6 w-6" />} title={t('probesPage.apiKeys.noKeys', 'No API keys yet')} />
      ) : (
        <TableScroll className="bg-bg-secondary shadow-[var(--shadow-card)]">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-text-muted">
                <th className="px-4 py-3 text-left">{t('common.name', 'Name')}</th>
                <th className="px-4 py-3 text-left">{t('probesPage.apiKeys.colKey', 'Key')}</th>
                <th className="px-4 py-3 text-left">{t('probesPage.apiKeys.defaultSite', 'Default site')}</th>
                <th className="px-4 py-3 text-right">{t('probesPage.apiKeys.colProbes', 'Probes')}</th>
                <th className="px-4 py-3 text-left">{t('probesPage.apiKeys.colLastUsed', 'Last used')}</th>
                <th className="px-4 py-3 text-right">{t('probesPage.colActions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-b border-border transition-colors last:border-0 hover:bg-bg-hover/40">
                  <td className="px-4 py-3">
                    <KeyNameCell apiKey={k} onRenamed={onRefresh} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-text-muted">{k.key.slice(0, 8)}••••••••••••••••</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5">
                      <select
                        value={k.defaultSiteId ?? ''}
                        disabled={savingSiteFor === k.id}
                        onChange={(e) => void handleDefaultSite(k, e.target.value)}
                        aria-label={t('probesPage.apiKeys.defaultSite', 'Default site')}
                        title={siteLabel(k) || undefined}
                        className="max-w-[14rem] rounded-md bg-bg-tertiary px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/60 disabled:opacity-50"
                      >
                        <option value="">{t('probesPage.apiKeys.noDefaultSite', 'No default site')}</option>
                        {k.defaultSiteId && !sites.some((s) => s.id === k.defaultSiteId) && (
                          <option value={k.defaultSiteId}>{siteLabel(k)}</option>
                        )}
                        {sortedSites.map((s) => (
                          <option key={s.id} value={s.id}>{anonymize(s.name, 'hostname')}</option>
                        ))}
                      </select>
                      {savingSiteFor === k.id && <Loader2 size={13} className="animate-spin text-text-muted" />}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums text-text-secondary">{k.probeCount ?? 0}</td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {k.lastUsedAt ? <LastSeen ts={k.lastUsedAt} /> : t('common.never', 'Never')}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        label={t('probesPage.apiKeys.copyKey', 'Copy key')}
                        icon={<Copy size={14} />}
                        onClick={() => copyKey(k.key)}
                      />
                      <IconButton
                        label={t('probesPage.apiKeys.deleteKey', 'Delete key')}
                        icon={<Trash2 size={14} />}
                        variant="danger"
                        onClick={() => void handleDelete(k)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  );
}

// ─── Probe Row ────────────────────────────────────────────────────────────────

function ProbeRow({
  probe,
  siteName,
  selected,
  onToggle,
  menuItems,
  onApprove,
  onRefuse,
  canApprove,
  selectable,
}: {
  probe: Probe;
  siteName: string | null;
  selected: boolean;
  onToggle: () => void;
  menuItems: ActionMenuItem[];
  onApprove: () => void;
  onRefuse: () => void;
  /** 'probes.approve': approve / refuse buttons. */
  canApprove: boolean;
  /** Some bulk action is available: the selection column is shown. */
  selectable: boolean;
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();

  const platform = probe.osInfo?.platform
    ? String(probe.osInfo.platform).charAt(0).toUpperCase() + String(probe.osInfo.platform).slice(1)
    : '—';
  const arch = probe.osInfo?.arch ? ` (${String(probe.osInfo.arch)})` : '';
  // Main address: probe.ip, else the first reported one (multi-homed list).
  const allIps = (probe.ips ?? []).filter((ip): ip is string => typeof ip === 'string' && ip !== '');
  const mainIp = probe.ip || allIps[0] || null;
  const ips = allIps.filter((ip) => ip !== mainIp);
  const displayName = anonymize(probe.name ?? probe.hostname, 'hostname');

  return (
    <tr className="border-b border-border transition-colors last:border-0 hover:bg-bg-hover/40">
      {selectable && (
        <td className="px-4 py-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            className="accent-accent"
            aria-label={t('probesPage.selectProbe', 'Select {{name}}', { name: displayName })}
          />
        </td>
      )}
      <td className="px-4 py-3">
        <Link
          to={`/manage/probes/${probe.id}`}
          className="text-sm font-medium text-text-primary transition-colors hover:text-accent"
        >
          {displayName}
        </Link>
        <p className="font-mono text-xs text-text-muted">{anonymize(probe.uuid).slice(0, 8)}…</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {probe.pendingCommand && (
            <span className="inline-flex items-center gap-1 text-xs text-yellow-400">
              <AlertCircle size={10} /> {t('probesPage.commandQueuedBadge', '{{command}} queued', { command: probeCommandLabel(probe.pendingCommand, t) })}
            </span>
          )}
          {probe.status === 'approved' && !probe.siteId && <NoSiteBadge />}
        </div>
      </td>
      <td className="px-4 py-3">
        {mainIp ? (
          <span
            className="font-mono text-xs text-text-secondary"
            title={ips.length > 0 ? [mainIp, ...ips].map((ip) => anonymize(ip, 'ip')).join(', ') : undefined}
          >
            {anonymize(mainIp, 'ip')}
            {ips.length > 0 && <span className="ml-1 text-text-muted">+{ips.length}</span>}
          </span>
        ) : <span className="text-text-muted">—</span>}
      </td>
      <td className="hidden px-4 py-3 md:table-cell">
        <span className="text-sm text-text-secondary">{platform}{arch}</span>
        {probe.probeVersion && (
          <p
            className={clsx('text-xs', probe.updateAvailable ? 'text-amber-400' : 'text-text-muted')}
            title={probe.updateAvailable && probe.latestVersion
              ? t('probesPage.updateAvailable', 'Update available v{{version}}', { version: probe.latestVersion })
              : undefined}
          >
            v{probe.probeVersion}
          </p>
        )}
      </td>
      <td className="hidden px-4 py-3 lg:table-cell">
        {probe.siteId ? (
          <Link to={`/sites/${probe.siteId}`} className="text-sm text-text-secondary hover:text-accent">
            {siteName
              ? anonymize(siteName, 'hostname')
              : t('probesPage.siteNumber', 'Site #{{id}}', { id: probe.siteId })}
          </Link>
        ) : <span className="text-sm text-text-muted">—</span>}
      </td>
      <td className="px-4 py-3">
        <ProbeStatusBadge probe={probe} />
      </td>
      <td className="hidden px-4 py-3 sm:table-cell">
        {probe.lastSeenAt
          ? <LastSeen ts={probe.lastSeenAt} className="text-sm text-text-secondary" />
          : <span className="text-sm text-text-muted">—</span>}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          {canApprove && (probe.status === 'pending' || probe.status === 'refused') && (
            <IconButton
              label={probe.status === 'pending' ? t('probesPage.detail.approve', 'Approve') : t('probesPage.detail.reApprove', 'Re-approve')}
              icon={<CheckCircle size={15} className="text-emerald-400" />}
              onClick={onApprove}
            />
          )}
          {canApprove && probe.status === 'pending' && (
            <IconButton
              label={t('probesPage.detail.refuse', 'Refuse')}
              icon={<XCircle size={15} className="text-red-400" />}
              onClick={onRefuse}
            />
          )}
          <ActionMenu items={menuItems} />
        </div>
      </td>
    </tr>
  );
}

// ─── Versions ───────────────────────────────────────────────────────

/** Default pace of "Update outdated probes" (the server's default too). */
const FLEET_UPDATE_DEFAULT_PER_MINUTE = 10;

/**
 * Version distribution strip of the approved probes (ported from Obliance's
 * AgentVersionsCard): one segment per reported version, the server's own in
 * green, older ones in amber. Hidden while every probe is on one version and
 * no rollout is running.
 */
function VersionStrip({
  probes,
  rollout,
  canManage,
  onUpdateOutdated,
  onStopRollout,
}: {
  probes: Probe[];
  rollout: { remaining: number; perMinute: number } | null;
  canManage: boolean;
  onUpdateOutdated: () => void;
  onStopRollout: () => void;
}) {
  const { t } = useTranslation();
  const approved = probes.filter((p) => p.status === 'approved');
  const latest = approved.find((p) => p.latestVersion)?.latestVersion ?? probes.find((p) => p.latestVersion)?.latestVersion ?? null;
  const counts = new Map<string, { count: number; outdated: boolean }>();
  for (const p of approved) {
    const v = p.probeVersion?.trim() || 'unknown';
    const entry = counts.get(v) ?? { count: 0, outdated: false };
    entry.count++;
    if (p.updateAvailable) entry.outdated = true;
    counts.set(v, entry);
  }
  const versions = [...counts.entries()]
    .map(([version, e]) => ({ version, ...e }))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const outdated = versions.reduce((n, v) => n + (v.outdated ? v.count : 0), 0);
  if (approved.length === 0 || (versions.length <= 1 && outdated === 0 && !rollout)) return null;

  const segmentCls = (v: { version: string; outdated: boolean }) =>
    v.outdated ? 'bg-amber-400' : v.version === latest ? 'bg-emerald-400' : 'bg-zinc-500';

  return (
    <div className="mb-4 rounded-xl bg-bg-secondary px-4 py-3 shadow-[var(--shadow-card)]">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          {t('probesPage.versions.title', 'Probe versions')}
          {latest && (
            <span className="ml-2 font-normal normal-case tracking-normal">
              {t('probesPage.versions.latest', 'Server ships v{{version}}', { version: latest })}
            </span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {rollout && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/15 px-2.5 py-0.5 text-xs text-blue-400">
              <Loader2 size={11} className="animate-spin" />
              {t('probesPage.versions.rollout', '{{count}} update(s) waiting ({{perMinute}}/min)', {
                count: rollout.remaining,
                perMinute: rollout.perMinute,
              })}
              {canManage && (
                <button type="button" onClick={onStopRollout} className="ml-1 rounded-full px-1.5 text-blue-300 hover:bg-blue-500/20">
                  {t('probesPage.versions.stopRollout', 'Stop')}
                </button>
              )}
            </span>
          )}
          {canManage && outdated > 0 && (
            <Button type="button" variant="secondary" size="sm" onClick={onUpdateOutdated} className="gap-1.5 text-xs">
              <ArrowUpCircle size={13} />
              {t('probesPage.versions.updateOutdated', 'Update outdated probes')}
            </Button>
          )}
        </div>
      </div>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-bg-tertiary"
        role="img"
        aria-label={versions.map((v) => `v${v.version}: ${v.count}`).join(', ')}
      >
        {versions.map((v) => (
          <div
            key={v.version}
            className={segmentCls(v)}
            style={{ width: `${(v.count / approved.length) * 100}%` }}
            title={`v${v.version} · ${v.count}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary">
        {versions.map((v) => (
          <span key={v.version} className="inline-flex items-center gap-1.5">
            <span className={clsx('h-2 w-2 rounded-full', segmentCls(v))} />
            {v.version === 'unknown' ? t('probesPage.versions.unknown', 'Unknown') : `v${v.version}`}
            <span className="tabular-nums text-text-muted">{v.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * "Update outdated probes": a dry run lists the probes (and the frozen ones
 * skipped), then the confirmation queues the paced rollout on the server.
 */
function UpdateOutdatedModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const [perMinute, setPerMinute] = useState(FLEET_UPDATE_DEFAULT_PER_MINUTE);
  const [preview, setPreview] = useState<ProbeFleetUpdatePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    setPerMinute(FLEET_UPDATE_DEFAULT_PER_MINUTE);
    setLoading(true);
    probeApi.previewUpdateOutdated()
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((err) => {
        if (cancelled) return;
        toastApiError(err, t('probesPage.versions.previewFailed', 'Could not list the outdated probes'));
        onClose();
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pace = Math.min(60, Math.max(1, Math.floor(perMinute) || 1));
  const targets = preview?.probes.length ?? 0;

  async function confirmUpdate() {
    setBusy(true);
    try {
      const result = await probeApi.updateOutdated(pace);
      toast.success(t('probesPage.versions.queued', {
        count: result.queued,
        perMinute: result.perMinute,
        defaultValue: 'Update queued for {{count}} probe(s), {{perMinute}} per minute',
      }));
      onDone();
      onClose();
    } catch (err) {
      toastApiError(err, t('probesPage.versions.updateFailed', 'Could not start the update'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!busy}
      size="md"
      phoneLayout="sheet"
      icon={<ArrowUpCircle size={16} className="text-accent" />}
      title={t('probesPage.versions.updateOutdated', 'Update outdated probes')}
      footer={(
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void confirmUpdate()}
            disabled={busy || loading || targets === 0}
            className="gap-1.5"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpCircle size={14} />}
            {t('probesPage.versions.confirmUpdate', { count: targets, defaultValue: 'Update {{count}} probe(s)' })}
          </Button>
        </>
      )}
    >
      {loading || !preview ? (
        <div className="flex h-24 items-center justify-center">
          <Loader2 className="animate-spin text-accent" size={22} />
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-text-secondary">
            {targets > 0
              ? t('probesPage.versions.previewIntro', {
                count: targets,
                version: preview.latestVersion ?? '?',
                defaultValue: '{{count}} probe(s) will be sent the update command to v{{version}}. Offline probes get it at their next contact.',
              })
              : t('probesPage.versions.nothingToUpdate', 'No outdated probe to update.')}
          </p>
          {preview.frozen > 0 && (
            <p className="text-xs text-amber-400">
              {t('probesPage.versions.frozenSkipped', {
                count: preview.frozen,
                defaultValue: '{{count}} outdated probe(s) skipped: their update policy is Frozen.',
              })}
            </p>
          )}
          {targets > 0 && (
            <>
              <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg bg-bg-tertiary/50">
                {preview.probes.slice(0, 200).map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <span className="truncate text-text-primary">{anonymize(p.name, 'hostname')}</span>
                    <span className="shrink-0 font-mono text-xs text-text-muted">
                      {p.probeVersion ? `v${p.probeVersion}` : '—'}
                      {!p.wsConnected && <span className="ml-2 text-text-muted">HTTP</span>}
                    </span>
                  </li>
                ))}
              </ul>
              {targets > 200 && (
                <p className="text-xs text-text-muted">{t('probesPage.versions.more', { count: targets - 200, defaultValue: '+{{count}} more' })}</p>
              )}
              <label className="flex flex-wrap items-center gap-2">
                <span className="text-text-muted">{t('probesPage.versions.perMinute', 'Probes per minute')}</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={perMinute}
                  onChange={(e) => setPerMinute(parseInt(e.target.value, 10) || 1)}
                  className="w-20 rounded-md border border-border bg-bg-tertiary px-2 py-1 text-right text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <span className="text-xs text-text-muted">
                  {t('probesPage.versions.duration', { count: Math.ceil(targets / pace), defaultValue: '≈ {{count}} min' })}
                </span>
              </label>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const PROBE_TABS = ['probes', 'keys'] as const;
type ProbeTab = typeof PROBE_TABS[number];
/** Without 'probes.manage' there is no API keys section. */
const PROBE_TABS_READ_ONLY: readonly ProbeTab[] = ['probes'];

export function AdminProbePage() {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const embedded = useEmbedded();
  const { openAddProbeModal } = useUiStore();
  // The page opens with 'probes.read'; approve / refuse /
  // suspend / unsuspend take 'probes.approve'; API keys, commands, delete and
  // adding a probe take 'probes.manage' (which implies the two others).
  const canManage = useTenantCapability('probes.manage');
  const canApprove = useTenantCapability('probes.approve');
  const canManageSites = useTenantCapability('sites.manage');
  const [createSitesOpen, setCreateSitesOpen] = useState(false);
  const selectable = canApprove;
  const [tab, setTab] = useUrlTab<ProbeTab>(canManage ? PROBE_TABS : PROBE_TABS_READ_ONLY, 'probes');
  const [filters, setFilter, resetFilters] = useProbeFilters();
  const [storedSort, setSort] = useSessionState<SortState>('oblimap:probes:sort', { key: 'name', dir: 'asc' });
  // A corrupt / outdated session value reads as the default order.
  const sort: SortState = storedSort
    && ['name', 'site', 'status', 'version', 'lastSeen'].includes(storedSort.key)
    && (storedSort.dir === 'asc' || storedSort.dir === 'desc')
    ? storedSort
    : { key: 'name', dir: 'asc' };

  const [probes, setProbes] = useState<Probe[]>([]);
  const [keys, setKeys] = useState<ProbeApiKey[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [approveTarget, setApproveTarget] = useState<Probe | null>(null);
  const [rollout, setRollout] = useState<{ remaining: number; perMinute: number } | null>(null);
  const [updateOutdatedOpen, setUpdateOutdatedOpen] = useState(false);
  const loadedOnceRef = useRef(false);

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    const epoch = useTenantStore.getState().epoch;
    if (!opts.silent) setRefreshing(true);
    try {
      // The API keys need probes.manage (without them, approving asks for the site).
      const [probeRes, keyRes, siteRes, fleet] = await Promise.all([
        probeApi.list(),
        canManage ? probeApi.listKeys() : Promise.resolve({ keys: [] as ProbeApiKey[] }),
        siteApi.list(),
        // Rollout status of "Update outdated probes" (probes.manage; older servers: none).
        canManage ? probeApi.fleetVersions().catch(() => null) : Promise.resolve(null),
      ]);
      // A response of the tenant the user has just left is dropped.
      if (useTenantStore.getState().epoch !== epoch) return;
      setProbes(probeRes.probes);
      setKeys(keyRes.keys);
      setSites(siteRes.sites);
      setRollout(fleet?.rollout ?? null);
      setLoadFailed(false);
      loadedOnceRef.current = true;
    } catch (err) {
      if (!loadedOnceRef.current) setLoadFailed(true);
      else if (!opts.silent) toastApiError(err, t('probesPage.failedLoad', 'Failed to load probes'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t, canManage]);

  useEffect(() => { void load({ silent: true }); }, [load]);

  // Live updates: IPAM events (sites, tenant switch, reconnect) + probe events, 60 s fallback poll.
  const silentReload = useCallback(() => { void load({ silent: true }); }, [load]);
  useIpamLiveRefresh(silentReload);
  useProbeLiveRefresh(silentReload, { skipStatusChanged: true });

  // Any filter change clears the selection: bulk actions never reach rows the user can no longer see.
  useEffect(() => {
    setSelected(new Set());
  }, [filters.status, filters.siteId, filters.q, filters.conn, filters.outdated, tab]);

  const siteNameById = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { all: probes.length, pending: 0, approved: 0, refused: 0, suspended: 0, nosite: 0 };
    for (const p of probes) {
      if (p.status in counts) counts[p.status as StatusFilter]++;
      if (p.siteId == null) counts.nosite++;
    }
    return counts;
  }, [probes]);
  const outdatedCount = useMemo(() => probes.filter((p) => p.updateAvailable).length, [probes]);

  const filtered = useMemo(() => {
    const needle = filters.q.trim().toLowerCase();
    const rows = probes.filter((p) => {
      if (filters.status === 'nosite' ? p.siteId != null : filters.status !== 'all' && p.status !== filters.status) return false;
      if (filters.siteId === 'none' ? p.siteId != null : filters.siteId !== '' && String(p.siteId ?? '') !== filters.siteId) return false;
      if (filters.conn === 'online' && p.online !== true) return false;
      if (filters.conn === 'offline' && !(p.status === 'approved' && p.online !== true)) return false;
      if (filters.outdated === '1' && !p.updateAvailable) return false;
      if (needle) {
        // Match the real values (the display is anonymized, the search is not).
        const hay = [p.name, p.hostname, p.ip, ...(p.ips ?? []), p.uuid];
        if (!hay.some((v) => typeof v === 'string' && v.toLowerCase().includes(needle))) return false;
      }
      return true;
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    const name = (p: Probe) => (p.name ?? p.hostname ?? '').toLowerCase();
    rows.sort((a, b) => {
      let cmp = 0;
      switch (sort.key) {
        case 'site':
          cmp = (siteNameById.get(a.siteId ?? -1) ?? '￿').localeCompare(siteNameById.get(b.siteId ?? -1) ?? '￿');
          break;
        case 'status':
          cmp = statusRank(a) - statusRank(b);
          break;
        case 'version':
          cmp = (a.probeVersion ?? '').localeCompare(b.probeVersion ?? '', undefined, { numeric: true });
          break;
        case 'lastSeen':
          cmp = (a.lastSeenAt ? Date.parse(a.lastSeenAt) : 0) - (b.lastSeenAt ? Date.parse(b.lastSeenAt) : 0);
          break;
        default:
          cmp = 0;
      }
      if (cmp === 0) cmp = name(a).localeCompare(name(b));
      return cmp * dir;
    });
    return rows;
  }, [probes, filters.status, filters.siteId, filters.q, filters.conn, filters.outdated, sort, siteNameById]); // eslint-disable-line react-hooks/exhaustive-deps

  const allSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id));
  // Selection actually acted upon: selected AND visible (a probe deleted
  // meanwhile, or hidden by the filter, is never part of a bulk call).
  const visibleSelected = filtered.filter((p) => selected.has(p.id));
  const selectedApprovable = visibleSelected.filter((p) => p.status === 'pending' || p.status === 'refused');
  const selectedRefusedCount = selectedApprovable.filter((p) => p.status === 'refused').length;
  const selectedApproved = visibleSelected.filter((p) => p.status === 'approved');
  const selectedSuspended = visibleSelected.filter((p) => p.status === 'suspended');
  // "Create sites": unassigned pending / approved probes of the selection.
  const selectedUnassigned = visibleSelected.filter((p) => p.siteId == null && (p.status === 'pending' || p.status === 'approved'));
  // Uninstall reaches pending probes too (the server only refuses refused / suspended ones).
  const selectedCommandable = visibleSelected.filter(canReceiveCommands);

  function toggleSort(key: SortKey) {
    setSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
  }

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(filtered.map((p) => p.id)));
  }

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ── Single actions ──

  async function doApprove(probe: Probe, siteId?: number) {
    try {
      const { probe: updated } = await probeApi.approve(probe.id, siteId);
      toast.success(t('probesPage.approved', 'Probe approved'));
      if (!updated.siteId) {
        toast(t('probesPage.approvedNoSite', 'Approved without a site: its scans are ignored until a site is assigned'), { icon: '⚠️' });
      }
      setApproveTarget(null);
      void load({ silent: true });
    } catch (err) {
      toastApiError(err, t('probesPage.failedApprove', 'Failed to approve probe'));
    }
  }

  function handleApprove(probe: Probe) {
    if (approveNeedsSite(probe, keys)) setApproveTarget(probe);
    else void doApprove(probe);
  }

  async function handleRefuse(probe: Probe) {
    const ok = await confirm({
      message: t('probesPage.confirmRefuse', 'Refuse this probe?'),
      confirmLabel: t('probesPage.detail.refuse', 'Refuse'),
      danger: true,
    });
    if (!ok) return;
    try {
      await probeApi.refuse(probe.id);
      toast.success(t('probesPage.refused', 'Probe refused'));
      void load({ silent: true });
    } catch (err) { toastApiError(err, t('probesPage.failedRefuse', 'Failed to refuse probe')); }
  }

  async function handleSuspend(probe: Probe) {
    const ok = await confirm({
      title: t('probesPage.suspend', 'Suspend'),
      message: t('probesPage.confirmSuspend', 'Suspend this probe? It is disconnected and refused until it is unsuspended; its site and settings are kept.'),
      confirmLabel: t('probesPage.suspend', 'Suspend'),
      danger: true,
    });
    if (!ok) return;
    try {
      await probeApi.suspend(probe.id);
      toast.success(t('probesPage.suspended', 'Probe suspended'));
      void load({ silent: true });
    } catch (err) {
      if (isProbeNotApproved(err)) toast.error(t('probesPage.suspendNotApproved', 'Only an approved probe can be suspended'));
      else toastApiError(err, t('probesPage.failedSuspend', 'Failed to suspend the probe'));
    }
  }

  async function handleUnsuspend(probe: Probe) {
    try {
      await probeApi.unsuspend(probe.id);
      toast.success(t('probesPage.unsuspended', 'Probe unsuspended'));
      void load({ silent: true });
    } catch (err) { toastApiError(err, t('probesPage.failedUnsuspend', 'Failed to unsuspend the probe')); }
  }

  async function handleUninstall(probe: Probe) {
    const ok = await confirm({
      title: t('probesPage.detail.uninstall', 'Uninstall'),
      message: t('probesPage.confirmUninstallOne', 'Uninstall this probe? It removes itself and is deleted after 10 minutes.'),
      confirmLabel: t('probesPage.detail.uninstall', 'Uninstall'),
      danger: true,
    });
    if (!ok) return;
    if (await sendProbeCommand(probe.id, 'uninstall', t)) void load({ silent: true });
  }

  async function handleUpdateNow(probe: Probe) {
    if (await sendProbeCommand(probe.id, 'update', t)) void load({ silent: true });
  }

  async function handleStopRollout() {
    try {
      const { cancelled } = await probeApi.cancelUpdateOutdated();
      toast.success(t('probesPage.versions.rolloutStopped', { count: cancelled, defaultValue: 'Rollout stopped: {{count}} probe(s) will not be updated' }));
      void load({ silent: true });
    } catch (err) {
      toastApiError(err, t('probesPage.versions.stopFailed', 'Could not stop the rollout'));
    }
  }

  async function handleCancelCommand(probe: Probe) {
    await cancelProbeCommand(probe, t);
    void load({ silent: true });
  }

  async function handleDelete(probe: Probe) {
    const ok = await confirm({
      message: t('probesPage.confirmDelete', 'Delete this probe?'),
      danger: true,
    });
    if (!ok) return;
    try {
      await probeApi.remove(probe.id);
      toast.success(t('probesPage.deleted', 'Probe deleted'));
      void load({ silent: true });
    } catch (err) { toastApiError(err, t('probesPage.failedDelete', 'Failed to delete probe')); }
  }

  function rowMenu(probe: Probe): ActionMenuItem[] {
    return [
      {
        key: 'open',
        icon: <Eye size={15} />,
        label: t('probesPage.openProbe', 'Open'),
        onClick: () => navigate(`/manage/probes/${probe.id}`),
      },
      {
        key: 'approve',
        icon: <CheckCircle size={15} />,
        label: probe.status === 'refused' ? t('probesPage.detail.reApprove', 'Re-approve') : t('probesPage.detail.approve', 'Approve'),
        onClick: () => handleApprove(probe),
        hidden: !canApprove || (probe.status !== 'pending' && probe.status !== 'refused'),
      },
      {
        key: 'refuse',
        icon: <XCircle size={15} />,
        label: t('probesPage.detail.refuse', 'Refuse'),
        onClick: () => void handleRefuse(probe),
        hidden: !canApprove || probe.status !== 'pending',
      },
      {
        key: 'suspend',
        icon: <PauseCircle size={15} />,
        label: t('probesPage.suspend', 'Suspend'),
        onClick: () => void handleSuspend(probe),
        hidden: !canApprove || probe.status !== 'approved',
      },
      {
        key: 'unsuspend',
        icon: <PlayCircle size={15} />,
        label: t('probesPage.unsuspend', 'Unsuspend'),
        onClick: () => void handleUnsuspend(probe),
        hidden: !canApprove || probe.status !== 'suspended',
      },
      {
        key: 'update',
        icon: <ArrowUpCircle size={15} />,
        label: probe.latestVersion
          ? t('probesPage.updateTo', 'Update to v{{version}}', { version: probe.latestVersion })
          : t('probesPage.detail.updateProbe', 'Update probe'),
        onClick: () => void handleUpdateNow(probe),
        hidden: !canManage || !probe.updateAvailable || !canReceiveCommands(probe) || !!probe.updatingSince
          || probe.pendingCommand === 'update' || !!probe.uninstallCommandedAt,
      },
      {
        key: 'cancel-command',
        icon: <Ban size={15} />,
        label: t('probesPage.cancelCommand', 'Cancel queued command'),
        onClick: () => void handleCancelCommand(probe),
        hidden: !canManage || !probe.pendingCommand,
      },
      {
        key: 'uninstall',
        icon: <Trash2 size={15} />,
        label: t('probesPage.detail.uninstall', 'Uninstall'),
        onClick: () => void handleUninstall(probe),
        hidden: !canManage || !canReceiveCommands(probe) || probe.pendingCommand === 'uninstall' || !!probe.uninstallCommandedAt,
        danger: true,
        separator: true,
      },
      {
        key: 'delete',
        icon: <Trash2 size={15} />,
        label: t('common.delete', 'Delete'),
        onClick: () => void handleDelete(probe),
        hidden: !canManage,
        danger: true,
        separator: !canReceiveCommands(probe) || probe.pendingCommand === 'uninstall' || !!probe.uninstallCommandedAt,
      },
    ];
  }

  // ── Bulk actions ──

  function bulkToast(action: ProbeBulkAction, result: ProbeBulkResult) {
    const count = action === 'approve' ? (result.approvedIds ?? result.affectedIds).length : result.affectedIds.length;
    const messages: Record<ProbeBulkAction, string> = {
      approve: t('probesPage.bulkApproved', { count, defaultValue: '{{count}} probe(s) approved' }),
      delete: t('probesPage.bulkDeleted', { count, defaultValue: '{{count}} probe(s) deleted' }),
      uninstall: t('probesPage.bulkCommandQueued', { count, defaultValue: 'Command queued for {{count}} probe(s)' }),
      suspend: t('probesPage.bulkSuspended', { count, defaultValue: '{{count}} probes suspended' }),
      unsuspend: t('probesPage.bulkUnsuspended', { count, defaultValue: '{{count}} probes unsuspended' }),
    };
    const skipped = result.skipped ?? 0;
    const text = skipped > 0
      ? `${messages[action]} · ${t('probesPage.bulkSkipped', { count: skipped, defaultValue: '{{count}} skipped' })}`
      : messages[action];
    if (count === 0) toast.error(text);
    else toast.success(text);
  }

  async function handleBulk(action: ProbeBulkAction) {
    const targets = action === 'approve'
      ? selectedApprovable
      : action === 'suspend'
        ? selectedApproved
        : action === 'uninstall'
          ? selectedCommandable
          : action === 'unsuspend'
          ? selectedSuspended
          : visibleSelected;
    const ids = targets.map((p) => p.id);
    if (ids.length === 0) return;

    if (action === 'delete') {
      const ok = await confirm({
        title: t('probesPage.deleteAll', 'Delete all'),
        message: t('probesPage.confirmBulkDelete', { count: ids.length, defaultValue: 'Delete {{count}} probe(s)?' }),
        danger: true,
        requireText: String(ids.length),
      });
      if (!ok) return;
    }
    if (action === 'uninstall') {
      const ok = await confirm({
        title: t('probesPage.uninstallAll', 'Uninstall all'),
        message: t('probesPage.bulkUninstallConfirm', {
          count: ids.length,
          defaultValue: 'Uninstall {{count}} probes? They remove themselves and are deleted after 10 minutes.',
        }),
        confirmLabel: t('probesPage.detail.uninstall', 'Uninstall'),
        danger: true,
      });
      if (!ok) return;
    }
    if (action === 'suspend') {
      const ok = await confirm({
        title: t('probesPage.suspend', 'Suspend'),
        message: t('probesPage.bulkSuspendConfirm', {
          count: ids.length,
          defaultValue: 'Suspend {{count}} probes? They are disconnected and refused until unsuspended.',
        }),
        confirmLabel: t('probesPage.suspend', 'Suspend'),
        danger: true,
      });
      if (!ok) return;
    }
    if (action === 'approve' && selectedRefusedCount > 0) {
      const ok = await confirm({
        message: t('probesPage.bulkReapproveRefusedConfirm', {
          count: selectedRefusedCount,
          defaultValue: '{{count}} of the selected probes were refused. Approve them again?',
        }),
      });
      if (!ok) return;
    }
    try {
      const result = await probeApi.bulk(action, ids);
      bulkToast(action, result);
      setSelected(new Set());
      void load({ silent: true });
    } catch (err) {
      toastApiError(err, t('probesPage.bulkFailed', { action, defaultValue: 'Bulk {{action}} failed' }));
    }
  }

  const bulkItems: ActionMenuItem[] = [
    {
      key: 'createSites',
      icon: <Building2 size={15} />,
      label: t('probesPage.createSites.menu', 'Create sites'),
      description: t('probesPage.bulkCount', { count: selectedUnassigned.length, defaultValue: '{{count}} probes' }),
      onClick: () => setCreateSitesOpen(true),
      hidden: !canManage || !canManageSites || selectedUnassigned.length === 0,
    },
    {
      key: 'approve',
      icon: <CheckCircle size={15} />,
      label: t('probesPage.approveAll', 'Approve all'),
      description: t('probesPage.bulkCount', { count: selectedApprovable.length, defaultValue: '{{count}} probes' }),
      onClick: () => void handleBulk('approve'),
      hidden: !canApprove || selectedApprovable.length === 0,
    },
    {
      key: 'suspend',
      icon: <PauseCircle size={15} />,
      label: t('probesPage.suspendAll', 'Suspend'),
      description: t('probesPage.bulkCount', { count: selectedApproved.length, defaultValue: '{{count}} probes' }),
      onClick: () => void handleBulk('suspend'),
      hidden: !canApprove || selectedApproved.length === 0,
    },
    {
      key: 'unsuspend',
      icon: <PlayCircle size={15} />,
      label: t('probesPage.unsuspendAll', 'Unsuspend'),
      description: t('probesPage.bulkCount', { count: selectedSuspended.length, defaultValue: '{{count}} probes' }),
      onClick: () => void handleBulk('unsuspend'),
      hidden: !canApprove || selectedSuspended.length === 0,
    },
    {
      key: 'uninstall',
      icon: <Trash2 size={15} />,
      label: t('probesPage.uninstallAll', 'Uninstall all'),
      description: t('probesPage.bulkCount', { count: selectedCommandable.length, defaultValue: '{{count}} probes' }),
      onClick: () => void handleBulk('uninstall'),
      hidden: !canManage || selectedCommandable.length === 0,
      danger: true,
      separator: true,
    },
    {
      key: 'delete',
      icon: <Trash2 size={15} />,
      label: t('probesPage.deleteAll', 'Delete all'),
      description: t('probesPage.bulkCount', { count: visibleSelected.length, defaultValue: '{{count}} probes' }),
      onClick: () => void handleBulk('delete'),
      hidden: !canManage,
      danger: true,
      separator: selectedCommandable.length === 0,
    },
  ];

  const filterLabels: Record<StatusFilter, string> = {
    all: t('probesPage.filterAll', 'All'),
    pending: t('probesPage.statusPending', 'Pending'),
    approved: t('probesPage.statusApproved', 'Approved'),
    refused: t('probesPage.statusRefused', 'Refused'),
    suspended: t('probesPage.statusSuspended', 'Suspended'),
    nosite: t('probesPage.filterNoSite', 'No site'),
  };

  const sortedSites = useMemo(() => [...sites].sort((a, b) => a.name.localeCompare(b.name)), [sites]);
  const filtersActive = filters.status !== 'all' || filters.siteId !== '' || filters.q !== '' || filters.conn !== 'all' || filters.outdated !== '';
  const pendingCount = statusCounts.pending;

  const headerActions: ReactNode = (
    <>
      <IconButton
        label={t('common.refresh', 'Refresh')}
        icon={<RefreshCw size={16} className={clsx(refreshing && 'animate-spin')} />}
        size="lg"
        onClick={() => void load()}
      />
      {canManage && (
        <Button size="sm" onClick={openAddProbeModal} className="gap-1.5">
          <Plus size={14} />
          {t('probesPage.addProbe', 'Add Probe')}
        </Button>
      )}
    </>
  );

  const title = (
    <span className="inline-flex flex-wrap items-center gap-3">
      {t('probesPage.title', 'Probes')}
      {pendingCount > 0 && (
        <span className="rounded-full bg-yellow-500 px-2 py-0.5 text-xs font-bold text-black">
          {t('probesPage.pendingCountBadge', { count: pendingCount, defaultValue: '{{count}} pending' })}
        </span>
      )}
    </span>
  );

  let body: ReactNode;
  if (loading) {
    body = (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="animate-spin text-accent" size={28} />
      </div>
    );
  } else if (loadFailed) {
    body = <LoadError message={t('probesPage.failedLoad', 'Failed to load probes')} onRetry={() => { setLoading(true); void load(); }} />;
  } else if (tab === 'keys') {
    body = <ApiKeysSection keys={keys} sites={sites} onRefresh={() => void load({ silent: true })} />;
  } else {
    body = (
      <>
        {/* Toolbar */}
        <div className="mb-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1 sm:max-w-sm">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="search"
                value={filters.q}
                onChange={(e) => setFilter('q', e.target.value)}
                placeholder={t('probesPage.searchPlaceholder', 'Search name, hostname, IP, UUID…')}
                aria-label={t('common.search', 'Search')}
                className="w-full rounded-lg bg-bg-secondary py-2 pl-8 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/60"
              />
            </div>
            <select
              value={filters.siteId}
              onChange={(e) => setFilter('siteId', e.target.value)}
              aria-label={t('probesPage.colSite', 'Site')}
              className="rounded-lg bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/60"
            >
              <option value="">{t('probesPage.allSites', 'All sites')}</option>
              <option value="none">{t('probesPage.withoutSite', 'Without a site')}</option>
              {sortedSites.map((s) => (
                <option key={s.id} value={String(s.id)}>{anonymize(s.name, 'hostname')}</option>
              ))}
            </select>
            <select
              value={filters.conn}
              onChange={(e) => setFilter('conn', e.target.value)}
              aria-label={t('probesPage.connectivity', 'Connectivity')}
              className="rounded-lg bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/60"
            >
              <option value="all">{t('probesPage.anyConnectivity', 'Online and offline')}</option>
              <option value="online">{t('probesPage.online', 'Online')}</option>
              <option value="offline">{t('probesPage.offline', 'Offline')}</option>
            </select>
            {embedded && <div className="ml-auto flex items-center gap-2">{headerActions}</div>}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('probesPage.colStatus', 'Status')}>
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={filters.status === s}
                  onClick={() => setFilter('status', s)}
                  className={clsx(
                    'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors coarse:min-h-10',
                    filters.status === s
                      ? 'bg-accent text-white'
                      : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
                  )}
                >
                  {filterLabels[s]}
                  <span
                    className={clsx(
                      'ml-1.5 rounded-full px-1.5 text-xs tabular-nums',
                      s === 'pending' && statusCounts.pending > 0
                        ? 'bg-yellow-500 text-black'
                        : filters.status === s ? 'bg-white/20' : 'bg-bg-tertiary',
                    )}
                  >
                    {statusCounts[s]}
                  </span>
                </button>
              ))}
              {(outdatedCount > 0 || filters.outdated === '1') && (
                <button
                  type="button"
                  aria-pressed={filters.outdated === '1'}
                  onClick={() => setFilter('outdated', filters.outdated === '1' ? '' : '1')}
                  className={clsx(
                    'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors coarse:min-h-10',
                    filters.outdated === '1'
                      ? 'bg-amber-500 text-black'
                      : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
                  )}
                >
                  {t('probesPage.filterOutdated', 'Outdated')}
                  <span
                    className={clsx(
                      'ml-1.5 rounded-full px-1.5 text-xs tabular-nums',
                      filters.outdated === '1' ? 'bg-black/20' : 'bg-bg-tertiary',
                    )}
                  >
                    {outdatedCount}
                  </span>
                </button>
              )}
            </div>

            {selectable && visibleSelected.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">
                  {t('probesPage.selected', { count: visibleSelected.length, defaultValue: '{{count}} selected' })}
                </span>
                <ActionMenu
                  items={bulkItems}
                  label={t('probesPage.actions', 'Actions')}
                  trigger={(p) => (
                    <button {...p} type="button" className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                      {t('probesPage.actions', 'Actions')} <ChevronDown size={14} />
                    </button>
                  )}
                />
              </div>
            )}
          </div>
        </div>

        <CreateSitesFromProbesModal
          open={createSitesOpen}
          probes={selectedUnassigned}
          onClose={() => setCreateSitesOpen(false)}
          onDone={() => { setSelected(new Set()); void load({ silent: true }); }}
        />

        <VersionStrip
          probes={probes}
          rollout={rollout}
          canManage={canManage}
          onUpdateOutdated={() => setUpdateOutdatedOpen(true)}
          onStopRollout={() => void handleStopRollout()}
        />

        {/* Table */}
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Radar className="h-6 w-6" />}
            title={filtersActive
              ? (filters.status !== 'all'
                ? t('probesPage.noProbesFiltered', { status: filterLabels[filters.status], defaultValue: 'No probes ({{status}})' })
                : t('probesPage.noMatching', 'No probe matches the filters'))
              : t('probesPage.noProbes', 'No probes')}
            description={filtersActive
              ? t('probesPage.tryFilter', 'Try a different filter.')
              : t('probesPage.noProbesDesc', 'Install a probe on a network host — it will appear here after its first push.')}
            action={filtersActive ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={resetFilters}
              >
                {t('probesPage.clearFilters', 'Clear filters')}
              </Button>
            ) : canManage ? (
              <Button type="button" size="sm" onClick={openAddProbeModal} className="gap-1.5">
                <Plus size={14} /> {t('probesPage.addProbe', 'Add Probe')}
              </Button>
            ) : undefined}
          />
        ) : (
          <TableScroll className="bg-bg-secondary shadow-[var(--shadow-card)]">
            <table className="w-full min-w-[760px]">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-text-muted">
                  {selectable && (
                    <th className="w-10 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        className="accent-accent"
                        aria-label={t('probesPage.selectAll', 'Select all')}
                      />
                    </th>
                  )}
                  <SortTh label={t('probesPage.colProbe', 'Probe')} sortKey="name" sort={sort} onSort={toggleSort} />
                  <th className="px-4 py-3 text-left">{t('probesPage.colIps', 'IP(s)')}</th>
                  <SortTh label={t('probesPage.colPlatformVersion', 'Platform / version')} sortKey="version" sort={sort} onSort={toggleSort} className="hidden md:table-cell" />
                  <SortTh label={t('probesPage.colSite', 'Site')} sortKey="site" sort={sort} onSort={toggleSort} className="hidden lg:table-cell" />
                  <SortTh label={t('probesPage.colStatus', 'Status')} sortKey="status" sort={sort} onSort={toggleSort} />
                  <SortTh label={t('probesPage.colLastSeen', 'Last seen')} sortKey="lastSeen" sort={sort} onSort={toggleSort} className="hidden sm:table-cell" />
                  <th className="px-4 py-3 text-right">{t('probesPage.colActions', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((probe) => (
                  <ProbeRow
                    key={probe.id}
                    probe={probe}
                    siteName={probe.siteId ? siteNameById.get(probe.siteId) ?? null : null}
                    selected={selected.has(probe.id)}
                    onToggle={() => toggleOne(probe.id)}
                    menuItems={rowMenu(probe)}
                    onApprove={() => handleApprove(probe)}
                    onRefuse={() => void handleRefuse(probe)}
                    canApprove={canApprove}
                    selectable={selectable}
                  />
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </>
    );
  }

  return (
    <PageContainer
      title={title}
      icon={<Radar className="h-5 w-5" />}
      actions={headerActions}
    >
      {!embedded && (
        <SegmentedTabs<ProbeTab>
          className="mb-6 w-fit max-w-full"
          fill={false}
          value={tab}
          onChange={setTab}
          ariaLabel={t('probesPage.title', 'Probes')}
          tabs={[
            {
              id: 'probes',
              icon: <Monitor size={13} />,
              label: t('probesPage.tabDevices', 'Probes'),
              badge: pendingCount > 0 ? (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-yellow-500 px-1 text-[10px] font-bold text-black">
                  {pendingCount}
                </span>
              ) : undefined,
            },
            ...(canManage ? [{ id: 'keys' as const, icon: <Key size={13} />, label: t('probesPage.tabApiKeys', 'API Keys') }] : []),
          ]}
        />
      )}
      {embedded && tab === 'keys' && !loading && (
        <div className="mb-4 flex justify-end gap-2">{headerActions}</div>
      )}

      {body}

      <ApproveSiteModal
        probe={approveTarget}
        sites={sites}
        onClose={() => setApproveTarget(null)}
        onApprove={(probe, siteId) => doApprove(probe, siteId)}
      />
      {canManage && (
        <UpdateOutdatedModal
          open={updateOutdatedOpen}
          onClose={() => setUpdateOutdatedOpen(false)}
          onDone={() => void load({ silent: true })}
        />
      )}
    </PageContainer>
  );
}
