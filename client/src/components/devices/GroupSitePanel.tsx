import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Check, ChevronRight, Folder, FolderInput, FolderOpen, FolderPlus, GripVertical, Layers,
  MapPin, Pencil, Plus, Search, Settings2, Trash2, X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import type { GroupTreeNode, Site } from '@oblimap/shared';
import { groupsApi } from '@/api/groups.api';
import { siteApi } from '@/api/site.api';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore, useFullAccess, useTenantCapability } from '@/store/authStore';
import { useIpamLiveRefresh } from '@/hooks/useIpamLiveRefresh';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { GroupPicker } from '@/components/common/GroupPicker';
import { cn } from '@/utils/cn';
import { useAnonymize } from '@/utils/anonymize';
import { apiErrorBody, toastApiError } from '@/utils/apiError';

/*
 * Groups → sites tree with inline management (Obliance GroupSidePanel):
 * create, rename, reparent and reorder groups, move sites between groups.
 * Shared by /manage/groups and /devices; the sidebar tree (GroupNode) reuses the
 * site drag helpers below.
 *
 * Every control follows the server's own gates (routes/groups.routes.ts,
 * routes/site.routes.ts, controllers):
 *  - create a sub-group: canCreate (full access, a can_create team or
 *    'groups.manage') and write on the parent; a top-level group: full
 *    access or a can_create team (canCreateRootGroup);
 *  - rename / delete / move a group: write on it; a move also needs write
 *    on the new parent, a move to the top level full access;
 *  - reorder siblings: 'groups.manage';
 *  - move a site: write on the site and on the target group; out of any
 *    group: full access.
 * The server has the last word: its refusal message is shown as is.
 *
 * Drag and drop is native HTML5 (no extra dependency). Touch screens have no
 * HTML5 drag: the row menus carry a "Move to…" picker for the same moves.
 */

// ─── Site drag helpers (shared with the sidebar tree) ───────────────────────

/** dataTransfer type of a dragged site (lowercase: browsers lowercase types). */
export const SITE_DRAG_MIME = 'application/x-oblimap-site';
/** dataTransfer type of a group dragged inside the panel. */
const GROUP_DRAG_MIME = 'application/x-oblimap-group';

export interface DraggedSite {
  id: number;
  name: string;
  groupId: number | null;
}

/** Starts a site drag (call from onDragStart). */
export function setSiteDragData(e: DragEvent, site: DraggedSite): void {
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(SITE_DRAG_MIME, JSON.stringify(site));
  // Some browsers only start a drag with a text payload.
  e.dataTransfer.setData('text/plain', site.name);
}

/** A site is being dragged (readable during dragover, unlike the payload). */
export function hasSiteDragData(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes(SITE_DRAG_MIME);
}

/** The dragged site (on drop), or null. */
export function readSiteDragData(e: DragEvent): DraggedSite | null {
  try {
    const raw = e.dataTransfer.getData(SITE_DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraggedSite>;
    if (typeof parsed.id !== 'number' || !Number.isSafeInteger(parsed.id) || parsed.id <= 0) return null;
    const groupId = typeof parsed.groupId === 'number' ? parsed.groupId : null;
    return { id: parsed.id, name: typeof parsed.name === 'string' ? parsed.name : '', groupId };
  } catch {
    return null;
  }
}

// ─── Tree helpers ───────────────────────────────────────────────────────────

function findNode(nodes: GroupTreeNode[], id: number): GroupTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

/** candidateId is ancestorId itself or one of its descendants. */
function isSelfOrDescendant(nodes: GroupTreeNode[], ancestorId: number, candidateId: number): boolean {
  if (ancestorId === candidateId) return true;
  const ancestor = findNode(nodes, ancestorId);
  return !!ancestor && !!findNode(ancestor.children, candidateId);
}

/** The tree filtered on a search (real names; a matching group keeps its whole subtree). */
function filterTree(nodes: GroupTreeNode[], query: string): GroupTreeNode[] {
  if (!query) return nodes;
  const q = query.toLowerCase();
  const out: GroupTreeNode[] = [];
  for (const node of nodes) {
    if (node.name.toLowerCase().includes(q)) {
      out.push(node);
      continue;
    }
    const children = filterTree(node.children, query);
    const sites = (node.sites ?? []).filter((s) => s.name.toLowerCase().includes(q));
    if (children.length > 0 || sites.length > 0) out.push({ ...node, children, sites });
  }
  return out;
}

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

// ─── Actions shared by the panel, the group pages and the sidebar ───────────

/**
 * Group / site mutations with their permission checks, confirmations and
 * error reporting. Every function resolves true when the change was made.
 */
export function useGroupSiteActions() {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const confirm = useConfirm();
  const fullAccess = useFullAccess();
  const canReorder = useTenantCapability('groups.manage');
  // Re-render when the permissions or the tree are reloaded.
  useAuthStore((s) => s.permissions);
  const tree = useGroupStore((s) => s.tree);
  const { canCreate, canCreateRootGroup, canWriteGroup, canWriteSite } = useAuthStore.getState();

  const refresh = useCallback(() => {
    const store = useGroupStore.getState();
    void store.fetchGroups();
    void store.fetchTree();
    void store.fetchGroupStats();
  }, []);

  const groupLabel = useCallback((groupId: number | null): string => {
    if (groupId === null) return t('groupPanel.topLevel', 'the top level');
    const name = findNode(useGroupStore.getState().tree, groupId)?.name
      ?? useGroupStore.getState().getGroup(groupId)?.name;
    return name ? anonymize(name, 'hostname') : `#${groupId}`;
  }, [anonymize, t]);

  /** A site may be dragged / moved by this user. */
  const canMoveSite = useCallback(
    (siteId: number, groupId: number | null) => canWriteSite(siteId, groupId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWriteSite, tree],
  );

  /** A site may be moved into this group (null: out of any group). */
  const canDropSiteOn = useCallback(
    (targetGroupId: number | null) => (targetGroupId === null ? fullAccess : canWriteGroup(targetGroupId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fullAccess, canWriteGroup, tree],
  );

  /** Moves a site to another group, after a confirmation unless `skipConfirm`. */
  const moveSite = useCallback(async (
    site: DraggedSite,
    targetGroupId: number | null,
    options: { skipConfirm?: boolean } = {},
  ): Promise<boolean> => {
    if (site.groupId === targetGroupId) return false;
    if (!canDropSiteOn(targetGroupId)) {
      toast.error(targetGroupId === null
        ? t('groupPanel.siteRootDenied', 'Only an administrator can take a site out of its group.')
        : t('groupPanel.siteTargetDenied', 'You cannot move a site into this group.'));
      return false;
    }
    if (!options.skipConfirm) {
      const ok = await confirm({
        title: t('groupPanel.moveSiteTitle', 'Move site'),
        message: t('groupPanel.moveSiteConfirm', 'Move the site "{{site}}" to {{group}}?', {
          site: anonymize(site.name, 'hostname'),
          group: targetGroupId === null
            ? t('groupPanel.noGroupTarget', 'no group')
            : `"${groupLabel(targetGroupId)}"`,
        }),
        confirmLabel: t('groupPanel.moveAction', 'Move'),
      });
      if (!ok) return false;
    }
    try {
      await siteApi.update(site.id, { groupId: targetGroupId });
      toast.success(t('groupPanel.siteMoved', 'Site moved'));
      refresh();
      // The site's readers and the user's own level may change.
      void useAuthStore.getState().refreshPermissions();
      return true;
    } catch (err) {
      toastApiError(err, t('groupPanel.siteMoveFailed', 'Failed to move the site'));
      return false;
    }
  }, [anonymize, canDropSiteOn, confirm, groupLabel, refresh, t]);

  /** A group may be moved under `targetParentId` (null: top level). */
  const canMoveGroupTo = useCallback((group: GroupTreeNode, targetParentId: number | null): boolean => {
    if (!canWriteGroup(group.id)) return false;
    if (targetParentId === null) return fullAccess;
    if (isSelfOrDescendant(useGroupStore.getState().tree, group.id, targetParentId)) return false;
    return canWriteGroup(targetParentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWriteGroup, fullAccess, tree]);

  /** Moves a group under another parent (no confirmation: as on /groups). */
  const moveGroup = useCallback(async (group: GroupTreeNode, targetParentId: number | null): Promise<boolean> => {
    if ((group.parentId ?? null) === targetParentId) return false;
    if (!canMoveGroupTo(group, targetParentId)) {
      toast.error(targetParentId === null
        ? t('groups.parentRequired', 'Choose a parent group you can write to.')
        : t('groups.targetNotWritable', 'You cannot move a group under this one.'));
      return false;
    }
    try {
      await groupsApi.move(group.id, targetParentId);
      toast.success(t('groups.moved', 'Group moved'));
      refresh();
      void useAuthStore.getState().refreshPermissions();
      return true;
    } catch (err) {
      toastApiError(err, t('groups.failedMove', 'Failed to move group'));
      return false;
    }
  }, [canMoveGroupTo, refresh, t]);

  /**
   * Places a group among the children of `parentId` before `beforeId` (null:
   * last): a move when the parent changes, then a reorder ('groups.manage').
   */
  const placeGroup = useCallback(async (
    group: GroupTreeNode,
    parentId: number | null,
    beforeId: number | null,
  ): Promise<boolean> => {
    const reparent = (group.parentId ?? null) !== parentId;
    if (!reparent && !canReorder) {
      toast.error(t('groups.reorderNotAllowed', 'You are not allowed to reorder groups.'));
      return false;
    }
    const currentTree = useGroupStore.getState().tree;
    if (reparent) {
      if (!canMoveGroupTo(group, parentId)) {
        toast.error(parentId === null
          ? t('groups.parentRequired', 'Choose a parent group you can write to.')
          : t('groups.targetNotWritable', 'You cannot move a group under this one.'));
        return false;
      }
      try {
        await groupsApi.move(group.id, parentId);
      } catch (err) {
        toastApiError(err, t('groups.failedMove', 'Failed to move group'));
        return false;
      }
      if (!canReorder) {
        toast.success(t('groups.moved', 'Group moved'));
        refresh();
        void useAuthStore.getState().refreshPermissions();
        return true;
      }
    }
    const parentChildren = parentId === null ? currentTree : (findNode(currentTree, parentId)?.children ?? []);
    const siblings = parentChildren.filter((n) => n.id !== group.id);
    let index = beforeId === null ? siblings.length : siblings.findIndex((n) => n.id === beforeId);
    if (index < 0) index = siblings.length;
    const order = [...siblings.slice(0, index), group, ...siblings.slice(index)];
    let ok = true;
    try {
      await groupsApi.reorder(order.map((n, idx) => ({ id: n.id, sortOrder: idx })));
      toast.success(reparent ? t('groups.moved', 'Group moved') : t('groups.reordered', 'Groups reordered'));
    } catch (err) {
      // The move itself may already have succeeded: say so next to the reorder error.
      if (reparent) toast.success(t('groups.moved', 'Group moved'));
      toastApiError(err, t('groups.failedReorder', 'Failed to reorder groups'));
      ok = false;
    }
    refresh();
    if (reparent) void useAuthStore.getState().refreshPermissions();
    // true only when every requested change (move and placement) succeeded.
    return ok;
  }, [canMoveGroupTo, canReorder, refresh, t]);

  /** A sub-group may be created under `parentId` (null: a top-level group). */
  const canCreateUnder = useCallback((parentId: number | null): boolean => {
    if (!canCreate()) return false;
    return parentId === null ? canCreateRootGroup() : canWriteGroup(parentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCreate, canCreateRootGroup, canWriteGroup, tree]);

  const createGroup = useCallback(async (name: string, parentId: number | null): Promise<boolean> => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    try {
      await groupsApi.create({ name: trimmed, description: null, parentId, kind: 'monitor' });
      toast.success(t('groups.created', 'Group created'));
      if (parentId !== null) useGroupStore.getState().expandGroup(parentId);
      refresh();
      // A new group (or its team grant) is not in the permission map yet.
      void useAuthStore.getState().refreshPermissions();
      return true;
    } catch (err) {
      toastApiError(err, t('groups.failedCreate', 'Failed to create group'));
      return false;
    }
  }, [refresh, t]);

  const renameGroup = useCallback(async (groupId: number, name: string): Promise<boolean> => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    try {
      await groupsApi.update(groupId, { name: trimmed });
      toast.success(t('groups.updated', 'Group updated'));
      useGroupStore.getState().updateGroup(groupId, { name: trimmed });
      refresh();
      return true;
    } catch (err) {
      toastApiError(err, t('groups.failedUpdate', 'Failed to update group'));
      return false;
    }
  }, [refresh, t]);

  /**
   * Deletes a group after a danger confirmation naming what moves to its
   * parent (sub-groups and sites, counted from the tree). Writers without full
   * access may only delete an empty group (server 409 group_not_empty).
   */
  const deleteGroup = useCallback(async (groupId: number): Promise<boolean> => {
    const currentTree = useGroupStore.getState().tree;
    const node = findNode(currentTree, groupId);
    const group = node ?? useGroupStore.getState().getGroup(groupId);
    const name = anonymize(group?.name ?? `#${groupId}`, 'hostname');
    const subGroups = node?.children.length ?? 0;
    const sites = node?.sites?.length ?? 0;
    const notEmptyMessage = t('groups.deleteNotEmpty', 'Move or delete its sites and sub-groups first.');
    if (!fullAccess && subGroups + sites > 0) {
      toast.error(notEmptyMessage);
      return false;
    }
    const ok = await confirm({
      title: t('groups.deleteTitle', 'Delete group'),
      message: subGroups + sites > 0
        ? t('groups.deleteConfirmReparent',
          'Delete the group "{{name}}"? Its {{subGroups}} sub-group(s) and {{sites}} site(s) will move to {{parent}}.',
          { name, subGroups, sites, parent: group?.parentId != null ? `"${groupLabel(group.parentId)}"` : groupLabel(null) })
        : t('groups.deleteConfirmEmpty', 'Delete the group "{{name}}"? This cannot be undone.', { name }),
      danger: true,
      confirmLabel: t('common.delete', 'Delete'),
    });
    if (!ok) return false;
    try {
      await groupsApi.delete(groupId);
      toast.success(t('groups.deleted', 'Group deleted'));
      useGroupStore.getState().removeGroup(groupId);
      refresh();
      void useAuthStore.getState().refreshPermissions();
      return true;
    } catch (err) {
      if (httpStatus(err) === 409 && apiErrorBody(err)?.error === 'group_not_empty') {
        toast.error(notEmptyMessage);
      } else {
        toastApiError(err, t('groups.failedDelete', 'Failed to delete group'));
      }
      return false;
    }
  }, [anonymize, confirm, fullAccess, groupLabel, refresh, t]);

  return {
    fullAccess,
    canReorder,
    canWriteGroup,
    canMoveSite,
    canDropSiteOn,
    canMoveGroupTo,
    canCreateUnder,
    moveSite,
    moveGroup,
    placeGroup,
    createGroup,
    renameGroup,
    deleteGroup,
    refresh,
  };
}

// ─── Panel ──────────────────────────────────────────────────────────────────

export type GroupSiteSelection =
  | { type: 'all' }
  | { type: 'group'; groupId: number }
  | { type: 'site'; siteId: number; groupId: number | null };

export interface GroupSitePanelProps {
  selectedGroupId?: number | null;
  selectedSiteId?: number | null;
  onSelect: (sel: GroupSiteSelection) => void;
  /** An "All sites" entry on top (a filter panel, e.g. /devices). */
  showAll?: boolean;
  /** List the sites without a group (default true). */
  showUngrouped?: boolean;
  /** Title of the panel header (default "Groups"). */
  title?: ReactNode;
  className?: string;
}

type DragState =
  | { kind: 'group'; node: GroupTreeNode }
  | { kind: 'site'; site: DraggedSite };

type MoveDialogState =
  | { kind: 'group'; node: GroupTreeNode }
  | { kind: 'site'; site: DraggedSite };

const COLLAPSED_KEY = 'oblimap:groupSitePanelCollapsed';

/** Small inline name form (create / rename): Enter saves, Escape cancels. */
function InlineNameForm({
  initial = '',
  placeholder,
  depth,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  placeholder: string;
  depth: number;
  onSubmit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    const ok = await onSubmit(name);
    setSaving(false);
    if (ok) onCancel();
  };
  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-1 py-1 pr-1"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <input
        autoFocus
        type="text"
        value={name}
        maxLength={255}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 rounded-md bg-bg-tertiary px-2 py-1 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
      />
      <IconButton
        type="submit"
        size="sm"
        variant="primary"
        label={t('common.save', 'Save')}
        icon={<Check size={14} />}
        disabled={saving || !name.trim()}
      />
      <IconButton
        size="sm"
        label={t('common.cancel', 'Cancel')}
        icon={<X size={14} />}
        onClick={onCancel}
      />
    </form>
  );
}

export function GroupSitePanel({
  selectedGroupId = null,
  selectedSiteId = null,
  onSelect,
  showAll = false,
  showUngrouped = true,
  title,
  className,
}: GroupSitePanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { anonymize } = useAnonymize();
  const tree = useGroupStore((s) => s.tree);
  const groupStats = useGroupStore((s) => s.groupStats);
  const actions = useGroupSiteActions();
  const {
    fullAccess, canReorder, canWriteGroup, canMoveSite, canDropSiteOn, canMoveGroupTo, canCreateUnder,
  } = actions;

  const [search, setSearch] = useState('');
  const [collapsedList, setCollapsedList] = usePersistedState<number[]>(COLLAPSED_KEY, []);
  const collapsed = useMemo(() => new Set(Array.isArray(collapsedList) ? collapsedList : []), [collapsedList]);
  const toggleCollapsed = (id: number) => {
    setCollapsedList((prev) => {
      const set = new Set(Array.isArray(prev) ? prev : []);
      if (set.has(id)) set.delete(id); else set.add(id);
      return [...set];
    });
  };
  const expand = (id: number) => {
    setCollapsedList((prev) => (Array.isArray(prev) ? prev.filter((x) => x !== id) : []));
  };

  /** Inline forms: a new group under `parentId` (null: top level), or a rename. */
  const [creatingUnder, setCreatingUnder] = useState<number | null | undefined>(undefined);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [moveDialog, setMoveDialog] = useState<MoveDialogState | null>(null);
  const [moveTarget, setMoveTarget] = useState<number | null>(null);
  const [moveSaving, setMoveSaving] = useState(false);

  // ── Data: the shared group tree (+ stats) and the sites without a group ──
  const [ungrouped, setUngrouped] = useState<Site[]>([]);
  const [ungroupedError, setUngroupedError] = useState(false);
  const ungroupedSeq = useRef(0);
  const loadUngrouped = useCallback(() => {
    if (!showUngrouped) return;
    const seq = ++ungroupedSeq.current;
    siteApi.list({ ungrouped: true })
      .then((res) => {
        if (seq !== ungroupedSeq.current) return;
        setUngrouped(res.sites);
        setUngroupedError(false);
      })
      .catch(() => { if (seq === ungroupedSeq.current) setUngroupedError(true); });
  }, [showUngrouped]);

  const reloadAll = useCallback(() => {
    const store = useGroupStore.getState();
    void store.fetchTree();
    void store.fetchGroupStats();
    loadUngrouped();
  }, [loadUngrouped]);

  useEffect(() => { reloadAll(); }, [reloadAll]);
  // Socket events, socket reconnect and tenant switch.
  useIpamLiveRefresh(reloadAll);

  const visibleTree = useMemo(() => filterTree(tree, search.trim()), [tree, search]);
  const visibleUngrouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? ungrouped.filter((s) => s.name.toLowerCase().includes(q)) : ungrouped;
  }, [ungrouped, search]);
  const isSearching = search.trim().length > 0;

  const mayCreateRoot = canCreateUnder(null);
  // The group-settings page also serves the holders of a capability one of
  // its sections needs (GroupEditPage gates each section).
  const capSettings = useTenantCapability('settings');
  const capNotifications = useTenantCapability('notifications.manage');
  const capSites = useTenantCapability('sites.manage');
  const capDeviceChecks = useTenantCapability('deviceChecks.manage');
  const canOpenSettingsPage = capSettings || capNotifications || (capSites && capDeviceChecks) || canReorder;

  // ── Drag and drop ──

  const endDrag = () => {
    setDrag(null);
    setDropKey(null);
  };

  /** What is being dragged over the panel (a site may come from the sidebar). */
  const dragKind = (e: DragEvent): 'group' | 'site' | null => {
    if (drag) return drag.kind;
    return hasSiteDragData(e) ? 'site' : null;
  };

  /** dragover handler of a drop target: accepts the drop when `allowed`. */
  const overHandler = (key: string, allowed: (kind: 'group' | 'site') => boolean) => (e: DragEvent) => {
    const kind = dragKind(e);
    if (!kind || !allowed(kind)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dropKey !== key) setDropKey(key);
  };

  const leaveHandler = (key: string) => (e: DragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (related && (e.currentTarget as Node).contains(related)) return;
    setDropKey((k) => (k === key ? null : k));
  };

  /** Drop ON a group (null: the "no group" / top-level zone). */
  const canDropOnGroup = (kind: 'group' | 'site', targetId: number | null): boolean => {
    if (kind === 'site') {
      if (drag?.kind === 'site' && drag.site.groupId === targetId) return false;
      return canDropSiteOn(targetId);
    }
    if (drag?.kind !== 'group') return false;
    if ((drag.node.parentId ?? null) === targetId) return false;
    return canMoveGroupTo(drag.node, targetId);
  };

  const dropOnGroup = (targetId: number | null) => async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const current = drag;
    endDrag();
    if (current?.kind === 'group') {
      if (await actions.moveGroup(current.node, targetId) && targetId !== null) expand(targetId);
      return;
    }
    const site = readSiteDragData(e) ?? (current?.kind === 'site' ? current.site : null);
    if (site && await actions.moveSite(site, targetId) && targetId !== null) expand(targetId);
  };

  /** Drop BETWEEN groups: reorder ('groups.manage') and / or reparent. */
  const canDropBetween = (parentId: number | null): boolean => {
    if (drag?.kind !== 'group') return false;
    const reparent = (drag.node.parentId ?? null) !== parentId;
    if (!reparent) return canReorder;
    return canMoveGroupTo(drag.node, parentId);
  };

  const dropBetween = (parentId: number | null, beforeId: number | null) => async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const current = drag;
    endDrag();
    if (current?.kind !== 'group') return;
    if (current.node.id === beforeId) return;
    await actions.placeGroup(current.node, parentId, beforeId);
  };

  const renderDropBetween = (parentId: number | null, beforeId: number | null, depth: number) => {
    if (drag?.kind !== 'group' || !canDropBetween(parentId)) return null;
    const key = `between:${parentId ?? 'root'}:${beforeId ?? 'tail'}`;
    return (
      <div
        key={key}
        onDragOver={overHandler(key, () => canDropBetween(parentId))}
        onDragLeave={leaveHandler(key)}
        onDrop={dropBetween(parentId, beforeId)}
        className="relative h-1.5"
        style={{ marginLeft: `${depth * 16 + 8}px` }}
        aria-hidden
      >
        <div className={cn('absolute inset-x-0 top-0.5 h-0.5 rounded-full', dropKey === key ? 'bg-accent' : 'bg-transparent')} />
      </div>
    );
  };

  // ── Move-to dialog (tap path of the drags) ──

  const openMoveDialog = (state: MoveDialogState) => {
    setMoveDialog(state);
    setMoveTarget(state.kind === 'group' ? (state.node.parentId ?? null) : state.site.groupId);
  };

  const applyMoveDialog = async () => {
    if (!moveDialog) return;
    setMoveSaving(true);
    const ok = moveDialog.kind === 'group'
      ? await actions.moveGroup(moveDialog.node, moveTarget)
      : await actions.moveSite(moveDialog.site, moveTarget, { skipConfirm: true });
    setMoveSaving(false);
    if (ok) setMoveDialog(null);
  };

  // ── Rows ──

  const rowBase = 'group/row flex w-full items-center gap-1 rounded-md pr-1 text-sm transition-colors coarse:min-h-10';

  const renderSite = (site: { id: number; name: string; itemCount?: number; onlineCount?: number }, groupId: number | null, depth: number) => {
    const draggable = canMoveSite(site.id, groupId);
    const dragged: DraggedSite = { id: site.id, name: site.name, groupId };
    const isSelected = selectedSiteId === site.id;
    const total = site.itemCount ?? 0;
    const online = site.onlineCount ?? 0;
    const menu: ActionMenuItem[] = [
      {
        key: 'move',
        icon: <FolderInput className="h-4 w-4" />,
        label: t('groupPanel.moveTo', 'Move to…'),
        onClick: () => openMoveDialog({ kind: 'site', site: dragged }),
        hidden: !draggable,
      },
    ];
    return (
      <div
        key={`site-${site.id}`}
        draggable={draggable}
        onDragStart={(e) => {
          if (!draggable) return;
          e.stopPropagation();
          setSiteDragData(e, dragged);
          setDrag({ kind: 'site', site: dragged });
        }}
        onDragEnd={endDrag}
        className={cn(
          rowBase,
          isSelected ? 'bg-bg-active text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          drag?.kind === 'site' && drag.site.id === site.id && 'opacity-40',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <span
          className={cn(
            'flex w-3.5 shrink-0 items-center justify-center text-text-muted/70',
            draggable ? 'cursor-grab opacity-0 group-hover/row:opacity-100 coarse:hidden' : 'invisible',
          )}
          aria-hidden
        >
          <GripVertical size={12} />
        </span>
        <span className="w-3.5 shrink-0" />
        <button
          type="button"
          onClick={() => onSelect({ type: 'site', siteId: site.id, groupId })}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
        >
          <MapPin size={13} className="shrink-0 text-accent" />
          <span className="truncate">{anonymize(site.name, 'hostname')}</span>
          {total > 0 && (
            <span
              className={cn(
                'ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                online === total
                  ? 'bg-status-up-bg text-status-up'
                  : online > total * 0.5
                    ? 'bg-yellow-500/10 text-yellow-500'
                    : 'bg-status-down-bg text-status-down',
              )}
            >
              {online}/{total}
            </span>
          )}
        </button>
        {draggable && (
          <ActionMenu
            items={menu}
            triggerSize="xs"
            triggerClassName="shrink-0 can-hover:opacity-0 can-hover:group-hover/row:opacity-100 focus-visible:opacity-100"
            sheetTitle={anonymize(site.name, 'hostname')}
          />
        )}
      </div>
    );
  };

  const renderGroup = (node: GroupTreeNode, depth: number, parentId: number | null): ReactNode => {
    const writable = canWriteGroup(node.id);
    // Reordering siblings needs only 'groups.manage' (server: POST /groups/reorder);
    // reparenting still requires write on the group (canMoveGroupTo).
    const groupDraggable = writable || canReorder;
    const isCollapsed = !isSearching && collapsed.has(node.id);
    const sites = node.sites ?? [];
    const hasContent = node.children.length > 0 || sites.length > 0 || creatingUnder === node.id;
    const isSelected = selectedGroupId === node.id && selectedSiteId === null;
    const stats = groupStats[node.id];
    const dropOnKey = `on:${node.id}`;
    const isRenaming = renamingId === node.id;
    const mayAddChild = canCreateUnder(node.id);
    const mayMove = writable;

    const menu: ActionMenuItem[] = [
      {
        key: 'add',
        icon: <FolderPlus className="h-4 w-4" />,
        label: t('groups.addSubGroup', 'Add sub-group'),
        onClick: () => { expand(node.id); setRenamingId(null); setCreatingUnder(node.id); },
        hidden: !mayAddChild,
      },
      {
        key: 'rename',
        icon: <Pencil className="h-4 w-4" />,
        label: t('groupPanel.rename', 'Rename'),
        onClick: () => { setCreatingUnder(undefined); setRenamingId(node.id); },
        hidden: !writable,
      },
      {
        key: 'move',
        icon: <FolderInput className="h-4 w-4" />,
        label: t('groupPanel.moveTo', 'Move to…'),
        onClick: () => openMoveDialog({ kind: 'group', node }),
        hidden: !mayMove,
      },
      {
        key: 'settings',
        icon: <Settings2 className="h-4 w-4" />,
        label: t('groupPanel.settings', 'Group settings'),
        onClick: () => navigate(`/group/${node.id}/edit`),
        hidden: !(writable || canOpenSettingsPage),
      },
      {
        key: 'delete',
        icon: <Trash2 className="h-4 w-4" />,
        label: t('common.delete', 'Delete'),
        onClick: () => { void actions.deleteGroup(node.id); },
        danger: true,
        separator: true,
        hidden: !writable,
      },
    ];

    return (
      <div key={`group-${node.id}`}>
        {renderDropBetween(parentId, node.id, depth)}
        {isRenaming ? (
          <InlineNameForm
            initial={node.name}
            depth={depth}
            placeholder={t('groups.form.namePlaceholder', 'Group name')}
            onSubmit={(name) => (name.trim() === node.name ? Promise.resolve(true) : actions.renameGroup(node.id, name))}
            onCancel={() => setRenamingId(null)}
          />
        ) : (
          <div
            draggable={groupDraggable}
            onDragStart={(e) => {
              if (!groupDraggable) return;
              e.stopPropagation();
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData(GROUP_DRAG_MIME, String(node.id));
              e.dataTransfer.setData('text/plain', node.name);
              setDrag({ kind: 'group', node });
            }}
            onDragEnd={endDrag}
            onDragOver={overHandler(dropOnKey, (kind) => canDropOnGroup(kind, node.id))}
            onDragLeave={leaveHandler(dropOnKey)}
            onDrop={dropOnGroup(node.id)}
            className={cn(
              rowBase,
              isSelected ? 'bg-bg-active text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              drag?.kind === 'group' && drag.node.id === node.id && 'opacity-40',
              dropKey === dropOnKey && 'bg-accent/10 ring-1 ring-accent/50',
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            <span
              className={cn(
                'flex w-3.5 shrink-0 items-center justify-center text-text-muted/70',
                groupDraggable ? 'cursor-grab opacity-0 group-hover/row:opacity-100 coarse:hidden' : 'invisible',
              )}
              title={groupDraggable ? t('groupPanel.dragHint', 'Drag to reorder or move to another group') : undefined}
              aria-hidden
            >
              <GripVertical size={12} />
            </span>
            <button
              type="button"
              onClick={() => { if (hasContent) toggleCollapsed(node.id); }}
              className={cn('flex h-5 w-3.5 shrink-0 items-center justify-center', !hasContent && 'invisible')}
              aria-label={isCollapsed ? t('groupPanel.expand', 'Expand') : t('groupPanel.collapse', 'Collapse')}
              aria-expanded={hasContent ? !isCollapsed : undefined}
              tabIndex={hasContent ? 0 : -1}
            >
              <ChevronRight size={14} className={cn('text-text-muted transition-transform', !isCollapsed && 'rotate-90')} />
            </button>
            <button
              type="button"
              onClick={() => onSelect({ type: 'group', groupId: node.id })}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
            >
              {!isCollapsed && hasContent
                ? <FolderOpen size={14} className="shrink-0 text-accent" />
                : <Folder size={14} className="shrink-0 text-accent" />}
              <span className="truncate">{anonymize(node.name, 'hostname')}</span>
              {node.isGeneral && (
                <span className="shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  {t('groups.generalBadge', 'General')}
                </span>
              )}
              {stats && stats.total > 0 && (
                <span
                  className={cn(
                    'ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                    stats.uptimePct >= 99
                      ? 'bg-status-up-bg text-status-up'
                      : stats.uptimePct >= 95
                        ? 'bg-yellow-500/10 text-yellow-500'
                        : 'bg-status-down-bg text-status-down',
                  )}
                >
                  {stats.uptimePct}%
                </span>
              )}
            </button>
            {mayAddChild && (
              <IconButton
                size="xs"
                variant="accent"
                label={t('groups.addSubGroup', 'Add sub-group')}
                icon={<Plus size={13} />}
                onClick={() => { expand(node.id); setRenamingId(null); setCreatingUnder(node.id); }}
                className="shrink-0 can-hover:opacity-0 can-hover:group-hover/row:opacity-100 focus-visible:opacity-100 coarse:hidden"
              />
            )}
            {menu.some((item) => !item.hidden) && (
              <ActionMenu
                items={menu}
                triggerSize="xs"
                triggerClassName="shrink-0 can-hover:opacity-0 can-hover:group-hover/row:opacity-100 focus-visible:opacity-100"
                sheetTitle={anonymize(node.name, 'hostname')}
              />
            )}
          </div>
        )}

        {!isCollapsed && (
          <div>
            {creatingUnder === node.id && (
              <InlineNameForm
                depth={depth + 1}
                placeholder={t('groupPanel.newGroupName', 'New group name')}
                onSubmit={(name) => actions.createGroup(name, node.id)}
                onCancel={() => setCreatingUnder(undefined)}
              />
            )}
            {node.children.map((child) => renderGroup(child, depth + 1, node.id))}
            {node.children.length > 0 && renderDropBetween(node.id, null, depth + 1)}
            {sites.map((site) => renderSite(site, node.id, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const ungroupedKey = 'on:none';
  const moveDialogName = moveDialog
    ? anonymize(moveDialog.kind === 'group' ? moveDialog.node.name : moveDialog.site.name, 'hostname')
    : '';
  const moveAllowNone = fullAccess || (moveDialog?.kind === 'site' && moveDialog.site.groupId === null);
  const moveUnchanged = moveDialog
    ? (moveDialog.kind === 'group' ? (moveDialog.node.parentId ?? null) : moveDialog.site.groupId) === moveTarget
    : true;

  return (
    <div className={cn('flex min-h-0 flex-col rounded-xl bg-bg-secondary', className)}>
      {/* Header: title, new top-level group, search */}
      <div className="space-y-2 px-3 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <Layers size={15} className="shrink-0 text-accent" />
          <span className="flex-1 truncate text-sm font-semibold text-text-primary">
            {title ?? t('nav.groups', 'Groups')}
          </span>
          {mayCreateRoot && (
            <IconButton
              size="sm"
              variant="accent"
              label={t('groupPanel.newRootGroup', 'New top-level group')}
              icon={<Plus size={15} />}
              onClick={() => { setRenamingId(null); setCreatingUnder(null); }}
            />
          )}
        </div>
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('groupPanel.search', 'Search groups and sites…')}
            aria-label={t('groupPanel.search', 'Search groups and sites…')}
            className="w-full rounded-md bg-bg-tertiary py-1.5 pl-7 pr-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {showAll && (
          <button
            type="button"
            onClick={() => onSelect({ type: 'all' })}
            className={cn(
              'flex w-full items-center gap-1.5 rounded-md py-1.5 pl-2 pr-1 text-left text-sm transition-colors coarse:min-h-10',
              selectedGroupId === null && selectedSiteId === null
                ? 'bg-bg-active text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            <Layers size={14} className="shrink-0 text-accent" />
            <span className="truncate">{t('groupPanel.allSites', 'All sites')}</span>
          </button>
        )}

        {creatingUnder === null && (
          <InlineNameForm
            depth={0}
            placeholder={t('groupPanel.newGroupName', 'New group name')}
            onSubmit={(name) => actions.createGroup(name, null)}
            onCancel={() => setCreatingUnder(undefined)}
          />
        )}

        {visibleTree.map((node) => renderGroup(node, 0, null))}
        {visibleTree.length > 0 && renderDropBetween(null, null, 0)}

        {visibleTree.length === 0 && (!showUngrouped || visibleUngrouped.length === 0) && creatingUnder !== null && (
          <p className="px-2 py-4 text-center text-sm text-text-muted">
            {isSearching ? t('groups.noMatching', 'No matching groups') : t('groups.noGroups', 'No groups yet')}
          </p>
        )}

        {/* Sites without a group (also the drop zone to take a site out of its group: full access) */}
        {showUngrouped && (visibleUngrouped.length > 0 || (drag !== null && fullAccess)) && (
          <div
            className={cn('mt-2 rounded-md', dropKey === ungroupedKey && 'bg-accent/10 ring-1 ring-accent/50')}
            onDragOver={overHandler(ungroupedKey, (kind) => canDropOnGroup(kind, null))}
            onDragLeave={leaveHandler(ungroupedKey)}
            onDrop={dropOnGroup(null)}
          >
            <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              {drag?.kind === 'group'
                ? t('groupPanel.dropTopLevel', 'Top level')
                : t('sidebar.ungrouped', 'Ungrouped')}
            </p>
            {visibleUngrouped.map((site) => renderSite(site, null, 0))}
          </div>
        )}
        {showUngrouped && ungroupedError && ungrouped.length === 0 && (
          <p className="px-2 py-1 text-xs text-text-muted">
            {t('sidebar.ungroupedLoadFailed', 'Ungrouped sites unavailable')}
          </p>
        )}
      </div>

      <Modal
        open={moveDialog !== null}
        onClose={() => { if (!moveSaving) setMoveDialog(null); }}
        size="sm"
        icon={<FolderInput className="h-5 w-5" />}
        title={moveDialog?.kind === 'site'
          ? t('groupPanel.moveSiteTitle', 'Move site')
          : t('groupPanel.moveGroupTitle', 'Move group')}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setMoveDialog(null)} disabled={moveSaving}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button onClick={() => { void applyMoveDialog(); }} loading={moveSaving} disabled={moveUnchanged}>
              {t('groupPanel.moveAction', 'Move')}
            </Button>
          </>
        )}
      >
        {moveDialog && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              {moveDialog.kind === 'site'
                ? t('groupPanel.moveSitePrompt', 'New group of the site "{{name}}":', { name: moveDialogName })
                : t('groupPanel.moveGroupPrompt', 'New parent of the group "{{name}}":', { name: moveDialogName })}
            </p>
            <GroupPicker
              value={moveTarget}
              onChange={setMoveTarget}
              tree={tree}
              excludeId={moveDialog.kind === 'group' ? moveDialog.node.id : undefined}
              allowNone={moveAllowNone}
              placeholder={moveAllowNone
                ? t('groups.form.parentNone', 'None (root level)')
                : t('groups.form.parentRequired', 'Choose a parent group')}
            />
            {moveTarget !== null && !canWriteGroup(moveTarget) && (
              <p className="text-xs text-red-400">
                {moveDialog.kind === 'site'
                  ? t('groupPanel.siteTargetDenied', 'You cannot move a site into this group.')
                  : t('groups.targetNotWritable', 'You cannot move a group under this one.')}
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
