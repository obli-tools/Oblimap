import { useEffect, useRef } from 'react';
import type { GroupTreeNode, PermissionLevel } from '@oblimap/shared';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';

/** Group ids from the root down to `targetId` (inclusive), or null when not in the tree. */
export function groupPathTo(nodes: GroupTreeNode[], targetId: number, path: number[] = []): number[] | null {
  for (const node of nodes) {
    if (node.id === targetId) return [...path, node.id];
    const found = groupPathTo(node.children ?? [], targetId, [...path, node.id]);
    if (found) return found;
  }
  return null;
}

/** The group `targetId` of the tree, or null when the user's tree does not show it. */
export function findGroupNode(nodes: GroupTreeNode[], targetId: number): GroupTreeNode | null {
  for (const node of nodes) {
    if (node.id === targetId) return node;
    const found = findGroupNode(node.children ?? [], targetId);
    if (found) return found;
  }
  return null;
}

/**
 * The user's level on a site, as the server computes it (requireSiteRead /
 * requireSiteWrite): full access (platform admin or admin of the current
 * tenant, useFullAccess) → rw; otherwise the best of the team permission on
 * the site and on its group or any ancestor group.
 */
export function sitePermissionLevel(
  fullAccess: boolean,
  permissions: Record<string, PermissionLevel> | undefined,
  siteId: number,
  groupChain: number[],
): PermissionLevel | null {
  if (fullAccess) return 'rw';
  if (!permissions) return null;
  const levels = [permissions[`site:${siteId}`], ...groupChain.map((g) => permissions[`group:${g}`])];
  if (levels.includes('rw')) return 'rw';
  if (levels.includes('ro')) return 'ro';
  return null;
}

/**
 * Keeps the permission map in step with the session before it hides write
 * controls. The map is a snapshot: a tenant switch through TenantSwitcher
 * does not reload it (site / group ids never overlap across tenants), and a
 * tenant admin's map lacks the sites and groups created since it was loaded.
 * So it is reloaded when the tenant changes, and once per tenant for every
 * shown site it does not let the user write. Full access (platform admin or
 * tenant admin, useFullAccess) is always 'rw': nothing to reload.
 */
export function useFreshSitePermissions(fullAccess: boolean, readOnlySiteIds: readonly number[]): void {
  const tenantId = useTenantStore((s) => s.currentTenantId);
  const loaded = useAuthStore((s) => s.permissions !== null);
  const checked = useRef<{ tenantId: number | null; ids: Set<number> }>({ tenantId, ids: new Set() });
  const idsKey = readOnlySiteIds.join(',');

  useEffect(() => {
    // Not loaded yet: login / checkSession is fetching the map.
    if (fullAccess || !loaded) return;
    const prev = checked.current;
    // null → id is the session's tenant becoming known, not a switch.
    const switched = prev.tenantId !== null && prev.tenantId !== tenantId;
    if (prev.tenantId !== tenantId) checked.current = { tenantId, ids: new Set() };
    const seen = checked.current.ids;
    const unchecked = idsKey === '' ? [] : idsKey.split(',').map(Number).filter((id) => !seen.has(id));
    for (const id of unchecked) seen.add(id);
    if (switched || unchecked.length > 0) void useAuthStore.getState().refreshPermissions();
  }, [fullAccess, loaded, tenantId, idsKey]);
}
