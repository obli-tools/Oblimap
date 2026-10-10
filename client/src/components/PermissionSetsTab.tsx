import { Fragment, useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Trash2, Check, Shield, Pencil, X, Info, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import {
  CAPABILITY_GROUPS,
  COMBINED_CAPABILITY_REQUIREMENTS,
  impliedCapabilities,
  type CapabilityGroup,
} from '@oblimap/shared';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { toastApiError } from '@/utils/apiError';
import {
  permissionSetsApi,
  TENANT_ADMIN_ROLE,
  type CapabilityInfo,
  type PermissionSet,
  type TenantCapability,
} from '@/api/permissionSets.api';

// Permission sets are the tenant roles: a member's role in a workspace
// (Admin > Workspaces > Members) names one set, and the set's capabilities
// decide WHAT the member may do there; teams decide WHERE (groups, sites).
// The 'admin' set (tenant admin) always holds every capability.
// Rows are grouped (shared CAPABILITY_GROUPS). 'monitoring' is the baseline
// row: locked and ticked everywhere (reading follows the team permissions; it
// is still stored and saved as it is). A capability another ticked one
// implies (probes.manage → probes.approve → probes.read) is shown ticked and
// locked, and is not stored on its own: unticking the broader one unticks it.

// Tenant role reserved by the server (legacy memberships): never a set slug.
const RESERVED_SLUGS = new Set(['member']);

/** English short names (the client translates them: permissionSets.capName.*). */
const CAP_SHORT_NAMES: Record<string, string> = {
  monitoring: 'Monitoring',
  'groups.manage': 'Manage groups',
  'sites.manage': 'Manage sites',
  'probes.read': 'View probes',
  'probes.approve': 'Approve probes',
  'probes.manage': 'Manage probes',
  'tunnels.use': 'Use tunnels',
  'deviceChecks.manage': 'Manage device checks',
  'notifications.manage': 'Manage notifications',
  settings: 'Settings',
  'users.manage': 'Manage users and teams',
  'audit.read': 'Read the audit log',
};

/** i18n key suffix of a capability (dots → underscores). */
const capKey = (key: string) => key.replace(/\./g, '_');

/**
 * Slug of a new set, from its name (accents dropped). A name with no Latin
 * letter or digit (ja, zh-CN, ru, ar, uk...) or a reserved one gets a
 * generated slug: the slug is only an identifier, the name is what is shown.
 */
function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
    .replace(/-$/, '');
  return slug && !RESERVED_SLUGS.has(slug) ? slug : `set-${Date.now().toString(36)}`;
}

/** The stored list after a toggle: capabilities another one implies are not stored on their own. */
function nextStoredCapabilities(current: readonly TenantCapability[], toggled: TenantCapability): TenantCapability[] {
  const updated = current.includes(toggled) ? current.filter((c) => c !== toggled) : [...current, toggled];
  const implied = new Set(impliedCapabilities(updated));
  return updated.filter((c) => !implied.has(c));
}

interface RowGroup {
  id: CapabilityGroup['id'] | 'other';
  label: string;
  caps: CapabilityInfo[];
}

export function PermissionSetsTab() {
  const { t } = useTranslation();

  const [sets, setSets] = useState<PermissionSet[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // Rename inline
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  /** Capability label, translated by key (the server's English label as fallback). */
  const capabilityLabel = (cap: CapabilityInfo): string =>
    t(`permissionSets.cap.${capKey(cap.key)}`, cap.label);
  const capabilityDescription = (cap: CapabilityInfo): string =>
    cap.description ? t(`permissionSets.capDescription.${capKey(cap.key)}`, cap.description) : '';
  const shortName = (key: string): string =>
    t(`permissionSets.capName.${capKey(key)}`, CAP_SHORT_NAMES[key] ?? key);

  const fetchData = useCallback(async () => {
    try {
      const [setsRes, capsRes] = await Promise.all([permissionSetsApi.list(), permissionSetsApi.capabilities()]);
      setSets(setsRes);
      setCapabilities(capsRes);
    } catch (err) {
      toastApiError(err, t('permissionSets.failedLoad', 'Failed to load permission sets'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Rows grouped like the shared CAPABILITY_GROUPS (the server's `group`
  // wins); a capability no group lists (newer server) goes last.
  const rowGroups = useMemo<RowGroup[]>(() => {
    const groups: RowGroup[] = CAPABILITY_GROUPS.map((g) => ({
      id: g.id,
      label: t(`permissionSets.groups.${g.id}`, g.label),
      caps: [],
    }));
    const other: RowGroup = { id: 'other', label: t('permissionSets.groups.other', 'Other'), caps: [] };
    for (const cap of capabilities) {
      const groupId = cap.group ?? CAPABILITY_GROUPS.find((g) => g.keys.includes(cap.key))?.id;
      (groups.find((g) => g.id === groupId) ?? other).caps.push(cap);
    }
    return [...groups, other].filter((g) => g.caps.length > 0);
  }, [capabilities, t]);

  const toggleCapability = async (set: PermissionSet, cap: TenantCapability) => {
    if (set.slug === TENANT_ADMIN_ROLE) return;
    const updated = nextStoredCapabilities(set.capabilities, cap);

    // Optimistic update
    setSets((prev) =>
      prev.map((s) => (s.id === set.id ? { ...s, capabilities: updated } : s)),
    );

    try {
      await permissionSetsApi.update(set.id, { capabilities: updated });
    } catch (err) {
      toastApiError(err, t('permissionSets.failedUpdate', 'Failed to update permission set'));
      void fetchData(); // revert
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await permissionSetsApi.create({
        name: newName.trim(),
        slug: slugify(newName.trim()),
        capabilities: [],
      });
      toast.success(t('permissionSets.created', 'Permission set created'));
      setNewName('');
      setShowCreate(false);
      void fetchData();
    } catch (err) {
      toastApiError(err, t('permissionSets.failedCreate', 'Failed to create permission set'));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (set: PermissionSet) => {
    if (!confirm(t('permissionSets.confirmDelete', 'Delete permission set "{{name}}"? This cannot be undone.', { name: set.name }))) return;
    try {
      await permissionSetsApi.remove(set.id);
      toast.success(t('permissionSets.deleted', 'Permission set deleted'));
      void fetchData();
    } catch (err) {
      toastApiError(err, t('permissionSets.failedDelete', 'Failed to delete permission set'));
    }
  };

  const handleRename = async (set: PermissionSet) => {
    if (!renameValue.trim() || renameValue.trim() === set.name) {
      setRenamingId(null);
      return;
    }
    try {
      await permissionSetsApi.update(set.id, { name: renameValue.trim() });
      toast.success(t('permissionSets.renamed', 'Permission set renamed'));
      setRenamingId(null);
      void fetchData();
    } catch (err) {
      toastApiError(err, t('permissionSets.failedRename', 'Failed to rename permission set'));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-text-muted text-sm">
        {t('permissionSets.loading', 'Loading permission sets...')}
      </div>
    );
  }

  const combinedNote = t(
    'permissionSets.combinedNote',
    'Some pages combine capabilities: vendor rules need {{vendorRules}}; import / export needs {{importExport}}.',
    {
      vendorRules: COMBINED_CAPABILITY_REQUIREMENTS.vendorRules.map(shortName).join(' + '),
      importExport: COMBINED_CAPABILITY_REQUIREMENTS.importExport.map(shortName).join(' + '),
    },
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold text-text-primary">
          {t('users.permissionSets', 'Permission Sets')}
        </h2>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus size={14} className="mr-1" />
          {t('common.new', 'New')}
        </Button>
      </div>
      <p className="mb-1 text-xs text-text-muted">
        {t(
          'permissionSets.hint',
          'A permission set is a workspace role: it decides what members holding it may do in the workspace. Teams decide which groups and sites. Admin always holds every capability.',
        )}
      </p>
      <p className="mb-4 flex items-start gap-1.5 text-xs text-text-muted">
        <Info size={13} className="mt-0.5 shrink-0" />
        <span>
          {t('permissionSets.teamWriteHint', 'Editing sites and devices comes from team rw permissions, whatever the role.')}
          {' '}
          {t('permissionSets.impliedHint', 'A capability included in a ticked one is shown ticked and locked.')}
        </span>
      </p>

      {/* Create form */}
      {showCreate && (
        <div className="mb-4 rounded-xl bg-bg-secondary p-4 shadow-[var(--shadow-card)]">
          <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
            {t('permissionSets.newTitle', 'New Permission Set')}
          </h3>
          <div className="flex items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('permissionSets.namePlaceholder', 'Set name (e.g. N1 Support)')}
              maxLength={64}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
              autoFocus
            />
            <Button size="sm" onClick={() => void handleCreate()} disabled={creating || !newName.trim()}>
              {creating ? '...' : t('permissionSets.create', 'Create')}
            </Button>
            <button
              onClick={() => { setShowCreate(false); setNewName(''); }}
              className="p-1 text-text-muted hover:text-text-primary"
              aria-label={t('common.cancel', 'Cancel')}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Matrix table */}
      {capabilities.length === 0 ? (
        <div className="text-sm text-text-muted py-8 text-center">
          {t('permissionSets.noCapabilities', 'No capabilities defined.')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl bg-bg-secondary shadow-[var(--shadow-card)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-secondary border-b border-border">
                <th className="text-left px-3 py-2.5 text-text-secondary font-medium whitespace-nowrap">
                  {t('permissionSets.capability', 'Capability')}
                </th>
                {sets.map((set) => (
                  <th key={set.id} className="px-3 py-2.5 text-center min-w-[100px] align-top">
                    <div className="flex items-center justify-center gap-1">
                      {renamingId === set.id ? (
                        <input
                          className="bg-bg-tertiary border border-border rounded px-1.5 py-0.5 text-xs text-text-primary w-20 text-center"
                          value={renameValue}
                          maxLength={64}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => void handleRename(set)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleRename(set);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          autoFocus
                        />
                      ) : (
                        <>
                          <span className="text-text-primary font-medium text-xs" title={set.slug}>
                            {set.name}
                          </span>
                          {set.isDefault && (
                            <span title={t('permissionSets.defaultSet', 'Default set')}><Shield size={11} className="text-accent shrink-0" /></span>
                          )}
                        </>
                      )}
                    </div>
                    {set.memberCount !== undefined && (
                      <div className="mt-0.5 text-[10px] font-normal text-text-muted tabular-nums">
                        {t('permissionSets.memberCount', { count: set.memberCount, defaultValue: '{{count}} members' })}
                      </div>
                    )}
                    {renamingId !== set.id && (
                      <div className="flex items-center justify-center gap-0.5 mt-1">
                        <button
                          onClick={() => { setRenamingId(set.id); setRenameValue(set.name); }}
                          className="p-0.5 text-text-muted hover:text-text-primary opacity-60 hover:opacity-100"
                          title={t('permissionSets.rename', 'Rename')}
                          aria-label={t('permissionSets.rename', 'Rename')}
                        >
                          <Pencil size={10} />
                        </button>
                        {!set.isDefault && (
                          <button
                            onClick={() => void handleDelete(set)}
                            className="p-0.5 text-text-muted hover:text-status-down opacity-60 hover:opacity-100"
                            title={t('common.delete', 'Delete')}
                            aria-label={t('common.delete', 'Delete')}
                          >
                            <Trash2 size={10} />
                          </button>
                        )}
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowGroups.map((group) => (
                <Fragment key={group.id}>
                  <tr className="border-b border-border bg-bg-tertiary/60">
                    <th
                      colSpan={sets.length + 1}
                      scope="colgroup"
                      className="px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary"
                    >
                      {group.label}
                    </th>
                  </tr>
                  {group.caps.map((cap) => {
                    const description = capabilityDescription(cap);
                    return (
                      <tr
                        key={cap.key}
                        className="border-b border-border last:border-b-0 bg-bg-primary hover:bg-bg-hover transition-colors"
                      >
                        <td className="px-3 py-2 text-text-primary text-xs" title={cap.key}>
                          <div className="flex items-center gap-1.5 font-medium">
                            {capabilityLabel(cap)}
                            {cap.baseline && <Lock size={10} className="shrink-0 text-text-muted" />}
                          </div>
                          {description && (
                            <div className="mt-0.5 max-w-md text-[11px] font-normal text-text-muted">{description}</div>
                          )}
                        </td>
                        {sets.map((set) => {
                          const adminLocked = set.slug === TENANT_ADMIN_ROLE;
                          const stored = set.capabilities.includes(cap.key);
                          // Included in another ticked capability, whether or not it is
                          // also stored (sets saved before the split may store both).
                          const implied = impliedCapabilities(set.capabilities).includes(cap.key);
                          const locked = adminLocked || !!cap.baseline || implied;
                          const checked = locked || stored;
                          const title = adminLocked
                            ? t('permissionSets.adminLocked', 'Tenant admins always hold every capability')
                            : cap.baseline
                              ? t('permissionSets.baselineLocked', 'Included: reading follows team permissions')
                              : implied
                                ? t('permissionSets.impliedLocked', 'Included in a broader capability ticked for this set')
                                : undefined;
                          return (
                            <td key={set.id} className="px-3 py-2 text-center">
                              <button
                                type="button"
                                onClick={() => void toggleCapability(set, cap.key)}
                                disabled={locked}
                                title={title}
                                role="checkbox"
                                aria-checked={checked}
                                aria-label={`${capabilityLabel(cap)} — ${set.name}`}
                                className={`w-5 h-5 rounded border inline-flex items-center justify-center transition-colors ${
                                  checked
                                    ? 'bg-accent border-accent text-white'
                                    : 'border-border bg-bg-tertiary hover:border-text-muted'
                                } ${locked ? 'opacity-60 cursor-not-allowed' : ''}`}
                              >
                                {checked && <Check size={12} strokeWidth={3} />}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {capabilities.length > 0 && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-text-muted">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>{combinedNote}</span>
        </p>
      )}

      {sets.length === 0 && capabilities.length > 0 && (
        <div className="text-sm text-text-muted py-8 text-center">
          {t('permissionSets.noSets', 'No permission sets defined. Click "New" to create one.')}
        </div>
      )}
    </div>
  );
}
