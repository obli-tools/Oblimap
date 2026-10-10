/**
 * AdminDeviceChecksPage — the device check rules of the current workspace:
 * preset and validation status, scope, enabled toggle (with a
 * confirmation), coverage, results, suspension, last editor. Actions: edit,
 * duplicate, export JSON, delete. "New check" opens the preset picker.
 *
 * Also hosts the platform policy (allowed ports, limits, retention), which
 * only platform admins can read and change.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle, ChevronDown, ChevronRight, CopyPlus, FileDown, ListChecks, Loader2, Pencil, Plus, RefreshCw, Search,
  ShieldAlert, SlidersHorizontal, Trash2, X,
} from 'lucide-react';
import {
  DEVICE_CHECK_LIMITS,
  SOCKET_EVENTS,
  getDeviceCheckPreset,
  type DeviceCheckRule,
  type GroupTreeNode,
  type Site,
} from '@oblimap/shared';
import {
  DEFAULT_DEVICE_CHECKS_POLICY,
  deviceChecksApi,
  describeDeviceCheckError,
  parseDeviceCheckError,
  type DeviceCheckIssue,
  type DeviceChecksPolicy,
} from '@/api/deviceChecks.api';
import { siteApi } from '@/api/site.api';
import { usersApi } from '@/api/users.api';
import { getSocket } from '@/socket/socketClient';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore } from '@/store/authStore';
import { useTenantEpoch } from '@/store/tenantStore';
import { useAnonymize } from '@/utils/anonymize';
import { isHandled } from '@/utils/apiError';
import { cn } from '@/utils/cn';
import { saveJson } from '@/utils/download';
import { Button } from '@/components/common/Button';
import { PageContainer, useEmbedded } from '@/components/common/PageContainer';
import { IconButton } from '@/components/common/IconButton';
import { ActionMenu } from '@/components/common/ActionMenu';
import { TableScroll } from '@/components/common/TableScroll';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadError } from '@/components/common/LoadError';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { PresetPicker } from '@/components/deviceChecks/PresetPicker';
import { DeviceCheckIconGlyph } from '@/components/deviceChecks/DeviceCheckChip';
import { FormRow, NumberInput, TagListInput, buildIssueIndex } from '@/components/deviceChecks/sections/GeneralSection';
import { withoutExplicitDevices } from '@/components/deviceChecks/sections/MatchSection';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function flattenGroups(nodes: GroupTreeNode[], out = new Map<number, string>()): Map<number, string> {
  for (const n of nodes) {
    out.set(n.id, n.name);
    flattenGroups(n.children, out);
  }
  return out;
}

function uniqueCopyName(name: string, taken: Set<string>): string {
  const base = name.replace(/ \(copy(?: \d+)?\)$/, '');
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
    const candidate = `${base.slice(0, 128 - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'check';
}

/** Error toast for a device-check API call, unless the API client already reported it. */
function toastDeviceCheckError(err: unknown, t: TFunction, fallback: string): void {
  if (isHandled(err)) return;
  toast.error(describeDeviceCheckError(err, t, fallback));
}

// ─── Platform policy ──────────────────────────────────────────────────────────

// Same caps as the server's policy schema.
const MAX_EVENT_RETENTION_DAYS = 3650;
const MAX_VALUE_RETENTION_DAYS = 365;

function PolicyPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<DeviceChecksPolicy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<DeviceCheckIssue[]>([]);
  const errors = useMemo(() => buildIssueIndex(issues), [issues]);

  useEffect(() => {
    if (!open || policy) return;
    deviceChecksApi.getPolicy()
      .then((p) => { setPolicy(p); setLoadError(null); })
      .catch((err) => setLoadError(describeDeviceCheckError(err, t, t('deviceChecks.policy.loadFailed', 'Failed to load the policy'))));
  }, [open, policy, t]);

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    try {
      setPolicy(await deviceChecksApi.setPolicy(policy));
      setIssues([]);
      toast.success(t('deviceChecks.policy.saved', 'Policy saved'));
    } catch (err) {
      const e = parseDeviceCheckError(err);
      setIssues(e.issues);
      if (e.issues.length > 0) toast.error(t('deviceChecks.policy.fixErrors', 'Fix the highlighted values'));
      else toastDeviceCheckError(err, t, t('deviceChecks.policy.saveFailed', 'Failed to save the policy'));
    } finally {
      setSaving(false);
    }
  };

  const set = (patch: Partial<DeviceChecksPolicy>) => {
    setPolicy((p) => (p ? { ...p, ...patch } : p));
    setIssues((list) => list.filter((i) => !Object.keys(patch).some((k) => i.path === k || i.path.startsWith(`${k}.`))));
  };

  return (
    <div className="rounded-xl bg-bg-secondary">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 rounded-xl px-4 py-3 text-left hover:bg-bg-hover/40 coarse:min-h-11"
      >
        {open ? <ChevronDown size={15} className="text-text-muted" /> : <ChevronRight size={15} className="text-text-muted" />}
        <SlidersHorizontal size={15} className="text-accent" />
        <span className="text-sm font-semibold text-text-primary">{t('deviceChecks.policy.title', 'Platform policy')}</span>
        <span className="text-xs text-text-muted">{t('deviceChecks.policy.subtitle', 'Applies to every workspace')}</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          {loadError && <p className="text-sm text-status-down">{loadError}</p>}
          {!policy && !loadError && <Loader2 size={18} className="animate-spin text-accent" />}
          {policy && (
            <>
              <FormRow
                label={t('deviceChecks.policy.allowedPorts', 'Allowed ports')}
                hint={t('deviceChecks.policy.allowedPortsHint', 'Every variant of every rule must use one of these ports')}
                error={errors.within('allowedPorts')}
              >
                <TagListInput
                  error={errors.within('allowedPorts')}
                  values={policy.allowedPorts.map(String)}
                  onChange={(v) => set({ allowedPorts: v.map(Number) })}
                  normalize={(raw) => {
                    const n = Number(raw);
                    return Number.isInteger(n) && n >= 1 && n <= 65535 ? String(n) : null;
                  }}
                  max={32}
                  mono
                  placeholder="8080"
                />
              </FormRow>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <FormRow label={t('deviceChecks.policy.maxTargets', 'Max targets per probe')} hint={`≤ ${DEVICE_CHECK_LIMITS.maxTargetsPerProbe}`} error={errors.at('maxTargetsPerProbe')}>
                  <NumberInput value={policy.maxTargetsPerProbe} min={1} max={DEVICE_CHECK_LIMITS.maxTargetsPerProbe} error={errors.at('maxTargetsPerProbe')} onChange={(maxTargetsPerProbe) => set({ maxTargetsPerProbe })} />
                </FormRow>
                <FormRow label={t('deviceChecks.policy.minInterval', 'Minimum interval (s)')} hint={`${DEVICE_CHECK_LIMITS.minIntervalSeconds} – ${DEVICE_CHECK_LIMITS.maxIntervalSeconds}`} error={errors.at('minIntervalSeconds')}>
                  <NumberInput value={policy.minIntervalSeconds} min={DEVICE_CHECK_LIMITS.minIntervalSeconds} max={DEVICE_CHECK_LIMITS.maxIntervalSeconds} error={errors.at('minIntervalSeconds')} onChange={(minIntervalSeconds) => set({ minIntervalSeconds })} />
                </FormRow>
                <FormRow label={t('deviceChecks.policy.eventRetention', 'History retention (days)')} hint={`1 – ${MAX_EVENT_RETENTION_DAYS}`} error={errors.at('eventRetentionDays')}>
                  <NumberInput value={policy.eventRetentionDays} min={1} max={MAX_EVENT_RETENTION_DAYS} error={errors.at('eventRetentionDays')} onChange={(eventRetentionDays) => set({ eventRetentionDays })} />
                </FormRow>
                <FormRow label={t('deviceChecks.policy.valueRetention', 'Value history retention (days)')} hint={`1 – ${MAX_VALUE_RETENTION_DAYS}`} error={errors.at('valueEventRetentionDays')}>
                  <NumberInput value={policy.valueEventRetentionDays} min={1} max={MAX_VALUE_RETENTION_DAYS} error={errors.at('valueEventRetentionDays')} onChange={(valueEventRetentionDays) => set({ valueEventRetentionDays })} />
                </FormRow>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void save()} loading={saving}>
                  {t('common.save', 'Save')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setPolicy({ ...DEFAULT_DEVICE_CHECKS_POLICY }); setIssues([]); }}
                >
                  {t('deviceChecks.policy.defaults', 'Defaults')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function AdminDeviceChecksPage() {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const embedded = useEmbedded();
  const { tree, fetchTree } = useGroupStore();
  // The platform policy is read and changed by platform admins only (the
  // server answers 403 to everyone else).
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const tenantEpoch = useTenantEpoch();

  const [rules, setRules] = useState<DeviceCheckRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [userNames, setUserNames] = useState<Map<number, string>>(new Map());
  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const list = await deviceChecksApi.list();
      setRules([...list].sort((a, b) => a.name.localeCompare(b.name)));
      setLoadError(null);
    } catch (err) {
      setLoadError(describeDeviceCheckError(err, t, t('deviceChecks.list.loadFailed', 'Failed to load the device checks')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Reloaded after a tenant switch too: the rules, sites and users
  // are those of the current workspace.
  useEffect(() => { void load(); }, [load, tenantEpoch]);

  useEffect(() => {
    siteApi.list().then(({ sites: list }) => setSites(list)).catch(() => {});
    usersApi.list()
      .then((users) => setUserNames(new Map(users.map((u) => [u.id, u.displayName || u.username]))))
      .catch(() => {});
    if (useGroupStore.getState().tree.length === 0) void fetchTree();
  }, [fetchTree, tenantEpoch]);

  // Another admin changed a rule: refresh quietly (debounced).
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChanged = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(true), 1000);
    };
    socket.on(SOCKET_EVENTS.DEVICE_CHECK_RULES_CHANGED, onChanged);
    return () => {
      if (timer) clearTimeout(timer);
      socket.off(SOCKET_EVENTS.DEVICE_CHECK_RULES_CHANGED, onChanged);
    };
  }, [load]);

  const groupNames = useMemo(() => flattenGroups(tree), [tree]);
  const siteNames = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);

  const filtered = rules.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.name.toLowerCase().includes(q)
      || (r.description ?? '').toLowerCase().includes(q)
      || (r.presetKey ?? '').toLowerCase().includes(q);
  });

  const scopeLabel = (r: DeviceCheckRule): string => {
    if (r.siteId !== null) {
      return t('deviceChecks.list.scopeSite', { name: anonymize(siteNames.get(r.siteId) ?? `#${r.siteId}`, 'hostname'), defaultValue: 'Site: {{name}}' });
    }
    if (r.groupId !== null) {
      return t('deviceChecks.list.scopeGroup', { name: anonymize(groupNames.get(r.groupId) ?? `#${r.groupId}`, 'hostname'), defaultValue: 'Group: {{name}}' });
    }
    return t('deviceChecks.list.scopeTenant', 'Whole workspace');
  };

  const replaceRule = (updated: DeviceCheckRule) =>
    setRules((prev) => prev.map((r) => (r.id === updated.id ? { ...updated, coverage: updated.coverage ?? r.coverage } : r)));

  const askToggle = async (r: DeviceCheckRule) => {
    const enable = !r.enabled;
    const preset = r.presetKey ? getDeviceCheckPreset(r.presetKey) : undefined;
    const warning = enable && preset && !preset.validated
      ? t('deviceChecks.list.enableUnvalidated', 'This preset has not been validated on a real device yet: run a test from the editor first.')
      : undefined;
    const ok = await confirm({
      title: enable
        ? t('deviceChecks.list.confirmEnableTitle', { name: r.name, defaultValue: 'Enable "{{name}}"?' })
        : t('deviceChecks.list.confirmDisableTitle', { name: r.name, defaultValue: 'Disable "{{name}}"?' }),
      message: (
        <div className="space-y-3">
          <p>
            {enable
              ? t('deviceChecks.list.confirmEnable', {
                count: r.coverage?.matchedItems ?? 0,
                defaultValue: 'Probes start running this check on the matched devices ({{count}} now) and alerts can be raised.',
              })
              : t('deviceChecks.list.confirmDisable', 'Probes stop running this check. Open alerts are closed without notification.')}
          </p>
          {warning && (
            <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />{warning}
            </p>
          )}
        </div>
      ),
      confirmLabel: enable ? t('common.enable', 'Enable') : t('common.disable', 'Disable'),
      danger: !enable,
    });
    if (!ok) return;
    setBusyId(r.id);
    try {
      const updated = enable ? await deviceChecksApi.enable(r.id) : await deviceChecksApi.disable(r.id);
      if (updated) replaceRule(updated);
      else setRules((prev) => prev.map((x) => (x.id === r.id ? { ...x, enabled: enable } : x)));
      toast.success(enable ? t('deviceChecks.list.enabledToast', 'Check enabled') : t('deviceChecks.list.disabledToast', 'Check disabled'));
    } catch (err) {
      toastDeviceCheckError(err, t, enable
        ? t('deviceChecks.list.enableFailed', 'Failed to enable the check')
        : t('deviceChecks.list.disableFailed', 'Failed to disable the check'));
    } finally {
      setBusyId(null);
    }
  };

  const askDelete = async (r: DeviceCheckRule) => {
    const ok = await confirm({
      title: t('deviceChecks.list.confirmDeleteTitle', { name: r.name, defaultValue: 'Delete "{{name}}"?' }),
      message: t('deviceChecks.list.confirmDelete', 'Its results, history and stored credentials are deleted too. This cannot be undone.'),
      confirmLabel: t('common.delete', 'Delete'),
      danger: true,
    });
    if (!ok) return;
    setBusyId(r.id);
    try {
      await deviceChecksApi.remove(r.id);
      setRules((prev) => prev.filter((x) => x.id !== r.id));
      toast.success(t('deviceChecks.list.deleted', 'Check deleted'));
    } catch (err) {
      toastDeviceCheckError(err, t, t('deviceChecks.list.deleteFailed', 'Failed to delete the check'));
    } finally {
      setBusyId(null);
    }
  };

  const duplicate = async (r: DeviceCheckRule) => {
    setBusyId(r.id);
    try {
      const taken = new Set(rules.map((x) => x.name.toLowerCase()));
      const copy = await deviceChecksApi.create({
        name: uniqueCopyName(r.name, taken),
        description: r.description,
        groupId: r.groupId,
        siteId: r.siteId,
        presetKey: r.presetKey,
        presetVersion: r.presetVersion,
        spec: JSON.parse(JSON.stringify(r.spec)),
      });
      toast.success((r.credentials?.length ?? 0) > 0
        ? t('deviceChecks.list.duplicatedNoCreds', 'Copy created (disabled). Credentials are not copied: set them in the copy.')
        : t('deviceChecks.list.duplicated', 'Copy created (disabled)'));
      if (copy && typeof copy.id === 'number') navigate(`/manage/device-checks/${copy.id}`);
      else void load(true);
    } catch (err) {
      toastDeviceCheckError(err, t, t('deviceChecks.list.duplicateFailed', 'Failed to duplicate the check'));
    } finally {
      setBusyId(null);
    }
  };

  const exportJson = (r: DeviceCheckRule) => {
    // No rule id, scope, credentials or explicit devices (match.itemIds /
    // excludeItemIds are site_items ids): they belong to this workspace.
    // Importable from the editor (Advanced).
    const { match, dropped } = withoutExplicitDevices(r.spec.match);
    void saveJson(`device-check-${slug(r.name)}.json`, {
      kind: 'oblimap.deviceCheck',
      version: 1,
      exportedAt: new Date().toISOString(),
      name: r.name,
      description: r.description,
      presetKey: r.presetKey,
      presetVersion: r.presetVersion,
      spec: { ...r.spec, match },
    });
    if (dropped > 0) {
      toast(t('deviceChecks.list.exportedNoDevices', 'Exported without its explicit devices: they only exist in this workspace. Pick the devices again after importing.'));
    }
  };

  const suspendedText = (reason: string) => (reason === 'accountable_user_invalid'
    ? t('deviceChecks.list.suspended.accountable_user_invalid', 'Suspended: the last person who saved this check is no longer an active admin.')
    : t('deviceChecks.list.suspended.other', { reason, defaultValue: 'Suspended: {{reason}}' }));

  const newCheckButton = (
    <Button onClick={() => setPickerOpen(true)}>
      <Plus size={15} className="mr-1.5" />{t('deviceChecks.newCheck', 'New check')}
    </Button>
  );

  return (
    <PageContainer
      className="space-y-6"
      icon={<ListChecks className="h-5 w-5" />}
      title={t('deviceChecks.title', 'Device checks')}
      subtitle={t('deviceChecks.list.intro', 'Declarative checks the probes run on discovered devices (for example "is this Barix playing music?"), with alerts during business hours. Rules are created disabled.')}
      actions={newCheckButton}
    >
      {/* Toolbar: search, refresh (and "New check" inside a hub tab, where the header is not rendered) */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] max-w-sm flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('deviceChecks.list.search', 'Search name, description, preset…')}
            aria-label={t('deviceChecks.list.search', 'Search name, description, preset…')}
            className="w-full rounded-md border border-border bg-bg-secondary py-1.5 pl-8 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        {search && (
          <IconButton
            label={t('common.reset', 'Reset')}
            icon={<X size={14} />}
            variant="plain"
            onClick={() => setSearch('')}
          />
        )}
        <div className="ml-auto flex items-center gap-2">
          <IconButton
            label={t('common.refresh', 'Refresh')}
            icon={<RefreshCw size={14} className={cn(loading && 'animate-spin')} />}
            variant="solid"
            size="lg"
            onClick={() => void load()}
          />
          {embedded && newCheckButton}
        </div>
      </div>

      {/* Table */}
      {loading && rules.length === 0 ? (
        <div className="flex items-center justify-center rounded-xl bg-bg-secondary py-16"><Loader2 className="animate-spin text-accent" size={24} /></div>
      ) : loadError ? (
        <LoadError message={loadError} onRetry={() => void load()} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="h-6 w-6" />}
          title={search
            ? t('deviceChecks.list.noMatch', 'No check matches your search.')
            : t('deviceChecks.list.empty', 'No device check yet. Create one from a preset.')}
          action={search ? undefined : newCheckButton}
        />
      ) : (
        <TableScroll className="bg-bg-secondary rounded-xl">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary/50 text-left text-xs font-medium uppercase tracking-wide text-text-muted">
                <th className="px-4 py-3">{t('deviceChecks.list.colName', 'Name')}</th>
                <th className="hidden px-4 py-3 lg:table-cell">{t('deviceChecks.list.colPreset', 'Preset')}</th>
                <th className="hidden px-4 py-3 md:table-cell">{t('deviceChecks.list.colScope', 'Scope')}</th>
                <th className="px-4 py-3">{t('deviceChecks.list.colEnabled', 'Enabled')}</th>
                <th className="hidden px-4 py-3 xl:table-cell">{t('deviceChecks.list.colCoverage', 'Coverage')}</th>
                <th className="hidden px-4 py-3 sm:table-cell">{t('deviceChecks.list.colResults', 'Results')}</th>
                <th className="hidden px-4 py-3 xl:table-cell">{t('deviceChecks.list.colSuspended', 'Suspended')}</th>
                <th className="hidden px-4 py-3 lg:table-cell">{t('deviceChecks.list.colUpdated', 'Updated')}</th>
                <th className="px-4 py-3"><span className="sr-only">{t('common.actions', 'Actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const preset = r.presetKey ? getDeviceCheckPreset(r.presetKey) : undefined;
                const presetUpdate = preset && r.presetVersion !== null && preset.version > r.presetVersion ? preset.version : null;
                const cov = r.coverage;
                const who = r.updatedBy ?? r.createdBy;
                const whoName = who != null ? userNames.get(who) : undefined;
                const busy = busyId === r.id;
                return (
                  <tr key={r.id} className="border-b border-border transition-colors last:border-0 hover:bg-bg-hover/40">
                    {/* Name */}
                    <td className="max-w-[18rem] px-4 py-3">
                      <div className="flex items-center gap-2">
                        <DeviceCheckIconGlyph icon={r.spec?.display?.icon ?? 'info'} size={14} className="shrink-0 text-accent" />
                        <Link to={`/manage/device-checks/${r.id}`} className="truncate font-medium text-text-primary hover:text-accent">
                          {r.name}
                        </Link>
                      </div>
                      {r.description && <p className="mt-0.5 truncate text-xs text-text-muted">{r.description}</p>}
                      {r.suspendedReason && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-400 xl:hidden">
                          <ShieldAlert size={11} />{t('deviceChecks.list.suspendedShort', 'Suspended')}
                        </p>
                      )}
                    </td>

                    {/* Preset */}
                    <td className="hidden px-4 py-3 lg:table-cell">
                      {r.presetKey ? (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-secondary" title={`${r.presetKey} v${r.presetVersion ?? '?'}`}>
                            {preset ? t(preset.titleKey, preset.titleFallback) : r.presetKey}
                          </span>
                          {preset && !preset.validated && (
                            <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400" title={t(`deviceChecks.presets.${preset.key}.validationNotes`, preset.validationNotes)}>
                              {t('deviceChecks.list.needsValidation', 'Preset needs validation')}
                            </span>
                          )}
                          {presetUpdate !== null && (
                            <span className="rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-400">
                              {t('deviceChecks.list.presetUpdate', { version: presetUpdate, defaultValue: 'Preset v{{version}} available' })}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>

                    {/* Scope */}
                    <td className="hidden px-4 py-3 text-xs text-text-secondary md:table-cell">{scopeLabel(r)}</td>

                    {/* Enabled */}
                    <td className="px-4 py-3">
                      <ToggleSwitch
                        size="sm"
                        checked={r.enabled}
                        disabled={busy}
                        onChange={() => void askToggle(r)}
                        ariaLabel={r.enabled ? t('deviceChecks.list.enabled', 'Enabled') : t('deviceChecks.list.disabled', 'Disabled')}
                        title={r.enabled ? t('deviceChecks.list.enabled', 'Enabled') : t('deviceChecks.list.disabled', 'Disabled')}
                      />
                    </td>

                    {/* Coverage */}
                    <td className="hidden px-4 py-3 text-xs text-text-secondary xl:table-cell">
                      {cov ? (
                        <span>
                          {t('deviceChecks.list.coverage', {
                            devices: cov.matchedItems,
                            sites: cov.sites,
                            defaultValue: '{{devices}} devices · {{sites}} sites',
                          })}
                          {cov.withoutCapableProbe > 0 && (
                            <span className="text-amber-400">
                              {' · '}
                              {t('deviceChecks.list.needProbeUpdate', { count: cov.withoutCapableProbe, defaultValue: '{{count}} need a probe update' })}
                            </span>
                          )}
                        </span>
                      ) : <span className="text-text-muted">—</span>}
                    </td>

                    {/* Results */}
                    <td className="hidden px-4 py-3 sm:table-cell">
                      {cov ? (
                        <div className="flex items-center gap-2 text-xs tabular-nums">
                          <span className="text-accent" title={t('deviceChecks.list.ok', 'OK')}>{cov.ok} {t('deviceChecks.list.okShort', 'ok')}</span>
                          <span className={cov.failing > 0 ? 'text-red-400' : 'text-text-muted'} title={t('deviceChecks.list.failing', 'Failing')}>
                            {cov.failing} {t('deviceChecks.list.failingShort', 'failing')}
                          </span>
                          <span className={cov.alerting > 0 ? 'font-semibold text-red-400' : 'text-text-muted'} title={t('deviceChecks.list.alerting', 'Alerting')}>
                            {cov.alerting} {t('deviceChecks.list.alertingShort', 'alerting')}
                          </span>
                        </div>
                      ) : <span className="text-text-muted">—</span>}
                    </td>

                    {/* Suspended */}
                    <td className="hidden max-w-[14rem] px-4 py-3 text-xs xl:table-cell">
                      {r.suspendedReason
                        ? <span className="text-amber-400">{suspendedText(r.suspendedReason)}</span>
                        : <span className="text-text-muted">—</span>}
                    </td>

                    {/* Updated */}
                    <td className="hidden whitespace-nowrap px-4 py-3 text-xs text-text-secondary lg:table-cell">
                      <div title={r.updatedAt}>{new Date(r.updatedAt).toLocaleString()}</div>
                      <div className="text-text-muted">
                        {whoName ? anonymize(whoName, 'username') : who != null ? `#${who}` : '—'}
                      </div>
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-0.5">
                        <Link
                          to={`/manage/device-checks/${r.id}`}
                          aria-label={t('common.edit', 'Edit')}
                          title={t('common.edit', 'Edit')}
                          className="inline-flex items-center justify-center rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                        >
                          <Pencil size={14} />
                        </Link>
                        <ActionMenu
                          sheetTitle={r.name}
                          disabled={busy}
                          items={[
                            {
                              key: 'duplicate',
                              icon: <CopyPlus size={15} />,
                              label: t('deviceChecks.list.duplicate', 'Duplicate'),
                              onClick: () => void duplicate(r),
                            },
                            {
                              key: 'export',
                              icon: <FileDown size={15} />,
                              label: t('deviceChecks.list.export', 'Export JSON'),
                              onClick: () => exportJson(r),
                            },
                            {
                              key: 'delete',
                              icon: <Trash2 size={15} />,
                              label: t('common.delete', 'Delete'),
                              onClick: () => void askDelete(r),
                              danger: true,
                              separator: true,
                            },
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}

      {isPlatformAdmin && <PolicyPanel />}

      <PresetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(key) => {
          setPickerOpen(false);
          navigate(key ? `/manage/device-checks/new?preset=${encodeURIComponent(key)}` : '/manage/device-checks/new');
        }}
      />
    </PageContainer>
  );
}
