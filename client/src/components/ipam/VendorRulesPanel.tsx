import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Edit2, Check, X, Tag, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { VendorTypeRule, DeviceType } from '@oblimap/shared';
import { vendorRulesApi } from '@/api/vendorRules.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { TableScroll } from '@/components/common/TableScroll';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useAuthStore, useFullAccess } from '@/store/authStore';
import { toastApiError } from '@/utils/apiError';
import { DEVICE_TYPE_OPTIONS, deviceTypeColor, deviceTypeIcon, deviceTypeLabel } from '@/utils/deviceTypes';
import { cn } from '@/utils/cn';

const cellInputCls =
  'w-full rounded-md border border-border bg-bg-tertiary px-2 py-1 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent';

const byPriority = (a: VendorTypeRule, b: VendorTypeRule) => b.priority - a.priority || a.id - b.id;

// Same bounds as the server's vendor-rule schema.
const MIN_PRIORITY = -1000;
const MAX_PRIORITY = 1000;

function DeviceTypeSelect({ value, onChange, id }: { value: DeviceType; onChange: (v: DeviceType) => void; id?: string }) {
  const { t } = useTranslation();
  return (
    <select
      id={id}
      className={cellInputCls}
      value={value}
      onChange={(e) => onChange(e.target.value as DeviceType)}
      aria-label={t('vendorRules.colDeviceType', 'Device Type')}
    >
      {DEVICE_TYPE_OPTIONS.map((d) => (
        <option key={d} value={d}>{deviceTypeLabel(t, d)}</option>
      ))}
    </select>
  );
}

// ── Editable row ─────────────────────────────────────────────────────────────

interface EditRowProps {
  rule: VendorTypeRule;
  onSave: (id: number, patch: Partial<Pick<VendorTypeRule, 'vendorPattern' | 'deviceType' | 'label' | 'priority'>>) => Promise<void>;
  onCancel: () => void;
  onDelete: (rule: VendorTypeRule) => Promise<void>;
  saving: boolean;
}

function EditRow({ rule, onSave, onCancel, onDelete, saving }: EditRowProps) {
  const { t } = useTranslation();

  const [pattern, setPattern] = useState(rule.vendorPattern);
  const [deviceType, setDeviceType] = useState<DeviceType>(rule.deviceType);
  const [label, setLabel] = useState(rule.label ?? '');
  const [priority, setPriority] = useState(String(rule.priority));

  const submit = () =>
    onSave(rule.id, {
      vendorPattern: pattern.trim(),
      deviceType,
      label: label.trim() || null,
      priority: parseInt(priority, 10) || 0,
    });

  return (
    <tr className="bg-accent/5">
      <td className="px-3 py-2">
        <input
          className={cellInputCls}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && pattern.trim() && !saving) void submit(); }}
          placeholder={t('vendorRules.editPatternPlaceholder')}
          aria-label={t('vendorRules.colVendorPattern', 'Vendor Pattern')}
          maxLength={128}
          autoFocus
        />
      </td>
      <td className="px-3 py-2">
        <DeviceTypeSelect value={deviceType} onChange={setDeviceType} />
      </td>
      <td className="px-3 py-2">
        <input
          className={cellInputCls}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('vendorRules.editLabelPlaceholder')}
          aria-label={t('vendorRules.colLabelOverride', 'Label Override')}
          maxLength={64}
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          inputMode="numeric"
          className={cn(cellInputCls, 'w-20 tabular-nums')}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          aria-label={t('vendorRules.colPriority', 'Priority')}
          min={MIN_PRIORITY}
          max={MAX_PRIORITY}
        />
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <IconButton
            label={t('common.save')}
            icon={<Check size={14} />}
            variant="accent"
            onClick={() => void submit()}
            disabled={saving || !pattern.trim()}
            className="text-emerald-400"
          />
          <IconButton
            label={t('common.cancel')}
            icon={<X size={14} />}
            onClick={onCancel}
          />
          <IconButton
            label={t('common.delete')}
            icon={<Trash2 size={13} />}
            variant="danger"
            onClick={() => void onDelete(rule)}
            disabled={saving}
          />
        </div>
      </td>
    </tr>
  );
}

// ── Add row ───────────────────────────────────────────────────────────────────

interface AddRowProps {
  groupId: number;
  onAdd: (rule: VendorTypeRule) => void;
}

function AddRow({ groupId, onAdd }: AddRowProps) {
  const { t } = useTranslation();

  const [pattern, setPattern]       = useState('');
  const [deviceType, setDeviceType] = useState<DeviceType>('unknown');
  const [label, setLabel]           = useState('');
  const [priority, setPriority]     = useState('0');
  const [saving, setSaving]         = useState(false);

  const submit = async () => {
    if (!pattern.trim() || saving) return;
    setSaving(true);
    try {
      const { rule } = await vendorRulesApi.create({
        vendorPattern: pattern.trim(),
        deviceType,
        label: label.trim() || null,
        priority: parseInt(priority, 10) || 0,
        groupId,
      });
      onAdd(rule);
      setPattern('');
      setLabel('');
      setPriority('0');
      setDeviceType('unknown');
      toast.success(t('vendorRules.ruleAdded'));
    } catch (err) {
      toastApiError(err, t('vendorRules.failedAdd'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="border-t border-border bg-bg-tertiary/30">
      <td className="px-3 py-2">
        <input
          className={cellInputCls}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder={t('vendorRules.patternPlaceholder')}
          aria-label={t('vendorRules.colVendorPattern', 'Vendor Pattern')}
          maxLength={128}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
      </td>
      <td className="px-3 py-2">
        <DeviceTypeSelect value={deviceType} onChange={setDeviceType} />
      </td>
      <td className="px-3 py-2">
        <input
          className={cellInputCls}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('vendorRules.labelPlaceholder')}
          aria-label={t('vendorRules.colLabelOverride', 'Label Override')}
          maxLength={64}
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          inputMode="numeric"
          className={cn(cellInputCls, 'w-20 tabular-nums')}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          aria-label={t('vendorRules.colPriority', 'Priority')}
          min={MIN_PRIORITY}
          max={MAX_PRIORITY}
        />
      </td>
      <td className="px-3 py-2">
        <Button size="sm" onClick={() => void submit()} loading={saving} disabled={!pattern.trim()}>
          <Plus size={13} className="mr-1" />
          {t('vendorRules.addBtn')}
        </Button>
      </td>
    </tr>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface VendorRulesPanelProps {
  groupId: number;
  /**
   * Show the mutation controls (edit / delete / add). The server requires
   * 'sites.manage' + 'deviceChecks.manage' for vendor-rule mutations; the
   * list itself stays readable. Defaults to true (existing callers).
   */
  canEdit?: boolean;
}

export function VendorRulesPanel({ groupId, canEdit = true }: VendorRulesPanelProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [rules, setRules] = useState<VendorTypeRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [reapplying, setReapplying] = useState(false);
  // Re-applying to the group needs write access on it (server-enforced);
  // re-evaluated when the permissions reload.
  useAuthStore((s) => s.permissions);
  const fullAccess = useFullAccess();
  const canReapply = canEdit && (fullAccess || useAuthStore.getState().canWriteGroup(groupId));

  const handleReapply = async () => {
    setReapplying(true);
    try {
      const { updated, scanned } = await vendorRulesApi.reapply({ scope: 'group', id: groupId });
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
  };

  const load = useCallback(async () => {
    try {
      const { rules: r } = await vendorRulesApi.list(groupId);
      setRules([...r].sort(byPriority));
    } catch (err) {
      toastApiError(err, t('vendorRules.failedLoad'));
    } finally {
      setLoading(false);
    }
  }, [groupId, t]);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async (
    id: number,
    patch: Partial<Pick<VendorTypeRule, 'vendorPattern' | 'deviceType' | 'label' | 'priority'>>,
  ) => {
    setSaving(true);
    try {
      const { rule } = await vendorRulesApi.update(id, patch);
      setRules((prev) => prev.map((r) => (r.id === id ? rule : r)).sort(byPriority));
      setEditingId(null);
      toast.success(t('vendorRules.ruleUpdated'));
    } catch (err) {
      toastApiError(err, t('vendorRules.failedUpdate'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (rule: VendorTypeRule) => {
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
    setSaving(true);
    try {
      await vendorRulesApi.remove(rule.id);
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
      setEditingId((cur) => (cur === rule.id ? null : cur));
      toast.success(t('vendorRules.ruleDeleted'));
    } catch (err) {
      toastApiError(err, t('vendorRules.failedDelete'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl bg-bg-secondary">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Tag size={14} className="text-accent shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-text-primary">{t('vendorRules.title')}</h3>
          <p className="text-xs text-text-muted mt-0.5">{t('vendorRules.description')}</p>
        </div>
        {canReapply && (
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0"
            onClick={() => void handleReapply()}
            disabled={reapplying}
            title={t('vendorRules.reapplyGroupHint', 'Re-type the existing devices of this group and its sub-groups with the current rules. Types set by hand are never changed.')}
          >
            <RefreshCw size={13} className={cn('mr-1.5', reapplying && 'animate-spin')} />
            {t('vendorRules.reapply', 'Re-apply rules')}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="px-4 py-8 text-center text-sm text-text-muted">{t('common.loading')}</div>
      ) : (
        <TableScroll className="rounded-t-none">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-text-muted">
                <th className="px-3 py-2 w-48">{t('vendorRules.colVendorPattern')}</th>
                <th className="px-3 py-2 w-40">{t('vendorRules.colDeviceType')}</th>
                <th className="px-3 py-2">{t('vendorRules.colLabelOverride')}</th>
                <th className="px-3 py-2 w-24">{t('vendorRules.colPriority')}</th>
                <th className="px-3 py-2 w-28"><span className="sr-only">{t('common.actions', 'Actions')}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rules.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-text-muted text-xs">
                    {canEdit ? t('vendorRules.noRules') : t('vendorRules.noRulesYet', 'No vendor rules yet.')}
                  </td>
                </tr>
              )}
              {rules.map((rule) => {
                if (canEdit && editingId === rule.id) {
                  return (
                    <EditRow
                      key={rule.id}
                      rule={rule}
                      onSave={handleSave}
                      onCancel={() => setEditingId(null)}
                      onDelete={handleDelete}
                      saving={saving}
                    />
                  );
                }
                const Icon = deviceTypeIcon(rule.deviceType);
                return (
                  <tr key={rule.id} className="group hover:bg-bg-hover/40 transition-colors">
                    <td className="px-3 py-2">
                      <code className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs font-mono text-text-primary">
                        {rule.vendorPattern}
                      </code>
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', deviceTypeColor(rule.deviceType))}>
                        <Icon size={11} className="shrink-0" />
                        {deviceTypeLabel(t, rule.deviceType)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-text-secondary text-xs">
                      {rule.label ?? <span className="text-text-muted italic">—</span>}
                    </td>
                    <td className="px-3 py-2 text-text-muted text-xs tabular-nums">{rule.priority}</td>
                    <td className="px-3 py-2">
                      {canEdit && (
                        <div className="flex items-center gap-1 can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:group-focus-within:opacity-100 transition-opacity">
                          <IconButton
                            label={t('common.edit')}
                            icon={<Edit2 size={13} />}
                            onClick={() => setEditingId(rule.id)}
                            disabled={saving}
                          />
                          <IconButton
                            label={t('common.delete')}
                            icon={<Trash2 size={13} />}
                            variant="danger"
                            onClick={() => void handleDelete(rule)}
                            disabled={saving}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {/* Add row at the bottom (rule editors only) */}
              {canEdit && (
                <AddRow
                  groupId={groupId}
                  onAdd={(rule) => setRules((prev) => [...prev, rule].sort(byPriority))}
                />
              )}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  );
}
