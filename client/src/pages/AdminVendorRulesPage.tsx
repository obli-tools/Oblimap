/**
 * AdminVendorRulesPage — manage vendor → device type auto-assignment rules.
 *
 * When a probe discovers a device, it looks up the vendor (OUI prefix).
 * These rules match vendor names to device types so that, for example,
 * "Hikvision" → camera, "Aruba" → ap, etc.
 *
 * Rules are evaluated in descending priority order; first match wins.
 */

import { useState, useEffect, useCallback, useMemo, type FormEvent } from 'react';
import { Shuffle, Plus, Trash2, Pencil, X, ChevronUp, ChevronDown, Loader2, RefreshCw, Wand2, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { Trans, useTranslation } from 'react-i18next';
import type { VendorTypeRule, DeviceType, ObservedVendor } from '@oblimap/shared';
import { suggestDeviceTypeForVendor, autoRulePriority } from '@oblimap/shared';
import { vendorRulesApi } from '@/api/vendorRules.api';
import { Button } from '@/components/common/Button';
import { PageContainer, useEmbedded } from '@/components/common/PageContainer';
import { Modal } from '@/components/common/Modal';
import { IconButton } from '@/components/common/IconButton';
import { TableScroll } from '@/components/common/TableScroll';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadError } from '@/components/common/LoadError';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useTenantEpoch } from '@/store/tenantStore';
import { useFullAccess } from '@/store/authStore';
import { toastApiError } from '@/utils/apiError';
import { DEVICE_TYPE_OPTIONS, deviceTypeColor, deviceTypeIcon, deviceTypeLabel } from '@/utils/deviceTypes';
import { cn } from '@/utils/cn';

const inputCls =
  'w-full text-sm bg-bg-tertiary border border-border rounded-md px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent';

const byPriority = (a: VendorTypeRule, b: VendorTypeRule) => b.priority - a.priority || a.id - b.id;

function TypeBadge({ type }: { type: DeviceType }) {
  const { t } = useTranslation();
  const Icon = deviceTypeIcon(type);
  return (
    <span className={cn('inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium', deviceTypeColor(type))}>
      <Icon size={11} className="shrink-0" />
      {deviceTypeLabel(t, type)}
    </span>
  );
}

// ─── Create / edit dialog ─────────────────────────────────────────────────────

const RULE_FORM_ID = 'vendor-rule-form';

function RuleModal({
  open,
  rule,
  vendors,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** null = new rule. */
  rule: VendorTypeRule | null;
  /** Vendor names seen on the devices (suggestions of the pattern field). */
  vendors: ObservedVendor[];
  onClose: () => void;
  onSaved: (rule: VendorTypeRule, created: boolean) => void;
}) {
  const { t } = useTranslation();
  const [pattern, setPattern] = useState('');
  const [type, setType] = useState<DeviceType>('unknown');
  const [label, setLabel] = useState('');
  const [priority, setPriority] = useState('0');
  const [saving, setSaving] = useState(false);

  // (Re)initialise the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setPattern(rule?.vendorPattern ?? '');
    setType(rule?.deviceType ?? 'unknown');
    setLabel(rule?.label ?? '');
    setPriority(String(rule?.priority ?? 0));
  }, [open, rule]);

  // Devices / vendors the pattern currently matches (case-insensitive substring).
  const matching = useMemo(() => {
    const p = pattern.trim().toLowerCase();
    if (p.length < 2) return null;
    let devices = 0;
    let names = 0;
    for (const v of vendors) {
      if (v.vendor.toLowerCase().includes(p)) { devices += v.devices; names++; }
    }
    return { devices, names };
  }, [pattern, vendors]);

  function changePattern(value: string) {
    setPattern(value);
    // A new rule still on "Unknown" takes the suggested type of a known vendor.
    if (!rule && type === 'unknown') {
      const hint = suggestDeviceTypeForVendor(value);
      if (hint) setType(hint.type);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!pattern.trim()) { toast.error(t('vendorRules.patternRequired', 'Vendor pattern is required')); return; }
    setSaving(true);
    const data = {
      vendorPattern: pattern.trim(),
      deviceType: type,
      label: label.trim() || null,
      priority: parseInt(priority, 10) || 0,
    };
    try {
      if (rule) {
        const { rule: updated } = await vendorRulesApi.update(rule.id, data);
        onSaved(updated, false);
        toast.success(t('vendorRules.ruleUpdated', 'Rule updated'));
      } else {
        const { rule: created } = await vendorRulesApi.create(data);
        onSaved(created, true);
        toast.success(t('vendorRules.ruleAdded', 'Rule added'));
      }
    } catch (err) {
      toastApiError(err, rule
        ? t('vendorRules.failedUpdate', 'Failed to update rule')
        : t('vendorRules.failedAdd', 'Failed to add rule'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!saving) onClose(); }}
      dismissible={!saving}
      icon={<Shuffle className="h-4 w-4 text-accent" />}
      title={rule ? t('vendorRules.editRule', 'Edit rule') : t('vendorRules.addRule', 'Add rule')}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={RULE_FORM_ID} loading={saving}>
            {rule ? t('common.save') : t('vendorRules.addBtn', 'Add')}
          </Button>
        </>
      }
    >
      <form id={RULE_FORM_ID} onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="vr-pattern" className="block text-xs font-medium text-text-secondary">
            {t('vendorRules.colVendorPattern', 'Vendor Pattern')} <span className="text-red-400">*</span>
          </label>
          <input
            id="vr-pattern"
            value={pattern}
            onChange={e => changePattern(e.target.value)}
            placeholder={t('vendorRules.examplePlaceholder', 'e.g. Hikvision')}
            maxLength={128}
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            list="vr-vendor-list"
            autoComplete="off"
            className={inputCls}
          />
          <datalist id="vr-vendor-list">
            {vendors.map(v => (
              <option key={v.vendor} value={v.vendor}>
                {t('vendorRules.vendorDevices', { count: v.devices, defaultValue: '{{count}} devices' })}
              </option>
            ))}
          </datalist>
          <p className="text-[11px] text-text-muted">
            {matching
              ? t('vendorRules.patternMatches', {
                devices: matching.devices,
                names: matching.names,
                defaultValue: 'Matches {{devices}} device(s) of {{names}} vendor name(s) on the platform.',
              })
              : t('vendorRules.patternHint', 'Pick a vendor seen on the platform, or type part of its name.')}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <div className="space-y-1">
            <label htmlFor="vr-type" className="block text-xs font-medium text-text-secondary">
              {t('vendorRules.colDeviceType', 'Device Type')}
            </label>
            <select
              id="vr-type"
              value={type}
              onChange={e => setType(e.target.value as DeviceType)}
              className={inputCls}
            >
              {DEVICE_TYPE_OPTIONS.map(d => <option key={d} value={d}>{deviceTypeLabel(t, d)}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="vr-priority" className="block text-xs font-medium text-text-secondary">
              {t('vendorRules.colPriority', 'Priority')}
            </label>
            <input
              id="vr-priority"
              type="number"
              inputMode="numeric"
              min={-1000}
              max={1000}
              value={priority}
              onChange={e => setPriority(e.target.value)}
              className={cn(inputCls, 'tabular-nums')}
            />
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor="vr-label" className="block text-xs font-medium text-text-secondary">
            {t('vendorRules.label', 'Label')} <span className="text-[10px] text-text-muted">({t('common.optional', 'optional')})</span>
          </label>
          <input
            id="vr-label"
            value={label}
            onChange={e => setLabel(e.target.value)}
            maxLength={64}
            placeholder={t('vendorRules.customLabelPlaceholder', 'Custom display label')}
            className={inputCls}
          />
        </div>
      </form>
    </Modal>
  );
}

// ─── Auto rules ───────────────────────────────────────────────────────────────

interface AutoRow {
  pattern: string;
  type: DeviceType;
  ambiguous: boolean;
  vendorNames: string[];
  devices: number;
  selected: boolean;
}

/**
 * Best-effort rules for the vendors seen on the platform that no rule covers
 * yet (shared VENDOR_TYPE_HINTS). Created below the hand-written rules
 * (negative priority), longer patterns first; ambiguous vendors are flagged.
 */
function AutoRulesModal({
  open,
  vendors,
  rules,
  onClose,
  onCreated,
}: {
  open: boolean;
  vendors: ObservedVendor[];
  rules: VendorTypeRule[];
  onClose: () => void;
  onCreated: (created: VendorTypeRule[]) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AutoRow[]>([]);
  const [saving, setSaving] = useState(false);

  // Vendors already matched by a rule (any scope) are left out.
  const { suggested, withoutHint } = useMemo(() => {
    const patterns = rules.map(r => r.vendorPattern.trim().toLowerCase()).filter(p => p.length > 0);
    const byPattern = new Map<string, AutoRow>();
    const none: ObservedVendor[] = [];
    for (const v of vendors) {
      const name = v.vendor.toLowerCase();
      if (patterns.some(p => name.includes(p))) continue;
      const hint = suggestDeviceTypeForVendor(v.vendor);
      if (!hint) { none.push(v); continue; }
      const row = byPattern.get(hint.pattern) ?? {
        pattern: hint.pattern,
        type: hint.type,
        ambiguous: !!hint.ambiguous,
        vendorNames: [],
        devices: 0,
        selected: true,
      };
      row.vendorNames.push(v.vendor);
      row.devices += v.devices;
      byPattern.set(hint.pattern, row);
    }
    return {
      suggested: [...byPattern.values()].sort((a, b) => b.devices - a.devices || a.pattern.localeCompare(b.pattern)),
      withoutHint: none,
    };
  }, [vendors, rules]);

  useEffect(() => { if (open) setRows(suggested); }, [open, suggested]);

  const selected = rows.filter(r => r.selected);
  const update = (pattern: string, patch: Partial<AutoRow>) =>
    setRows(prev => prev.map(r => (r.pattern === pattern ? { ...r, ...patch } : r)));

  async function submit() {
    if (selected.length === 0) return;
    setSaving(true);
    try {
      const { rules: created, skipped } = await vendorRulesApi.bulkCreate(selected.map(r => ({
        vendorPattern: r.pattern,
        deviceType: r.type,
        priority: autoRulePriority(r.pattern),
      })));
      toast.success(skipped > 0
        ? t('vendorRules.autoCreatedSkipped', { count: created.length, skipped, defaultValue: '{{count}} rule(s) created, {{skipped}} already existed' })
        : t('vendorRules.autoCreated', { count: created.length, defaultValue: '{{count}} rule(s) created' }));
      onCreated(created);
    } catch (err) {
      toastApiError(err, t('vendorRules.failedAdd', 'Failed to add rule'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!saving) onClose(); }}
      dismissible={!saving}
      size="lg"
      icon={<Wand2 className="h-4 w-4 text-accent" />}
      title={t('vendorRules.autoTitle', 'Auto rules')}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} loading={saving} disabled={selected.length === 0}>
            {t('vendorRules.autoCreate', { count: selected.length, defaultValue: 'Create {{count}} rule(s)' })}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-text-muted">
          {t('vendorRules.autoIntro', 'Suggested types for the vendors seen on the platform that no rule covers yet. They are a best guess from the vendor name (a MAC prefix identifies the manufacturer, not the product line): check the flagged ones. The rules are created below your own rules (negative priority); types set by hand are never changed.')}
        </p>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-muted">
            {t('vendorRules.autoNone', 'No suggestion: every known vendor of the platform is covered by a rule, or has no suggested type.')}
          </p>
        ) : (
          <TableScroll className="max-h-[50vh] rounded-lg bg-bg-tertiary/40">
            <table className="w-full text-sm">
              <tbody>
                {rows.map(row => (
                  <tr key={row.pattern} className="border-b border-border last:border-0">
                    <td className="w-8 px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        checked={row.selected}
                        onChange={e => update(row.pattern, { selected: e.target.checked })}
                        aria-label={row.pattern}
                        className="mt-1 accent-accent"
                      />
                    </td>
                    <td className="px-2 py-2 align-top">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-text-primary">{row.pattern}</span>
                        {row.ambiguous && (
                          <span
                            className="inline-flex items-center gap-0.5 rounded bg-amber-500/10 px-1.5 text-[10px] text-amber-400"
                            title={t('vendorRules.autoAmbiguousHint', 'This manufacturer makes several kinds of devices: the suggested type is its most common one on a LAN.')}
                          >
                            <AlertTriangle size={10} />
                            {t('vendorRules.autoAmbiguous', 'Check')}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-text-muted" title={row.vendorNames.join('\n')}>
                        {row.vendorNames.join(' · ')}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 align-top text-xs text-text-muted tabular-nums">
                      {t('vendorRules.vendorDevices', { count: row.devices, defaultValue: '{{count}} devices' })}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <select
                        value={row.type}
                        onChange={e => update(row.pattern, { type: e.target.value as DeviceType })}
                        aria-label={t('vendorRules.colDeviceType', 'Device Type')}
                        className="w-full min-w-[8rem] rounded-md border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary"
                      >
                        {DEVICE_TYPE_OPTIONS.map(d => <option key={d} value={d}>{deviceTypeLabel(t, d)}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
        {withoutHint.length > 0 && (
          <p className="text-[11px] text-text-muted">
            {t('vendorRules.autoWithoutHint', {
              count: withoutHint.length,
              names: withoutHint.slice(0, 5).map(v => v.vendor).join(', '),
              defaultValue: '{{count}} other vendor(s) without suggestion (e.g. {{names}}): add their rules by hand.',
            })}
          </p>
        )}
      </div>
    </Modal>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function AdminVendorRulesPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const embedded = useEmbedded();
  const tenantEpoch = useTenantEpoch();
  const [rules, setRules] = useState<VendorTypeRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [search, setSearch] = useState('');
  // undefined = dialog closed, null = new rule, else the rule being edited.
  const [editing, setEditing] = useState<VendorTypeRule | null | undefined>(undefined);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reapplying, setReapplying] = useState(false);
  const [vendors, setVendors] = useState<ObservedVendor[]>([]);
  const [autoOpen, setAutoOpen] = useState(false);
  // Re-applying to the whole tenant needs full access (server-enforced).
  const canReapplyTenant = useFullAccess();

  async function handleReapply() {
    setReapplying(true);
    try {
      const { updated, scanned } = await vendorRulesApi.reapply({ scope: 'tenant' });
      toast.success(t('vendorRules.reapplied', {
        updated,
        scanned,
        defaultValue: 'Rules re-applied: {{updated}} of {{scanned}} devices re-typed',
      }));
    } catch (err) {
      toastApiError(err, t('vendorRules.failedReapply', 'Failed to re-apply the rules'));
    } finally {
      setReapplying(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { rules: r } = await vendorRulesApi.list();
      setRules([...r].sort(byPriority));
      setLoadFailed(false);
    } catch (err) {
      setLoadFailed(true);
      toastApiError(err, t('vendorRules.failedLoad', 'Failed to load vendor rules'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Reloaded after a tenant switch too.
  useEffect(() => { void load(); }, [load, tenantEpoch]);

  // Vendor names of the platform (pattern suggestions, auto rules). Optional:
  // a failure only leaves the suggestions empty.
  const loadVendors = useCallback(async () => {
    try {
      const { vendors: v } = await vendorRulesApi.observedVendors();
      setVendors(v);
    } catch {
      setVendors([]);
    }
  }, []);
  useEffect(() => { void loadVendors(); }, [loadVendors, tenantEpoch]);

  async function handleDelete(rule: VendorTypeRule) {
    const ok = await confirm({
      title: t('vendorRules.deleteTitle', 'Delete rule'),
      message: t('vendorRules.confirmDeleteReapply', {
        pattern: rule.vendorPattern,
        type: deviceTypeLabel(t, rule.deviceType),
        defaultValue: 'Delete the rule "{{pattern}}" → {{type}}? Devices it typed are checked against the remaining rules; those no other rule matches keep their type.',
      }),
      danger: true,
    });
    if (!ok) return;
    setBusyId(rule.id);
    try {
      await vendorRulesApi.remove(rule.id);
      setRules(prev => prev.filter(r => r.id !== rule.id));
      toast.success(t('vendorRules.ruleDeleted', 'Rule deleted'));
    } catch (err) {
      toastApiError(err, t('vendorRules.failedDelete', 'Failed to delete rule'));
    } finally {
      setBusyId(null);
    }
  }

  async function adjustPriority(rule: VendorTypeRule, delta: number) {
    const newPriority = Math.max(-1000, Math.min(1000, rule.priority + delta));
    if (newPriority === rule.priority) return;
    setBusyId(rule.id);
    try {
      const { rule: updated } = await vendorRulesApi.update(rule.id, { priority: newPriority });
      setRules(prev => prev.map(r => r.id === rule.id ? updated : r).sort(byPriority));
    } catch (err) {
      toastApiError(err, t('vendorRules.failedPriority', 'Failed to update priority'));
    } finally {
      setBusyId(null);
    }
  }

  const filtered = rules.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      r.vendorPattern.toLowerCase().includes(q) ||
      r.deviceType.toLowerCase().includes(q) ||
      deviceTypeLabel(t, r.deviceType).toLowerCase().includes(q) ||
      (r.label ?? '').toLowerCase().includes(q)
    );
  });

  const addButton = (
    <Button size="sm" onClick={() => setEditing(null)}>
      <Plus size={14} className="mr-1.5" />
      {t('vendorRules.addRule', 'Add rule')}
    </Button>
  );

  const reapplyButton = canReapplyTenant ? (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => void handleReapply()}
      disabled={reapplying || rules.length === 0}
      title={t('vendorRules.reapplyHint', 'Re-type the existing devices with the current rules. Types set by hand are never changed.')}
    >
      <RefreshCw size={14} className={cn('mr-1.5', reapplying && 'animate-spin')} />
      {t('vendorRules.reapply', 'Re-apply rules')}
    </Button>
  ) : null;

  const autoButton = (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => { void loadVendors(); setAutoOpen(true); }}
      title={t('vendorRules.autoHint', 'Suggest rules for the vendors seen on the platform that no rule covers yet')}
    >
      <Wand2 size={14} className="mr-1.5" />
      {t('vendorRules.autoRules', 'Auto rules')}
    </Button>
  );

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      {reapplyButton}
      {autoButton}
      {addButton}
    </div>
  );

  return (
    <PageContainer
      className="space-y-6"
      icon={<Shuffle className="h-5 w-5" />}
      title={t('vendorRules.pageTitle', 'Vendor Rules')}
      subtitle={t('vendorRules.pageDesc', 'Map vendor name patterns to device types. Rules are applied in descending priority order — the first match wins.')}
      actions={headerActions}
    >
      {/* Toolbar: search, rule count (and "Add rule" inside a hub tab) */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] max-w-sm flex-1">
          <input
            type="text"
            placeholder={t('vendorRules.searchPlaceholder', 'Search pattern, type or label…')}
            aria-label={t('vendorRules.searchPlaceholder', 'Search pattern, type or label…')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full text-sm bg-bg-secondary border border-border rounded-md px-3 py-1.5 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        {search && (
          <IconButton label={t('common.reset', 'Reset')} icon={<X size={14} />} variant="plain" onClick={() => setSearch('')} />
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="rounded-lg bg-bg-secondary px-3 py-1.5 text-sm text-text-muted">
            <Trans
              i18nKey="vendorRules.ruleCount"
              count={rules.length}
              defaults="<strong>{{count}}</strong> rules"
              components={{ strong: <span className="font-semibold text-text-primary" /> }}
            />
          </span>
          {embedded && reapplyButton}
          {embedded && autoButton}
          {embedded && addButton}
        </div>
      </div>

      {/* Table */}
      {loading && rules.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl bg-bg-secondary py-16 text-sm text-text-muted">
          <Loader2 size={16} className="animate-spin" />
          {t('common.loading')}
        </div>
      ) : loadFailed && rules.length === 0 ? (
        <LoadError onRetry={() => void load()} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Shuffle className="h-6 w-6" />}
          title={search
            ? t('vendorRules.noMatch', 'No rules match your search.')
            : t('vendorRules.noRulesYet', 'No vendor rules yet.')}
          action={search ? undefined : addButton}
        />
      ) : (
        <TableScroll className="bg-bg-secondary rounded-xl">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary/50">
                <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wide">
                  {t('vendorRules.colVendorPattern', 'Vendor Pattern')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wide">
                  {t('vendorRules.colDeviceType', 'Device Type')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wide hidden lg:table-cell">
                  {t('vendorRules.label', 'Label')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wide hidden md:table-cell">
                  {t('vendorRules.colPriority', 'Priority')}
                </th>
                <th className="px-4 py-3"><span className="sr-only">{t('common.actions', 'Actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(rule => {
                const busy = busyId === rule.id;
                return (
                  <tr
                    key={rule.id}
                    className={cn('border-b border-border last:border-0 hover:bg-bg-hover/40 transition-colors', busy && 'opacity-60')}
                  >
                    <td className="px-4 py-3">
                      <span className="font-mono text-text-primary">{rule.vendorPattern}</span>
                    </td>
                    <td className="px-4 py-3">
                      <TypeBadge type={rule.deviceType} />
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <span className="text-text-secondary">{rule.label ?? <span className="text-text-muted">—</span>}</span>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <div className="flex items-center gap-1">
                        <span className="text-text-secondary tabular-nums w-8">{rule.priority}</span>
                        <div className="flex flex-col">
                          <IconButton
                            label={t('vendorRules.increasePriority', 'Increase priority')}
                            icon={<ChevronUp size={12} />}
                            size="xs"
                            variant="plain"
                            touchTarget="overlay"
                            disabled={busy}
                            onClick={() => void adjustPriority(rule, 10)}
                          />
                          <IconButton
                            label={t('vendorRules.decreasePriority', 'Decrease priority')}
                            icon={<ChevronDown size={12} />}
                            size="xs"
                            variant="plain"
                            touchTarget="overlay"
                            disabled={busy}
                            onClick={() => void adjustPriority(rule, -10)}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <IconButton
                          label={t('common.edit')}
                          icon={<Pencil size={14} />}
                          disabled={busy}
                          onClick={() => setEditing(rule)}
                        />
                        <IconButton
                          label={t('common.delete')}
                          icon={<Trash2 size={14} />}
                          variant="danger"
                          disabled={busy}
                          onClick={() => void handleDelete(rule)}
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

      {/* How it works */}
      <div className="rounded-xl bg-bg-secondary p-4 text-sm text-text-secondary space-y-1">
        <p className="font-medium text-text-primary mb-2">{t('vendorRules.howTitle', 'How vendor rules work')}</p>
        <p>• {t('vendorRules.howLookup', 'When a probe discovers a new device, it looks up the OUI vendor from the MAC prefix.')}</p>
        <p>• {t('vendorRules.howReapply', 'Creating, editing or deleting a rule re-types the existing devices it covers. A device type set by hand is never changed.')}</p>
        <p>
          •{' '}
          <Trans
            i18nKey="vendorRules.howOrder"
            defaults="Each rule is checked in descending priority order. The <strong>first</strong> rule whose pattern appears in the vendor name is applied."
            components={{ strong: <strong /> }}
          />
        </p>
        <p>
          •{' '}
          <Trans
            i18nKey="vendorRules.howMatch"
            defaults="Pattern matching is case-insensitive substring match (e.g. <code>hikvision</code> matches <em>“Hangzhou Hikvision Digital Technology”</em>)."
            components={{ code: <code className="bg-bg-tertiary rounded px-1" />, em: <em /> }}
          />
        </p>
        <p>
          •{' '}
          <Trans
            i18nKey="vendorRules.howDefault"
            defaults="If no rule matches, the device type defaults to <badge>Unknown</badge>."
            components={{ badge: <span className={cn('inline-flex items-center gap-1 rounded px-1.5 text-xs', deviceTypeColor('unknown'))} /> }}
          />
        </p>
      </div>

      <AutoRulesModal
        open={autoOpen}
        vendors={vendors}
        rules={rules}
        onClose={() => setAutoOpen(false)}
        onCreated={(created) => {
          setRules(prev => [...prev, ...created].sort(byPriority));
          setAutoOpen(false);
        }}
      />

      <RuleModal
        open={editing !== undefined}
        rule={editing ?? null}
        vendors={vendors}
        onClose={() => setEditing(undefined)}
        onSaved={(saved, created) => {
          setRules(prev => (created ? [...prev, saved] : prev.map(r => (r.id === saved.id ? saved : r))).sort(byPriority));
          setEditing(undefined);
        }}
      />
    </PageContainer>
  );
}
