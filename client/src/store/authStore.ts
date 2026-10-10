import { create } from 'zustand';
import { PAGE_ACCESS } from '@oblimap/shared';
import type { User, UserPermissions, PermissionLevel, GroupTreeNode, PageAccess } from '@oblimap/shared';
import { authApi, type LoginResult } from '../api/auth.api';
import { isInObliTools, setObliToolsToken } from '../api/client';
import type { TenantCapability } from '../api/permissionSets.api';
import { connectSocket, disconnectSocket } from '../socket/socketClient';
import { useLiveAlertsStore } from './liveAlertsStore';
import { setLanguage } from '../i18n';
import { useTenantStore } from './tenantStore';
import { useGroupStore } from './groupStore';
import { applyTheme } from '../utils/theme';

export type { TenantCapability } from '../api/permissionSets.api';

function syncPreferencesToStore(user: User) {
  const prefs = user.preferences;
  if (prefs) {
    useLiveAlertsStore.getState().setEnabled(prefs.toastEnabled ?? true);
    useLiveAlertsStore.getState().setPosition(prefs.toastPosition ?? 'bottom-right');
    if (prefs.preferredTheme) {
      applyTheme(prefs.preferredTheme);
    }
  }
  if (user.preferredLanguage) {
    setLanguage(user.preferredLanguage);
  }
}

/**
 * GET /auth/me and /auth/permissions payload. `canCreateRootGroup` is read
 * when the server sends it (full access or a can_create team of the tenant);
 * older servers do not.
 */
type PermissionsPayload = UserPermissions & { canCreateRootGroup?: boolean };

interface AuthState {
  user: User | null;
  permissions: PermissionsPayload | null;
  requires2faSetup: boolean;
  isLoading: boolean;
  isInitialized: boolean;

  login: (username: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  refreshPermissions: () => Promise<void>;

  // Convenience permission checkers. They mirror the server's checks so the
  // UI shows what the user may do; every route enforces them on its own.
  /** Platform admin (users.role = 'admin'). */
  isAdmin: () => boolean;
  /** Admin of the current tenant (user_tenants.role = 'admin'), or platform admin. */
  isTenantAdmin: () => boolean;
  /** Platform admin or tenant admin: every capability and 'rw' everywhere in the tenant. */
  hasFullAccess: () => boolean;
  /**
   * The tenant capability in the current tenant (server
   * requireTenantCapability): platform admins and tenant admins hold them all.
   */
  hasTenantCapability: (capability: TenantCapability) => boolean;
  /** May create groups: full access, a can_create team or groups.manage (server requireCanCreate). */
  canCreate: () => boolean;
  /** May create a top-level group: full access or a can_create team (server requireRootGroupOwner). */
  canCreateRootGroup: () => boolean;
  /**
   * Has something to do on the group management page: full access, may
   * create groups (canCreate), groups.manage (reorder) or write on a group.
   */
  canManageGroups: () => boolean;
  canWriteSite: (siteId: number, groupId: number | null) => boolean;
  canWriteGroup: (groupId: number) => boolean;
  getSitePermission: (siteId: number, groupId: number | null) => PermissionLevel | null;
  getGroupPermission: (groupId: number) => PermissionLevel | null;
}

// ── Group chain (team permissions are inherited by sub-groups and sites) ──

interface GroupInfo {
  parentId: number | null;
  isGeneral: boolean;
}

/**
 * Parent and general flag of every group the client knows. The groups Map is
 * only filled on the group management pages; the tree (fetched by the
 * sidebar) is always there: either answers.
 */
function groupInfoLookup(): (groupId: number) => GroupInfo | undefined {
  const { groups, tree } = useGroupStore.getState();
  const fromTree = new Map<number, GroupInfo>();
  const stack: Array<{ node: GroupTreeNode; parentId: number | null }> = tree.map((node) => ({ node, parentId: null }));
  while (stack.length > 0) {
    const { node, parentId } = stack.pop()!;
    fromTree.set(node.id, { parentId, isGeneral: !!node.isGeneral });
    for (const child of node.children ?? []) stack.push({ node: child, parentId: node.id });
  }
  return (groupId) => {
    const group = groups.get(groupId);
    if (group) return { parentId: group.parentId ?? null, isGeneral: !!group.isGeneral };
    return fromTree.get(groupId);
  };
}

/**
 * Highest team 'group' level on a group or any of its ancestors, like the
 * server's closure-table lookup. `start` is the level already granted (a
 * direct site permission).
 */
function groupChainLevel(
  permissions: Record<string, PermissionLevel>,
  groupId: number | null,
  start: PermissionLevel | null,
  info: (groupId: number) => GroupInfo | undefined,
): PermissionLevel | null {
  let level = start;
  const seen = new Set<number>();
  let current = groupId;
  while (level !== 'rw' && current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    const groupLevel = permissions[`group:${current}`];
    if (groupLevel === 'rw' || (groupLevel === 'ro' && level === null)) level = groupLevel;
    current = info(current)?.parentId ?? null;
  }
  return level;
}

/**
 * Level on a site: its direct key and its group chain, like the server's
 * getSitePermission. A general group gives no access to its sites. Tenant
 * admins get every site / group key as 'rw'.
 */
function siteLevel(
  permissions: Record<string, PermissionLevel> | undefined,
  siteId: number,
  groupId: number | null,
): PermissionLevel | null {
  if (!permissions) return null;
  return groupChainLevel(permissions, groupId, permissions[`site:${siteId}`] ?? null, groupInfoLookup());
}

/**
 * Level on a group: the group or any ancestor (server getGroupPermission).
 * A general group is readable ('ro') by every member of the tenant.
 */
function groupLevel(
  permissions: Record<string, PermissionLevel> | undefined,
  groupId: number,
): PermissionLevel | null {
  const info = groupInfoLookup();
  const level = permissions ? groupChainLevel(permissions, groupId, null, info) : null;
  if (level === null && info(groupId)?.isGeneral) return 'ro';
  return level;
}

/** canManageGroups without full access: canCreate, groups.manage or a writable group. */
function managesGroups(user: User | null, permissions: PermissionsPayload | null): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!permissions) return false;
  if (permissions.canCreate || (permissions.capabilities ?? []).includes('groups.manage')) return true;
  return Object.entries(permissions.permissions ?? {}).some(([key, level]) => key.startsWith('group:') && level === 'rw');
}

// ── Tenant switch ──
// Capabilities and team permissions belong to the session's tenant: a switch
// (TenantSwitcher, a live alert of another tenant) reloads them. Subscribed
// once, on the first sign-in / session check (not at import time: the tenant
// store imports this module too).
let permissionsTenantId: number | null = null;
let tenantWatchInstalled = false;

function watchTenantSwitch(): void {
  if (tenantWatchInstalled) return;
  tenantWatchInstalled = true;
  useTenantStore.subscribe((state, prev) => {
    if (state.currentTenantId === prev.currentTenantId) return;
    if (state.currentTenantId === null || state.currentTenantId === permissionsTenantId) return;
    if (!useAuthStore.getState().user) return;
    void useAuthStore.getState().refreshPermissions();
  });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  permissions: null,
  requires2faSetup: false,
  isLoading: false,
  isInitialized: false,

  login: async (username: string, password: string) => {
    set({ isLoading: true });
    try {
      const result = await authApi.login({ username, password });

      // 2FA required — don't set user yet, return the challenge to caller
      if (result.requires2fa) {
        set({ isLoading: false });
        return result;
      }

      const user = result.user;
      // In ObliTools iframe context cookies are blocked by the browser's cross-site policy.
      // Store the session token so the API client can send it as X-Auth-Token header
      // (and the socket as handshake.auth.token). Never stored outside ObliTools.
      if (isInObliTools && result.sessionToken) {
        setObliToolsToken(result.sessionToken);
      }
      set({ user, isLoading: false });
      syncPreferencesToStore(user);
      watchTenantSwitch();
      // The server reads the user and tenant from the session.
      connectSocket();
      useTenantStore.getState().fetchTenants();
      // Refused (403) until the password is changed; the profile page reloads
      // the session once it is.
      if (!user.mustChangePassword) useLiveAlertsStore.getState().fetchAlerts();
      // Fetch permissions in the background; failure is non-fatal here.
      authApi.me()
        .then(({ permissions, user: fullUser, requires2faSetup, currentTenantId }) => {
          permissionsTenantId = currentTenantId ?? null;
          set({ permissions, requires2faSetup: requires2faSetup ?? false });
          syncPreferencesToStore(fullUser);
          if (currentTenantId != null) {
            useTenantStore.setState({ currentTenantId });
          }
          // Reload group collapsed state for this user+tenant context
          useGroupStore.getState().reinitForTenant(fullUser.id, currentTenantId ?? null);
        })
        .catch(() => { /* non-critical — permissions will load on next checkSession */ });
      return result;
    } catch (err) {
      set({ isLoading: false });
      const axiosErr = err as { response?: { data?: { error?: string }; status?: number }; message?: string };
      const serverMessage = axiosErr?.response?.data?.error;
      const status = axiosErr?.response?.status;
      if (status === 429) {
        throw new Error(serverMessage ?? 'Too many login attempts, please try again later');
      } else if (status === 401) {
        throw new Error(serverMessage ?? 'Invalid username or password');
      } else if (serverMessage) {
        throw new Error(serverMessage);
      } else {
        throw new Error(axiosErr?.message ?? 'Unable to connect to the server');
      }
    }
  },

  logout: async () => {
    // Fetch Obligate logout URL BEFORE destroying local state
    let obligateLogoutUrl: string | null = null;
    try {
      const res = await fetch('/api/auth/sso-logout-url', { credentials: 'include' });
      const data = await res.json() as { success: boolean; data: string | null };
      if (data.success && data.data) obligateLogoutUrl = data.data;
    } catch { /* ignore */ }

    try {
      await authApi.logout();
    } finally {
      disconnectSocket();
      setObliToolsToken(null);
      permissionsTenantId = null;
      set({ user: null, permissions: null, requires2faSetup: false });
    }

    if (obligateLogoutUrl) {
      window.location.href = obligateLogoutUrl;
    }
  },

  checkSession: async () => {
    try {
      const { user, permissions, requires2faSetup, currentTenantId } = await authApi.me();
      permissionsTenantId = currentTenantId ?? null;
      set({ user, permissions, requires2faSetup: requires2faSetup ?? false, isInitialized: true });
      syncPreferencesToStore(user);
      watchTenantSwitch();
      connectSocket();
      useTenantStore.getState().fetchTenants();
      // Refused (403) until the password is changed (see login above).
      if (!user.mustChangePassword) useLiveAlertsStore.getState().fetchAlerts();
      if (currentTenantId != null) {
        useTenantStore.setState({ currentTenantId });
      }
      // Reload group collapsed state for this user+tenant context
      useGroupStore.getState().reinitForTenant(user.id, currentTenantId ?? null);
    } catch {
      // Only clear user if login() hasn't already set one (race condition guard:
      // App.tsx fires checkSession() on mount; if it resolves AFTER a successful
      // login() call, the catch must not overwrite the freshly-authenticated user).
      set((state) =>
        state.user
          ? { isInitialized: true }
          : { user: null, permissions: null, requires2faSetup: false, isInitialized: true }
      );
    }
  },

  refreshPermissions: async () => {
    try {
      // The session's tenant when the request starts (a switch reloads again).
      const tenantId = useTenantStore.getState().currentTenantId;
      const permissions = await authApi.getPermissions();
      permissionsTenantId = tenantId;
      set({ permissions });
    } catch {
      // Ignore errors
    }
  },

  isAdmin: () => get().user?.role === 'admin',

  isTenantAdmin: () => {
    const { user } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    const { tenants, currentTenantId } = useTenantStore.getState();
    return currentTenantId !== null && tenants.some((t) => t.id === currentTenantId && t.role === 'admin');
  },

  hasFullAccess: () => get().isTenantAdmin(),

  hasTenantCapability: (capability: TenantCapability) => {
    const { user, permissions } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    // The server lists every capability for a tenant admin.
    return (permissions?.capabilities ?? []).includes(capability);
  },

  canCreate: () => {
    const { user, permissions } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    return permissions?.canCreate ?? false;
  },

  canCreateRootGroup: () => {
    const { user, permissions } = get();
    if (!user) return false;
    if (get().hasFullAccess()) return true;
    if (!permissions) return false;
    if (typeof permissions.canCreateRootGroup === 'boolean') return permissions.canCreateRootGroup;
    // Older payload: canCreate comes from full access, a can_create team or
    // groups.manage. Without groups.manage it can only be a can_create team;
    // with it the team is unknown, and the server has the last word (403
    // "a top-level group needs a team allowed to create groups").
    return permissions.canCreate === true;
  },

  canManageGroups: () => get().hasFullAccess() || managesGroups(get().user, get().permissions),

  canWriteSite: (siteId: number, groupId: number | null) => {
    const { user, permissions } = get();
    if (!user) return false;
    if (get().hasFullAccess()) return true;
    return siteLevel(permissions?.permissions, siteId, groupId) === 'rw';
  },

  canWriteGroup: (groupId: number) => {
    const { user, permissions } = get();
    if (!user) return false;
    if (get().hasFullAccess()) return true;
    return groupLevel(permissions?.permissions, groupId) === 'rw';
  },

  getSitePermission: (siteId: number, groupId: number | null) => {
    const { user, permissions } = get();
    if (!user) return null;
    if (get().hasFullAccess()) return 'rw';
    return siteLevel(permissions?.permissions, siteId, groupId);
  },

  getGroupPermission: (groupId: number) => {
    const { user, permissions } = get();
    if (!user) return null;
    if (get().hasFullAccess()) return 'rw';
    return groupLevel(permissions?.permissions, groupId);
  },
}));

/**
 * hasFullAccess as a React hook: platform admin, or admin of the current
 * tenant (re-renders on a tenant switch or when the tenants are reloaded).
 */
export function useFullAccess(): boolean {
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const isTenantAdmin = useTenantStore((s) => s.currentTenantId !== null
    && s.tenants.some((t) => t.id === s.currentTenantId && t.role === 'admin'));
  return isPlatformAdmin || isTenantAdmin;
}

// ── Page access (routes in App.tsx, links in the sidebar) ──

// PageAccess / PAGE_ACCESS live in @oblimap/shared (one table with the
// server tests): re-exported so existing imports keep working.
export { PAGE_ACCESS };
export type { PageAccess };

function pageAllowed(
  user: User | null,
  permissions: PermissionsPayload | null,
  access: PageAccess,
  tenantAdmin: boolean,
): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (access.platformAdmin) return false;
  if (access.fullAccess && !tenantAdmin) return false;
  const held = new Set(permissions?.capabilities ?? []);
  if (access.all && !access.all.every((c) => held.has(c))) return false;
  if (access.any && !access.any.some((c) => held.has(c))) return false;
  if (access.anyOf && !access.anyOf.some((nested) => pageAllowed(user, permissions, nested, tenantAdmin))) return false;
  return true;
}

/** Admin of the current tenant (the tenants list), as a React selector. */
function useIsCurrentTenantAdmin(): boolean {
  return useTenantStore((s) => s.currentTenantId !== null
    && s.tenants.some((t) => t.id === s.currentTenantId && t.role === 'admin'));
}

/** The page may be opened by the current user (re-renders when the permissions reload). */
export function usePageAccess(access: PageAccess): boolean {
  const tenantAdmin = useIsCurrentTenantAdmin();
  return useAuthStore((s) => pageAllowed(s.user, s.permissions, access, tenantAdmin));
}

/**
 * A PageAccess checker bound to the current user, permissions and tenant
 * role: re-renders the caller when any of them changes (hub tab lists).
 */
export function usePageAccessChecker(): (access: PageAccess) => boolean {
  const tenantAdmin = useIsCurrentTenantAdmin();
  const user = useAuthStore((s) => s.user);
  const permissions = useAuthStore((s) => s.permissions);
  return (access: PageAccess) => pageAllowed(user, permissions, access, tenantAdmin);
}

/** canManageGroups as a React hook (the group management page and its links). */
export function useCanManageGroups(): boolean {
  const fullAccess = useFullAccess();
  const manages = useAuthStore((s) => managesGroups(s.user, s.permissions));
  return fullAccess || manages;
}

/**
 * hasTenantCapability as a React selector: re-renders when the permissions
 * are (re)loaded, e.g. after a tenant switch.
 */
export function useTenantCapability(capability: TenantCapability): boolean {
  return useAuthStore((s) => !!s.user
    && (s.user.role === 'admin' || (s.permissions?.capabilities ?? []).includes(capability)));
}
