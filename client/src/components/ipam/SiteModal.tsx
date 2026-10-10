import { useEffect, useMemo, useState } from 'react';
import { MapPin, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { Site, MonitorGroup, GroupTreeNode, PermissionLevel } from '@oblimap/shared';
import { siteApi } from '@/api/site.api';
import { groupsApi } from '@/api/groups.api';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useAnonymize } from '@/utils/anonymize';
import { useAuthStore, useFullAccess } from '@/store/authStore';
import { useGroupStore } from '@/store/groupStore';
import { toastApiError } from '@/utils/apiError';

/** 'rw' team permission on a group or any of its ancestors (sub-groups inherit it). */
export function canWriteGroupChain(
  permissions: Record<string, PermissionLevel> | undefined,
  groupId: number | null,
  groupsById: Map<number, MonitorGroup>,
): boolean {
  if (!permissions) return false;
  const seen = new Set<number>();
  let current = groupId;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (permissions[`group:${current}`] === 'rw') return true;
    current = groupsById.get(current)?.parentId ?? null;
  }
  return false;
}

/** Group ids in tree order (depth-first) with their depth, for an indented option list. */
function treeOrder(tree: GroupTreeNode[]): Map<number, { index: number; depth: number }> {
  const order = new Map<number, { index: number; depth: number }>();
  const walk = (nodes: GroupTreeNode[], depth: number) => {
    for (const node of nodes) {
      order.set(node.id, { index: order.size, depth });
      walk(node.children ?? [], depth + 1);
    }
  };
  walk(tree, 0);
  return order;
}

export interface SiteModalProps {
  /** The site to edit; absent (or null) = create a new site. */
  site?: Site | null;
  onClose: () => void;
  /** Called after a successful save (the modal does not close itself). */
  onSaved: (site: Site) => void;
  /**
   * Groups of the tenant (GET /groups). Optional: the modal loads them
   * itself when the caller has none at hand.
   */
  groups?: MonitorGroup[];
  /** Preselected group of a new site (e.g. the page's group filter). */
  defaultGroupId?: number | null;
}

/**
 * Create / edit a site (shared by the sites list and the site page).
 *
 * Group choices follow the server rules: full access (platform admin or
 * admin of the current tenant) may use every group or none; everyone else
 * only the groups they can write (plus the site's current group), and "no
 * group" only for a site that already has none (the server refuses to move
 * a grouped site to the top level, and a new site outside any group).
 */
export function SiteModal({ site, onClose, onSaved, groups: groupsProp, defaultGroupId }: SiteModalProps) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const fullAccess = useFullAccess();
  const permissions = useAuthStore((s) => s.permissions?.permissions);
  const tree = useGroupStore((s) => s.tree);
  const isEdit = !!site;

  // The sidebar (which normally loads the tree) is not mounted on phones / tablets.
  useEffect(() => {
    if (useGroupStore.getState().tree.length === 0) void useGroupStore.getState().fetchTree();
  }, []);

  const [loadedGroups, setLoadedGroups] = useState<MonitorGroup[] | null>(null);
  const [groupsLoading, setGroupsLoading] = useState(groupsProp === undefined);

  useEffect(() => {
    if (groupsProp !== undefined) return;
    let cancelled = false;
    setGroupsLoading(true);
    groupsApi.list()
      .then((list) => { if (!cancelled) setLoadedGroups(list); })
      .catch(() => { if (!cancelled) setLoadedGroups([]); })
      .finally(() => { if (!cancelled) setGroupsLoading(false); });
    return () => { cancelled = true; };
  }, [groupsProp]);

  const allGroups = groupsProp ?? loadedGroups ?? [];

  /** Groups the site may be created in or moved to, in tree order. */
  const targetGroups = useMemo(() => {
    const byId = new Map(allGroups.map((g) => [g.id, g]));
    const allowed = fullAccess
      ? allGroups
      : allGroups.filter((g) => g.id === site?.groupId || canWriteGroupChain(permissions, g.id, byId));
    const order = treeOrder(tree);
    return allowed
      .map((g) => ({ group: g, pos: order.get(g.id) }))
      .sort((a, b) => {
        if (a.pos && b.pos) return a.pos.index - b.pos.index;
        if (a.pos) return -1;
        if (b.pos) return 1;
        return a.group.name.localeCompare(b.group.name);
      })
      .map(({ group, pos }) => ({ group, depth: pos?.depth ?? 0 }));
  }, [allGroups, fullAccess, permissions, site?.groupId, tree]);

  const allowNoGroup = fullAccess || (isEdit && site.groupId === null);
  const groupRequired = !allowNoGroup;

  const [name, setName] = useState(site?.name ?? '');
  const [description, setDescription] = useState(site?.description ?? '');
  const [groupId, setGroupId] = useState<string>(
    site ? (site.groupId ? String(site.groupId) : '') : (defaultGroupId ? String(defaultGroupId) : ''),
  );
  const [saving, setSaving] = useState(false);

  // A required group: preselect the first allowed one once the list is known
  // (and drop a preselection the user may not use).
  useEffect(() => {
    if (groupsLoading) return;
    if (groupId && targetGroups.some((g) => String(g.group.id) === groupId)) return;
    if (groupId && isEdit && site.groupId !== null && String(site.groupId) === groupId) return;
    if (groupRequired) setGroupId(targetGroups.length > 0 ? String(targetGroups[0].group.id) : '');
    else if (groupId && !isEdit) setGroupId('');
  }, [groupsLoading, targetGroups, groupRequired, groupId, isEdit, site]);

  const canSubmit = !saving && name.trim() !== '' && !(groupRequired && !groupId);

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!name.trim()) return;
    if (groupRequired && !groupId) {
      toast.error(t('sites.groupRequired', 'Choose a group you can write to for this site.'));
      return;
    }
    setSaving(true);
    try {
      const data = {
        name: name.trim(),
        description: description.trim() || null,
        groupId: groupId ? Number(groupId) : null,
      };
      let saved: Site;
      if (site) {
        saved = (await siteApi.update(site.id, data)).site;
        toast.success(t('sites.updated', 'Site updated'));
      } else {
        saved = (await siteApi.create(data)).site;
        toast.success(t('sites.created', 'Site created'));
      }
      onSaved(saved);
    } catch (err) {
      toastApiError(err, isEdit
        ? t('sites.failedUpdate', 'Failed to update site')
        : t('sites.failedCreate', 'Failed to create site'));
    } finally {
      setSaving(false);
    }
  }

  const inputCls =
    'w-full bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent';

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!saving}
      size="sm"
      phoneLayout="sheet"
      icon={<MapPin size={18} className="text-accent shrink-0" />}
      title={isEdit ? t('sites.editSite', 'Edit Site') : t('sites.newSite', 'New Site')}
      footer={(
        <>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button type="submit" form="site-modal-form" size="sm" disabled={!canSubmit} className="gap-1.5">
            {saving && <Loader2 size={14} className="animate-spin" />}
            {isEdit ? t('common.save', 'Save') : t('common.create', 'Create')}
          </Button>
        </>
      )}
    >
      <form id="site-modal-form" onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div>
          <label htmlFor="site-modal-name" className="block text-sm text-text-secondary mb-1.5">
            {t('sites.form.name', 'Name')} <span className="text-red-400">*</span>
          </label>
          <input
            id="site-modal-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('sites.form.namePlaceholder', 'e.g. HQ Office, Warehouse A')}
            autoFocus
            maxLength={255}
            className={inputCls}
          />
        </div>

        <div>
          <label htmlFor="site-modal-description" className="block text-sm text-text-secondary mb-1.5">
            {t('sites.form.description', 'Description')}
          </label>
          <textarea
            id="site-modal-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('sites.form.descPlaceholder', 'Optional description')}
            rows={2}
            className={`${inputCls} resize-none`}
          />
        </div>

        {(groupsLoading || targetGroups.length > 0 || groupRequired) && (
          <div>
            <label htmlFor="site-modal-group" className="block text-sm text-text-secondary mb-1.5">
              {t('sites.form.group', 'Group')}
              {groupRequired && <span className="text-red-400"> *</span>}
            </label>
            {groupsLoading ? (
              <div className="flex items-center gap-2 text-sm text-text-muted py-2">
                <Loader2 size={14} className="animate-spin" />
                {t('common.loading', 'Loading…')}
              </div>
            ) : (
              <select
                id="site-modal-group"
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                className={inputCls}
              >
                {allowNoGroup && <option value="">{t('sites.form.groupNone', '— No group —')}</option>}
                {targetGroups.map(({ group, depth }) => (
                  <option key={group.id} value={group.id}>
                    {'\u00A0\u00A0\u00A0\u00A0'.repeat(depth)}{depth > 0 ? '└ ' : ''}{anonymize(group.name, 'hostname')}
                  </option>
                ))}
              </select>
            )}
            {!groupsLoading && groupRequired && targetGroups.length === 0 && (
              <p className="mt-1 text-xs text-text-muted">
                {t('sites.noWritableGroup', 'You have write permission on no group: ask an administrator.')}
              </p>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
