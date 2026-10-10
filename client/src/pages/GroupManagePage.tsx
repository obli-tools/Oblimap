import { useState, type FormEvent } from 'react';
import { Plus, FolderTree } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { groupsApi } from '@/api/groups.api';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore, useFullAccess } from '@/store/authStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { GroupPicker } from '@/components/common/GroupPicker';
import { PageContainer } from '@/components/common/PageContainer';
import { Checkbox } from '@/components/ui/Checkbox';
import { GroupSitePanel } from '@/components/devices/GroupSitePanel';
import toast from 'react-hot-toast';
import { toastApiError } from '@/utils/apiError';

interface GroupFormData {
  name: string;
  description: string;
  parentId: number | null;
  isGeneral: boolean;
}

const emptyForm: GroupFormData = {
  name: '',
  description: '',
  parentId: null,
  isGeneral: false,
};

/**
 * Group management (/groups): the shared groups → sites panel (inline
 * create / rename / reparent / reorder, site moves, delete) full width, plus
 * the full create form (description, parent picker, general flag). Group
 * settings, notifications and vendor rules live on /group/:id/edit.
 */
export function GroupManagePage() {
  const { fetchGroups, fetchTree, tree } = useGroupStore();
  const { t } = useTranslation();
  const navigate = useNavigate();
  // What the server allows (the controls it would refuse are hidden):
  //  - create: canCreate (full access, a can_create team, groups.manage);
  //    below a group: write on it; top-level: full access or a can_create
  //    team (canCreateRootGroup);
  //  - the general flag: full access only.
  // Edit / move / reorder / delete are in the panel, with the same rules.
  const fullAccess = useFullAccess();
  useAuthStore((s) => s.permissions); // re-render when the permissions are reloaded
  const { canCreate, canCreateRootGroup, canWriteGroup } = useAuthStore.getState();
  const mayCreate = canCreate();
  const mayCreateRoot = canCreateRootGroup();
  // "No group" (top level) in the create form's parent picker: full access or
  // a can_create team only (the server refuses the others).
  const mayUseRoot = fullAccess || mayCreateRoot;
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<GroupFormData>(emptyForm);
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setForm(emptyForm);
    setShowForm(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.parentId === null && !mayCreateRoot) {
      toast.error(t('groups.parentRequired', 'Choose a parent group you can write to.'));
      return;
    }
    if (form.parentId !== null && !canWriteGroup(form.parentId)) {
      toast.error(t('groups.parentNotWritable', 'You cannot create a group under this parent.'));
      return;
    }
    setSaving(true);
    try {
      await groupsApi.create({
        name: form.name,
        description: form.description || null,
        parentId: form.parentId,
        ...(fullAccess ? { isGeneral: form.isGeneral } : {}),
        kind: 'monitor',
      });
      toast.success(t('groups.created', 'Group created'));
      setShowForm(false);
      setForm(emptyForm);
      fetchGroups();
      fetchTree();
      // A new group (or its team grant) is not in the permission map yet.
      void useAuthStore.getState().refreshPermissions();
    } catch (err) {
      toastApiError(err, t('groups.failedCreate', 'Failed to create group'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageContainer
      title={t('nav.groups', 'Groups')}
      icon={<FolderTree className="h-5 w-5" />}
      actions={mayCreate ? (
        <Button size="sm" onClick={openCreate}>
          <Plus size={16} className="mr-1.5" />
          {t('groups.new', 'New Group')}
        </Button>
      ) : undefined}
    >
      {/* Create form */}
      {showForm && (
        <div className="mb-6 rounded-xl bg-bg-secondary p-5">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            {t('groups.new', 'New Group')}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label={t('groups.form.name', 'Name')}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('groups.form.namePlaceholder', 'Group name')}
              required
            />
            <Input
              label={t('groups.form.description', 'Description (optional)')}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder={t('groups.form.descriptionPlaceholder', 'Optional description')}
            />
            <div className="space-y-1">
              <label className="block text-sm font-medium text-text-secondary">
                {t('groups.form.parent', 'Parent Group')}
              </label>
              <GroupPicker
                value={form.parentId}
                onChange={(parentId) => setForm({ ...form, parentId })}
                tree={tree}
                placeholder={mayCreateRoot
                  ? t('groups.form.parentNone', 'None (root level)')
                  : t('groups.form.parentRequired', 'Choose a parent group')}
                allowNone={mayUseRoot}
              />
              {!mayCreateRoot && (
                <p className="text-xs text-text-muted">
                  {t('groups.form.parentRequiredHint', 'A top-level group needs a team allowed to create groups: pick a group you can write to.')}
                </p>
              )}
            </div>
            {/* The general flag: full access only (the server refuses it otherwise). */}
            {fullAccess && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="is-general"
                  checked={form.isGeneral}
                  onCheckedChange={(v) => setForm({ ...form, isGeneral: v })}
                />
                <label htmlFor="is-general" className="text-sm text-text-secondary">
                  {t('groups.form.isGeneral', 'General group (visible to all users)')}
                </label>
              </div>
            )}
            <div className="flex items-center gap-3">
              <Button type="submit" loading={saving}>
                {t('common.create', 'Create')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setShowForm(false);
                  setForm(emptyForm);
                }}
              >
                {t('common.cancel', 'Cancel')}
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Groups → sites tree: select opens the group / site page */}
      <GroupSitePanel
        title={t('groups.treeTitle', 'Groups and sites')}
        onSelect={(sel) => {
          if (sel.type === 'group') navigate(`/group/${sel.groupId}`);
          else if (sel.type === 'site') navigate(`/sites/${sel.siteId}`);
        }}
        className="w-full"
      />
      <p className="mt-2 px-1 text-xs text-text-muted">
        {t('groups.treeHint', 'Drag a group to move or reorder it, or a site onto another group. On touch screens, use the row menu (Move to…).')}
      </p>
    </PageContainer>
  );
}
