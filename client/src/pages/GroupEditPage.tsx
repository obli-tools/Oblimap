import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { ChevronUp, ChevronDown, FolderTree, Info, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MonitorGroup, GroupTreeNode } from '@oblimap/shared';
import { groupsApi } from '@/api/groups.api';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore, useFullAccess, useTenantCapability } from '@/store/authStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { GroupPicker } from '@/components/common/GroupPicker';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { NotificationBindingsPanel } from '@/components/notifications/NotificationBindingsPanel';
import { NotificationBindingsGuard } from '@/components/notifications/NotificationBindingsGuard';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { LoadError } from '@/components/common/LoadError';
import { useGroupSiteActions } from '@/components/devices/GroupSitePanel';
import { VendorRulesPanel } from '@/components/ipam/VendorRulesPanel';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Checkbox } from '@/components/ui/Checkbox';
import { cn } from '@/utils/cn';
import { useAnonymize } from '@/utils/anonymize';
import { parseRouteId } from '@/utils/routeId';
import { toastApiError } from '@/utils/apiError';
import toast from 'react-hot-toast';

function findNodeById(nodes: GroupTreeNode[], id: number): GroupTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNodeById(node.children, id);
    if (found) return found;
  }
  return null;
}

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

type GroupLoadError = 'forbidden' | 'notFound' | 'error';

/** A section card (borderless: depth from the background). */
const CARD = 'rounded-xl bg-bg-secondary p-5 mb-6';

/** Sections reachable with ?section= (deep links, e.g. from the group page or the business-hours editor). */
type Section = 'settings' | 'notifications' | 'vendorRules';
const SECTION_IDS: readonly Section[] = ['settings', 'notifications', 'vendorRules'];

interface GroupFormData {
  name: string;
  description: string;
  isGeneral: boolean;
}

function formOf(g: MonitorGroup | null): GroupFormData {
  return {
    name: g?.name ?? '',
    description: g?.description ?? '',
    isGeneral: g?.isGeneral ?? false,
  };
}

/**
 * The single group-settings page (Obliance GroupEditPage): name / description,
 * notification bindings, inheritable settings, vendor rules and position.
 * Each section is shown only to the users the server lets use it:
 *  - name / description / position (parent): write on the group;
 *  - the general flag: full access;
 *  - sibling order: 'groups.manage';
 *  - settings: 'settings'; notification bindings: 'notifications.manage';
 *  - vendor rules: readable by every member, editable with
 *    'sites.manage' + 'deviceChecks.manage'.
 */
export function GroupEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const { fetchGroups, fetchTree, tree } = useGroupStore();
  const [searchParams] = useSearchParams();

  const groupId = parseRouteId(id);

  // Capabilities and team permissions (re-evaluated when the permissions or
  // the tree are reloaded).
  useAuthStore((s) => s.permissions);
  useGroupStore((s) => s.tree);
  const { canWriteGroup } = useAuthStore.getState();
  const fullAccess = useFullAccess();
  const canManageSettings = useTenantCapability('settings');
  const canManageNotifications = useTenantCapability('notifications.manage');
  const canReorder = useTenantCapability('groups.manage');
  const canManageSites = useTenantCapability('sites.manage');
  const canManageDeviceChecks = useTenantCapability('deviceChecks.manage');
  const canEditVendorRules = canManageSites && canManageDeviceChecks;
  const canWrite = groupId !== null && canWriteGroup(groupId);
  // Moving a group to the top level: full access only (the move handler
  // refuses everyone else, can_create teams included).
  const mayMoveToRoot = fullAccess;

  const [group, setGroup] = useState<MonitorGroup | null>(
    groupId !== null ? useGroupStore.getState().getGroup(groupId) ?? null : null,
  );
  const [loading, setLoading] = useState(groupId !== null && !group);
  const [loadError, setLoadError] = useState<GroupLoadError | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<GroupFormData>(() => formOf(group));
  // Delete (group write; danger confirmation; 409 group_not_empty for writers
  // without full access).
  const { deleteGroup } = useGroupSiteActions();

  // Position state
  // undefined = no pending change; null/number = new parent selected but not yet applied
  const [pendingParentId, setPendingParentId] = useState<number | null | undefined>(undefined);
  const [movingSaving, setMovingSaving] = useState(false);
  const [siblingsOrder, setSiblingsOrder] = useState<GroupTreeNode[]>([]);
  const [reorderDirty, setReorderDirty] = useState(false);
  const [reorderSaving, setReorderSaving] = useState(false);

  const getSiblings = useCallback((): GroupTreeNode[] => {
    if (!group) return [];
    const parentId = group.parentId;
    if (parentId === null) return tree;
    const parentNode = findNodeById(tree, parentId);
    return parentNode?.children ?? [];
  }, [group, tree]);

  // Sync sibling list when group or tree changes
  useEffect(() => {
    setSiblingsOrder(getSiblings());
    setReorderDirty(false);
  }, [getSiblings]);

  // The group of the route (another id: nothing of the previous group stays).
  useEffect(() => {
    let alive = true;
    setLoadError(null);
    setPendingParentId(undefined);
    if (groupId === null) {
      setGroup(null);
      setLoadError('notFound');
      setLoading(false);
      return;
    }
    const cached = useGroupStore.getState().getGroup(groupId);
    if (cached) {
      setGroup(cached);
      setForm(formOf(cached));
      setLoading(false);
      return;
    }
    setGroup(null);
    setLoading(true);
    groupsApi.getById(groupId)
      .then((g) => {
        if (!alive) return;
        setGroup(g);
        setForm(formOf(g));
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const status = httpStatus(err);
        if (status === 403) setLoadError('forbidden');
        else if (status === 404 || status === 400) setLoadError('notFound');
        else setLoadError('error');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [groupId, retryKey]);

  // ?section=settings|notifications|vendorRules: scroll to that section once rendered.
  const requestedSection = searchParams.get('section');
  useEffect(() => {
    if (!group || !requestedSection || !(SECTION_IDS as readonly string[]).includes(requestedSection)) return;
    const timer = setTimeout(() => {
      document.getElementById(`group-section-${requestedSection}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
    return () => clearTimeout(timer);
  }, [group, requestedSection]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // The page serves group writers and the holders of a capability one of its
  // sections needs; everyone else gets the not-found / denied state.
  const hasAnySection = canWrite || canManageSettings || canManageNotifications || canEditVendorRules || canReorder;

  if (!group && loadError === 'error') {
    return (
      <PageContainer>
        <LoadError
          message={t('groups.failedLoad', 'Failed to load group')}
          onRetry={() => setRetryKey((k) => k + 1)}
        />
      </PageContainer>
    );
  }

  if (!group || groupId === null || !hasAnySection) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="text-text-muted">
          {t('groups.notFoundOrDenied', 'Group not found or access denied')}
        </p>
        <Link to="/" className="mt-4">
          <Button variant="secondary">{t('groups.backToDashboard', 'Back to the dashboard')}</Button>
        </Link>
      </div>
    );
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await groupsApi.update(groupId, {
        name: form.name,
        description: form.description || null,
        // The general flag: full access only (the server refuses it otherwise).
        ...(fullAccess ? { isGeneral: form.isGeneral } : {}),
      });
      toast.success(t('groups.updated'));
      fetchGroups();
      fetchTree();
      navigate(`/group/${groupId}`);
    } catch (err) {
      toastApiError(err, t('groups.failedUpdate'));
    } finally {
      setSaving(false);
    }
  };

  const handleMove = async () => {
    if (pendingParentId === undefined) return;
    if (pendingParentId === null && !mayMoveToRoot) {
      toast.error(t('groups.parentRequired', 'Choose a parent group you can write to.'));
      return;
    }
    if (pendingParentId !== null && !canWriteGroup(pendingParentId)) {
      toast.error(t('groups.targetNotWritable', 'You cannot move a group under this one.'));
      return;
    }
    setMovingSaving(true);
    try {
      await groupsApi.move(groupId, pendingParentId);
      toast.success(t('groups.moved'));
      setGroup((g) => g ? { ...g, parentId: pendingParentId } : g);
      setPendingParentId(undefined);
      await fetchGroups();
      await fetchTree();
      // A move to the root may grant the creator's teams rw.
      void useAuthStore.getState().refreshPermissions();
    } catch (err) {
      toastApiError(err, t('groups.failedMove'));
    } finally {
      setMovingSaving(false);
    }
  };

  const moveSibling = (index: number, direction: -1 | 1) => {
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= siblingsOrder.length) return;
    const newOrder = [...siblingsOrder];
    [newOrder[index], newOrder[swapIndex]] = [newOrder[swapIndex], newOrder[index]];
    setSiblingsOrder(newOrder);
    setReorderDirty(true);
  };

  const handleReorder = async () => {
    setReorderSaving(true);
    try {
      await groupsApi.reorder(siblingsOrder.map((n, idx) => ({ id: n.id, sortOrder: idx })));
      toast.success(t('groups.orderSaved'));
      await fetchTree();
      setReorderDirty(false);
    } catch (err) {
      toastApiError(err, t('groups.failedOrder'));
    } finally {
      setReorderSaving(false);
    }
  };

  const effectiveParentId = pendingParentId !== undefined ? pendingParentId : group.parentId;
  const showPosition = canWrite || (canReorder && siblingsOrder.length > 1);

  const handleDelete = async () => {
    const parentId = group.parentId ?? null;
    if (await deleteGroup(groupId)) {
      navigate(parentId !== null ? `/group/${parentId}` : '/', { replace: true });
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title={t('groups.edit', 'Edit Group')}
        subtitle={anonymize(group.name, 'hostname')}
        icon={<FolderTree className="h-5 w-5" />}
        backTo={`/group/${groupId}`}
        backLabel={t('groups.backToGroup', 'Back to {{name}}', { name: anonymize(group.name, 'hostname') })}
      />
      {/* General (group writers) */}
      {canWrite && (
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">{t('common.name')}</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label={t('groups.form.name')}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('groups.form.namePlaceholder')}
              required
            />
            <Input
              label={t('groups.form.description')}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder={t('groups.form.descriptionPlaceholder')}
            />
            {/* The general flag: full access only (the server refuses it otherwise). */}
            {fullAccess && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="is-general"
                  checked={form.isGeneral}
                  onCheckedChange={(v) => setForm({ ...form, isGeneral: v })}
                />
                <label htmlFor="is-general" className="text-sm text-text-secondary">
                  {t('groups.form.isGeneral')}
                </label>
              </div>
            )}
            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" loading={saving}>{t('groups.save')}</Button>
              <Button type="button" variant="secondary" onClick={() => navigate(`/group/${groupId}`)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Notification Channels ('notifications.manage') */}
      {canManageNotifications && (
        <div id="group-section-notifications" className="mb-6 scroll-mt-4">
          <NotificationBindingsGuard scope="group" scopeId={groupId}>
            <NotificationBindingsPanel
              scope="group"
              scopeId={groupId}
              title={t('groups.sectionNotifications', 'Notification Channels')}
            />
          </NotificationBindingsGuard>
        </div>
      )}

      {/* Inheritable settings ('settings') */}
      {canManageSettings && (
        <div id="group-section-settings" className="mb-6 space-y-4 scroll-mt-4">
          <div className="rounded-xl bg-bg-secondary p-4 text-sm text-text-muted flex items-start gap-3">
            <Info size={16} className="shrink-0 mt-0.5 text-accent" />
            {t('groups.detail.settingsInfo')}
          </div>
          <SettingsPanel
            scope="group"
            scopeId={groupId}
            title={t('groups.sectionSettings', 'Settings')}
          />
        </div>
      )}

      {/* Vendor → Device Type Rules (read by all, edited with sites.manage + deviceChecks.manage) */}
      <div id="group-section-vendorRules" className="mb-6 scroll-mt-4">
        <VendorRulesPanel groupId={groupId} canEdit={canEditVendorRules} />
      </div>

      {/* Position: parent (group write), sibling order (groups.manage) */}
      {showPosition && (
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">
            {t('groups.position', 'Position')}
          </h2>

          {/* Parent group */}
          {canWrite && (
            <div className="mb-5">
              <label className="block text-sm font-medium text-text-secondary mb-1">{t('groups.form.parent')}</label>
              <GroupPicker
                value={effectiveParentId}
                onChange={(pid) => setPendingParentId(pid === group.parentId ? undefined : pid)}
                tree={tree}
                placeholder={mayMoveToRoot
                  ? t('groups.form.parentNone')
                  : t('groups.form.parentRequired', 'Choose a parent group')}
                excludeId={groupId}
                kindFilter={group.kind ?? undefined}
                allowNone={mayMoveToRoot}
              />
              {pendingParentId !== undefined && (
                <div className="flex items-center gap-2 mt-2">
                  <Button size="sm" onClick={handleMove} loading={movingSaving}>
                    {t('groups.applyMove')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setPendingParentId(undefined)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Sibling order */}
          {canReorder && siblingsOrder.length > 1 && (
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-2">
                {t('groups.form.sortOrder')}
              </label>
              <div className="rounded-lg bg-bg-tertiary/50 overflow-hidden divide-y divide-border/50">
                {siblingsOrder.map((sibling, idx) => (
                  <div
                    key={sibling.id}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 text-sm',
                      sibling.id === groupId
                        ? 'bg-accent/5 text-text-primary font-medium'
                        : 'text-text-secondary',
                    )}
                  >
                    <span className="w-5 shrink-0 text-right text-xs text-text-muted">{idx + 1}</span>
                    <span className="flex-1 truncate">{anonymize(sibling.name, 'hostname')}</span>
                    {sibling.id === groupId && (
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => moveSibling(idx, -1)}
                          disabled={idx === 0}
                          className="rounded p-0.5 text-text-muted hover:text-text-primary disabled:opacity-30"
                          title={t('groups.form.moveUp')}
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveSibling(idx, 1)}
                          disabled={idx === siblingsOrder.length - 1}
                          className="rounded p-0.5 text-text-muted hover:text-text-primary disabled:opacity-30"
                          title={t('groups.form.moveDown')}
                        >
                          <ChevronDown size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {reorderDirty && (
                <div className="flex items-center gap-2 mt-2">
                  <Button size="sm" onClick={handleReorder} loading={reorderSaving}>
                    {t('groups.saveOrder')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => { setSiblingsOrder(getSiblings()); setReorderDirty(false); }}
                  >
                    {t('common.reset')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Delete (group writers): sub-groups and sites move to the parent */}
      {canWrite && (
        <div className={cn(CARD, 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between')}>
          <div>
            <h2 className="text-sm font-semibold text-red-400 uppercase tracking-wide mb-1">
              {t('groups.dangerZone', 'Delete this group')}
            </h2>
            <p className="text-sm text-text-muted">
              {t('groups.deleteHint', 'Its sub-groups and sites move to the parent group.')}
            </p>
          </div>
          <Button variant="danger" size="sm" onClick={() => { void handleDelete(); }} className="shrink-0">
            <Trash2 size={14} className="mr-1.5" />
            {t('groups.deleteTitle', 'Delete group')}
          </Button>
        </div>
      )}
    </PageContainer>
  );
}
