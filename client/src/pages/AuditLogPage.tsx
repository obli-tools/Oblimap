/**
 * AuditLogPage — tenant audit trail: who did what, when, and from where.
 *
 * Admin only (route guard + server-side requireRole('admin')). Newest first,
 * cursor-paged with "Load more". Platform admins can switch to every tenant,
 * which also shows platform events that have no tenant (failed logins, SSO
 * sync). Each row with details expands to the pretty-printed JSON, rendered
 * as plain text (never as HTML).
 *
 * Anonymous mode masks usernames, e-mails, IPs (v4 and v6), MACs and names —
 * in the table, in the expanded details and in the CSV export.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Shield, RefreshCw, Search, ChevronDown, ChevronRight, Download, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { AuditLogEntry } from '@oblimap/shared';
import { auditApi, type AuditListParams } from '@/api/audit.api';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { anonymize, useAnonymize } from '@/utils/anonymize';
import { csvRow } from '@/utils/csv';
import { cn } from '@/utils/cn';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer, useEmbedded } from '@/components/common/PageContainer';
import { TableScroll } from '@/components/common/TableScroll';
import { saveText } from '@/utils/download';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

/** Resource types offered in the filter (types seen in loaded entries are appended). */
const RESOURCE_TYPES: { value: string; fallback: string }[] = [
  { value: 'user',                 fallback: 'User' },
  { value: 'probe',                fallback: 'Probe' },
  { value: 'tunnel',               fallback: 'Tunnel' },
  { value: 'device_check_rule',    fallback: 'Device check rule' },
  { value: 'settings',             fallback: 'Settings' },
  { value: 'notification_channel', fallback: 'Notification channel' },
  { value: 'tenant',               fallback: 'Tenant' },
  { value: 'vendor_rule',          fallback: 'Vendor rule' },
  { value: 'sso',                  fallback: 'SSO' },
  { value: 'site_item',            fallback: 'Device' },
  { value: 'mac_vendor',           fallback: 'MAC vendor' },
  { value: 'site_subnet',          fallback: 'Subnet' },
  { value: 'maintenance_window',   fallback: 'Maintenance window' },
];

/** Action prefixes suggested in the filter (actions seen in loaded entries are added). */
const ACTION_PREFIXES = ['auth.', 'user.', 'probe.', 'tunnel.', 'sso.', 'tenant.', 'settings.', 'site_item.', 'mac_vendor.'];

const DESTRUCTIVE_ACTION_RE = /(delete|removed|refuse|suspend|fail|denied|invalid|mismatch|revoke|uninstall|conflict)/;
const SECURITY_ACTION_RE = /^(auth|sso|user)\.|(token|password|totp|otp|2fa|role|permission|key|session)/;

// ─── Anonymous mode helpers ───────────────────────────────────────────────────

const EMAIL_RE = /([A-Za-z0-9._%+-]{1,3})[A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/g;
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g;
const MAC_RE = /\b([0-9A-Fa-f]{2})[:-]([0-9A-Fa-f]{2})[:-]([0-9A-Fa-f]{2})(?:[:-][0-9A-Fa-f]{2}){3}\b/g;
/**
 * IPv6 candidates: colon-separated hex groups that are not part of a longer
 * token and not followed by an (already masked) IPv4 tail. isIpv6() then
 * keeps only real addresses, so times (12:34:56) are left alone.
 */
const IPV6_CANDIDATE_RE = /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,8}[0-9A-Fa-f]{0,4}(?![\w:]|\.\d)/g;
/** Detail keys whose string value is a person (username, e-mail, display name). */
const USER_KEY_RE = /(user(_?name)?|email|display_?name)$/i;
/** Detail keys whose string value is a host / site / group / tenant name. */
const NAME_KEY_RE = /(host(_?name)?|site_?name|group_?name|tenant_?name|custom_?name|device_?name|probe_?name|^name)$/i;

/** Full (8 groups) or compressed (one '::') IPv6 address. */
function isIpv6(s: string): boolean {
  const groups = s.split(':');
  if (groups.every((g) => g === '')) return false; // '::' alone
  if (s.includes('::')) return s.indexOf('::') === s.lastIndexOf('::') && groups.length <= 9;
  return groups.length === 8 && groups.every((g) => g !== '');
}

/**
 * Detail keys whose value is an IP address, or a list / forwarded-for chain of
 * them: ip, ips, target_ip, x-real-ip, ipAddress, remoteAddr, forwardedFor,
 * and camelCase clientIp / sourceIPs (case-sensitive, so 'ownership' is not one).
 */
function isIpKey(key: string): boolean {
  return /(^|[_-])(ips?|ip_?addr(ess)?(es)?|remote_?addr(ess)?|forwarded([_-]?for)?)$/i.test(key)
    || /[a-z0-9](Ips?|IPs?|IpAddr(ess)?(es)?|RemoteAddr(ess)?|ForwardedFor)$/.test(key);
}

/** Masks every e-mail, IPv4, MAC and IPv6 address embedded in free text. */
function maskAddresses(text: string): string {
  return text
    .replace(EMAIL_RE, '$1•••@•••')
    .replace(IPV4_RE, '$1.$2.•••.•••')
    .replace(MAC_RE, '$1:$2:$3:••:••:••')
    // Same masking as the IP column, so an address reads the same everywhere.
    .replace(IPV6_CANDIDATE_RE, (m) => (isIpv6(m) ? anonymize(m, 'ip') : m));
}

/** Deep copy of an entry's details with people, names and addresses masked. */
function anonymizeDetails(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (isIpKey(key)) {
      // Known address formats are masked in place (keeps a chain readable);
      // anything else under an IP key is half-masked like the IP column.
      const masked = maskAddresses(value);
      return masked !== value ? masked : anonymize(value, 'ip');
    }
    if (USER_KEY_RE.test(key)) return anonymize(value, 'username');
    if (NAME_KEY_RE.test(key)) return anonymize(value, 'hostname');
    return maskAddresses(value);
  }
  if (Array.isArray(value)) return value.map((v) => anonymizeDetails(v, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [maskAddresses(k), anonymizeDetails(v, k)]),
    );
  }
  return value;
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

function hasDetails(row: AuditLogEntry): boolean {
  return !!row.details && Object.keys(row.details).length > 0;
}

/** Probe the entry is about, when it names one (probe events, or resource 'probe'). */
function probeIdOf(row: AuditLogEntry): number | null {
  if (row.probeId != null) return row.probeId;
  if (row.resourceType === 'probe' && row.resourceId && /^[1-9]\d{0,9}$/.test(row.resourceId)) {
    return Number(row.resourceId);
  }
  return null;
}

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

function ActionPill({ action }: { action: string }) {
  const color = DESTRUCTIVE_ACTION_RE.test(action)
    ? 'bg-red-500/10 text-red-400'
    : SECURITY_ACTION_RE.test(action)
      ? 'bg-accent/10 text-accent'
      : 'bg-bg-tertiary text-text-secondary';
  return (
    <span className={cn('inline-block whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px]', color)}>
      {action}
    </span>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

interface AuditRowProps {
  row: AuditLogEntry;
  /** Tenant column shown (all-tenants view); null tenant = platform event. */
  tenantLabel: string | null;
  showTenant: boolean;
  /** The probe link only works for probes of the current tenant. */
  canLinkProbe: boolean;
  resourceLabel: (type: string) => string;
  onFilterUser: (id: number, username: string) => void;
}

function AuditRow({ row, tenantLabel, showTenant, canLinkProbe, resourceLabel, onFilterUser }: AuditRowProps) {
  const { t } = useTranslation();
  const { isAnonymous } = useAnonymize();
  const [open, setOpen] = useState(false);
  const expandable = hasDetails(row);
  const probeId = probeIdOf(row);
  const created = new Date(row.createdAt);

  const detailsText = useMemo(() => {
    if (!open || !row.details) return '';
    return JSON.stringify(isAnonymous ? anonymizeDetails(row.details) : row.details, null, 2);
  }, [open, row.details, isAnonymous]);

  const probeLabel = probeId != null ? t('audit.probeRef', { id: probeId, defaultValue: 'Probe #{{id}}' }) : '';
  const probeRef = probeId == null ? null : canLinkProbe ? (
    <Link
      to={`/manage/probes/${probeId}`}
      onClick={(e) => e.stopPropagation()}
      className="text-accent hover:underline"
    >
      {probeLabel}
    </Link>
  ) : (
    <span>{probeLabel}</span>
  );

  const resourceId = row.resourceId ? (isAnonymous ? maskAddresses(row.resourceId) : row.resourceId) : null;

  return (
    <>
      <tr
        className={cn(
          'transition-colors hover:bg-bg-hover/40',
          !open && 'border-b border-border last:border-0',
          expandable && 'cursor-pointer',
        )}
        onClick={() => expandable && setOpen((v) => !v)}
      >
        {/* Time (local) */}
        <td className="whitespace-nowrap px-4 py-2.5 text-xs text-text-secondary" title={row.createdAt}>
          <div className="flex items-center gap-1.5">
            {expandable ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
                aria-expanded={open}
                aria-label={open ? t('audit.hideDetails', 'Hide details') : t('audit.showDetails', 'Show details')}
                className="rounded text-text-muted hover:text-text-primary"
              >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            ) : (
              <span className="inline-block w-[13px]" />
            )}
            <span className="font-mono tabular-nums">
              {Number.isNaN(created.getTime()) ? row.createdAt : created.toLocaleString()}
            </span>
          </div>
        </td>

        {/* Tenant (all-tenants view only) */}
        {showTenant && (
          <td className="whitespace-nowrap px-4 py-2.5 text-xs">
            {tenantLabel !== null ? (
              <span className="text-text-secondary">{tenantLabel}</span>
            ) : (
              <span className="italic text-text-muted">{t('audit.platform', 'Platform')}</span>
            )}
          </td>
        )}

        {/* User */}
        <td className="px-4 py-2.5 text-xs">
          {row.userId != null && row.username ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onFilterUser(row.userId as number, row.username as string); }}
              title={t('audit.filterByUser', "Show only this user's entries")}
              className="text-left text-text-primary hover:text-accent hover:underline"
            >
              {anonymize(row.username, 'username')}
            </button>
          ) : row.userId != null ? (
            <span className="font-mono text-text-secondary">#{row.userId}</span>
          ) : probeRef ? (
            <span className="text-text-secondary">{probeRef}</span>
          ) : (
            <span className="italic text-text-muted">{t('audit.system', 'system')}</span>
          )}
        </td>

        {/* Action */}
        <td className="px-4 py-2.5">
          <ActionPill action={row.action} />
        </td>

        {/* Resource */}
        <td className="px-4 py-2.5 text-xs">
          {row.resourceType ? (
            <span className="inline-flex max-w-[280px] items-baseline gap-1.5">
              <span className="shrink-0 text-text-secondary">{resourceLabel(row.resourceType)}</span>
              {row.resourceType === 'probe' && probeId != null && canLinkProbe ? (
                <Link
                  to={`/manage/probes/${probeId}`}
                  onClick={(e) => e.stopPropagation()}
                  className="font-mono text-[11px] text-accent hover:underline"
                >
                  #{probeId}
                </Link>
              ) : resourceId ? (
                <span className="truncate font-mono text-[11px] text-text-muted" title={resourceId}>#{resourceId}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-text-muted">—</span>
          )}
        </td>

        {/* IP */}
        <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-text-muted">
          {row.ipAddress ? anonymize(row.ipAddress, 'ip') : '—'}
        </td>
      </tr>

      {open && expandable && (
        <tr className="border-b border-border bg-bg-tertiary/30 last:border-0">
          <td colSpan={showTenant ? 6 : 5} className="px-4 pb-3 pt-1">
            {row.userId != null && probeRef && (
              <p className="mb-1.5 text-xs text-text-muted">{probeRef}</p>
            )}
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg-primary/60 p-3 font-mono text-[11px] leading-relaxed text-text-secondary">
              {detailsText}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type Scope = 'tenant' | 'all';

export interface AuditLogPageProps {
  /**
   * Rendered inside a hub tab (/manage/security): no padding, no page header
   * (the toolbar keeps the export and refresh buttons). Default: the
   * EmbeddedContext (see PageContainer).
   */
  embedded?: boolean;
}

export function AuditLogPage({ embedded }: AuditLogPageProps = {}) {
  const { t } = useTranslation();
  const embeddedFromContext = useEmbedded();
  const isEmbedded = embedded ?? embeddedFromContext;
  // users.role 'admin' = platform admin: only they may read /api/audit/all.
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const { currentTenantId, tenants, fetchTenants } = useTenantStore();
  const { isAnonymous } = useAnonymize();

  // Filters
  const [scope, setScope] = useState<Scope>('tenant');
  const [actionInput, setActionInput] = useState('');
  const [action, setAction] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [userFilter, setUserFilter] = useState<{ id: number; username: string } | null>(null);

  // Data
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Incremented on every (re)load: responses of a superseded request are dropped.
  const requestSeq = useRef(0);

  // Debounce the free-text action prefix.
  useEffect(() => {
    const handle = setTimeout(() => setAction(actionInput.trim()), 350);
    return () => clearTimeout(handle);
  }, [actionInput]);

  const userId = userFilter?.id;

  const fetchPage = useCallback((before?: number) => {
    const params: AuditListParams = {
      limit: PAGE_SIZE,
      before,
      action: action || undefined,
      resourceType: resourceType || undefined,
      userId,
    };
    return scope === 'all' ? auditApi.listAll(params) : auditApi.list(params);
  }, [scope, action, resourceType, userId]);

  const handleError = useCallback((err: unknown) => {
    if (scope === 'all' && httpStatus(err) === 403) {
      toast.error(t('audit.allTenantsForbidden', 'Only platform administrators can view every tenant.'));
      setScope('tenant');
      return;
    }
    toast.error(t('audit.loadFailed', 'Failed to load the audit log'));
  }, [scope, t]);

  const reload = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const res = await fetchPage();
      if (seq !== requestSeq.current) return;
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setItems([]);
      setNextCursor(null);
      handleError(err);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [fetchPage, handleError]);

  // Reload when a filter changes, and after a tenant switch (the session's
  // current tenant changes server-side, so the same request returns other rows).
  useEffect(() => {
    void reload();
  }, [reload, currentTenantId]);

  const loadMore = async () => {
    if (nextCursor === null || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const res = await fetchPage(nextCursor);
      if (seq !== requestSeq.current) return; // filters changed meanwhile
      setItems((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...res.items.filter((r) => !seen.has(r.id))];
      });
      setNextCursor(res.nextCursor);
    } catch (err) {
      if (seq === requestSeq.current) handleError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  const resourceLabel = useCallback((type: string) => {
    const known = RESOURCE_TYPES.find((r) => r.value === type);
    return known ? t(`audit.resourceTypes.${type}`, known.fallback) : type;
  }, [t]);

  const resourceTypeOptions = useMemo(() => {
    const extra = new Set<string>();
    for (const r of items) if (r.resourceType) extra.add(r.resourceType);
    if (resourceType) extra.add(resourceType);
    for (const r of RESOURCE_TYPES) extra.delete(r.value);
    return [...RESOURCE_TYPES.map((r) => r.value), ...[...extra].sort()];
  }, [items, resourceType]);

  const actionSuggestions = useMemo(() => {
    const set = new Set<string>(ACTION_PREFIXES);
    for (const r of items) set.add(r.action);
    return [...set].sort();
  }, [items]);

  const tenantNames = useMemo(() => new Map(tenants.map((tn) => [tn.id, tn.name])), [tenants]);

  // For a platform admin, GET /api/tenants (the tenant store) lists every
  // tenant, but it is loaded at login: refresh it once when the all-tenants
  // log names a tenant created since, instead of showing '#id'.
  const tenantsRefreshed = useRef(false);
  useEffect(() => {
    if (scope !== 'all' || tenantsRefreshed.current) return;
    if (items.some((r) => r.tenantId !== null && !tenantNames.has(r.tenantId))) {
      tenantsRefreshed.current = true;
      void fetchTenants();
    }
  }, [scope, items, tenantNames, fetchTenants]);

  const tenantLabel = (tenantId: number | null): string | null => {
    if (tenantId === null) return null;
    const name = tenantNames.get(tenantId);
    return name ? anonymize(name, 'hostname') : `#${tenantId}`;
  };

  const hasFilters = actionInput.trim() !== '' || resourceType !== '' || userFilter !== null;
  const clearFilters = () => {
    setActionInput('');
    setAction('');
    setResourceType('');
    setUserFilter(null);
  };

  const showTenant = scope === 'all';

  const exportCsv = () => {
    const header = ['Time (UTC)', 'Tenant ID', 'Tenant', 'User ID', 'User', 'Probe ID', 'Action', 'Resource type', 'Resource ID', 'IP', 'Details'];
    const lines = items.map((r) => csvRow([
      r.createdAt,
      r.tenantId,
      tenantLabel(r.tenantId) ?? '',
      r.userId,
      anonymize(r.username, 'username'),
      r.probeId,
      r.action,
      r.resourceType,
      r.resourceId && isAnonymous ? maskAddresses(r.resourceId) : r.resourceId,
      anonymize(r.ipAddress, 'ip'),
      r.details ? JSON.stringify(isAnonymous ? anonymizeDetails(r.details) : r.details) : '',
    ]));
    const csv = [csvRow(header), ...lines].join('\r\n');
    // BOM so Excel opens the UTF-8 CSV without re-encoding.
    void saveText(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`, '\uFEFF' + csv, 'text/csv;charset=utf-8')
      .then((ok) => { if (!ok) toast.error(t('audit.exportFailed', 'The export failed.')); });
  };

  const inputClass = 'text-sm bg-bg-secondary border border-border rounded-md px-3 py-1.5 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent';

  const headerActions = (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={exportCsv}
        disabled={items.length === 0}
        title={t('audit.exportHint', 'Export the loaded entries as CSV')}
      >
        <Download size={14} className="mr-1.5" />
        {t('audit.exportCsv', 'CSV')}
      </Button>
      <IconButton
        label={t('common.refresh', 'Refresh')}
        icon={<RefreshCw size={15} className={cn(loading && 'animate-spin')} />}
        size="lg"
        variant="solid"
        onClick={() => void reload()}
      />
    </div>
  );

  return (
    <PageContainer
      embedded={isEmbedded}
      title={t('audit.title', 'Audit log')}
      subtitle={t('audit.subtitle', 'Who did what, when, and from where.')}
      icon={<Shield className="h-5 w-5" />}
      actions={headerActions}
      className="space-y-5"
    >
      {/* Embedded (hub tab): no page header, the actions sit above the filters */}
      {isEmbedded && <div className="flex justify-end">{headerActions}</div>}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        {isPlatformAdmin && (
          <div>
            <span className="mb-1 block text-xs text-text-muted">{t('audit.scope', 'Scope')}</span>
            <div className="inline-flex overflow-hidden rounded-md bg-bg-secondary">
              {(['tenant', 'all'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  aria-pressed={scope === s}
                  className={cn(
                    'px-3 py-1.5 text-sm transition-colors',
                    scope === s
                      ? 'bg-accent/15 text-accent'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                  )}
                >
                  {s === 'tenant' ? t('audit.scopeTenant', 'This tenant') : t('audit.scopeAll', 'All tenants')}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="min-w-[200px] max-w-sm flex-1">
          <label htmlFor="audit-action" className="mb-1 block text-xs text-text-muted">
            {t('audit.filterAction', 'Action starts with')}
          </label>
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              id="audit-action"
              type="text"
              list="audit-action-suggestions"
              value={actionInput}
              onChange={(e) => setActionInput(e.target.value)}
              maxLength={100}
              placeholder={t('audit.filterActionPlaceholder', 'e.g. auth. or probe.token')}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className={cn(inputClass, 'w-full pl-8 font-mono')}
            />
            <datalist id="audit-action-suggestions">
              {actionSuggestions.map((a) => <option key={a} value={a} />)}
            </datalist>
          </div>
        </div>

        <div>
          <label htmlFor="audit-resource-type" className="mb-1 block text-xs text-text-muted">
            {t('audit.filterResourceType', 'Resource type')}
          </label>
          <select
            id="audit-resource-type"
            value={resourceType}
            onChange={(e) => setResourceType(e.target.value)}
            className={cn(inputClass, 'min-w-[180px]')}
          >
            <option value="">{t('audit.allResourceTypes', 'All resource types')}</option>
            {resourceTypeOptions.map((rt) => (
              <option key={rt} value={rt}>{resourceLabel(rt)}</option>
            ))}
          </select>
        </div>

        {userFilter && (
          <div>
            <span className="mb-1 block text-xs text-text-muted">{t('audit.filterUser', 'User')}</span>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-accent/10 px-2.5 py-1.5 text-sm text-accent">
              {anonymize(userFilter.username, 'username')}
              <button
                type="button"
                onClick={() => setUserFilter(null)}
                title={t('audit.clearUserFilter', 'Show every user')}
                aria-label={t('audit.clearUserFilter', 'Show every user')}
                className="rounded hover:text-text-primary"
              >
                <X size={13} />
              </button>
            </span>
          </div>
        )}

        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="px-2 py-1.5 text-sm text-text-muted transition-colors hover:text-text-primary"
          >
            {t('audit.clearFilters', 'Clear filters')}
          </button>
        )}
      </div>

      {showTenant && (
        <p className="text-xs text-text-muted">
          {t('audit.scopeAllHint', 'Showing every tenant, including platform events that have no tenant (failed logins, SSO sync).')}
        </p>
      )}

      {/* Table */}
      <TableScroll className="bg-bg-secondary">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <LoadingSpinner size="md" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16">
            <Shield size={32} className="text-text-muted opacity-40" />
            <p className="text-sm text-text-muted">
              {hasFilters
                ? t('audit.emptyFiltered', 'No audit entries match your filters.')
                : t('audit.empty', 'No audit entries yet.')}
            </p>
          </div>
        ) : (
          <div className={cn('transition-opacity', loading && 'opacity-60')}>
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border bg-bg-tertiary/40">
                  <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-text-muted">
                    {t('audit.colTime', 'Time')}
                  </th>
                  {showTenant && (
                    <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-text-muted">
                      {t('audit.colTenant', 'Tenant')}
                    </th>
                  )}
                  <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-text-muted">
                    {t('audit.colUser', 'User')}
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-text-muted">
                    {t('audit.colAction', 'Action')}
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-text-muted">
                    {t('audit.colResource', 'Resource')}
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-text-muted">
                    {t('audit.colIp', 'IP')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <AuditRow
                    key={row.id}
                    row={row}
                    showTenant={showTenant}
                    tenantLabel={tenantLabel(row.tenantId)}
                    canLinkProbe={scope === 'tenant' || (row.tenantId !== null && row.tenantId === currentTenantId)}
                    resourceLabel={resourceLabel}
                    onFilterUser={(id, username) => setUserFilter({ id, username })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TableScroll>

      {/* Footer: count + cursor pagination */}
      {items.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-text-muted">
            {t('audit.shownCount', { count: items.length, defaultValue: 'Entries shown: {{count}}' })}
          </span>
          {nextCursor !== null ? (
            <Button variant="secondary" size="sm" loading={loadingMore} onClick={() => void loadMore()}>
              {t('audit.loadMore', 'Load more')}
            </Button>
          ) : (
            <span className="text-xs text-text-muted">{t('audit.endOfLog', 'End of the log')}</span>
          )}
        </div>
      )}
    </PageContainer>
  );
}
