import apiClient from './client';
import type { ApiResponse } from '@oblimap/shared';

// Members of a tenant (user_tenants joined on users).
//
// - /tenant/current/members: the current tenant, for holders of the tenant
//   capability 'users.manage' (tenant admins included). The server applies
//   the dominance rules: a role the caller does not hold every capability of
//   is refused, 'admin' is granted only by a tenant admin, never the caller's
//   own row, never the last tenant admin. Refusals are 403
//   {error:'forbidden', reason}.
// - /tenants/:id/members: any tenant, platform admins only.
//
// The rows are normalised here: the server may send them snake_case
// (tenantService.getMembers: display_name, is_active, role = platform role,
// tenantRole) or camelCase (role = tenant role).

export interface TenantMember {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  isActive: boolean;
  /** 'obligate' for an SSO account: Obligate resets its role and teams at each sign-in. */
  foreignSource: string | null;
  /** Tenant role: a permission set slug ('admin' = tenant admin), or the legacy 'member'. */
  tenantRole: string;
  /** Platform role, when the server sends it ('admin' = platform admin). */
  platformRole: 'admin' | 'user' | null;
  lastLoginAt: string | null;
}

type RawMember = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function platformRoleOf(value: unknown): 'admin' | 'user' | null {
  return value === 'admin' || value === 'user' ? value : null;
}

/** One member row, whatever casing the server used. */
export function normalizeTenantMember(raw: RawMember): TenantMember {
  // Rows of tenantService.getMembers carry the platform role in `role` and
  // the tenant role in `tenantRole`; camelCase rows carry the tenant role in
  // `role` (and the platform role, if any, in `platformRole`).
  const hasTenantRole = typeof raw.tenantRole === 'string' || typeof raw.tenant_role === 'string';
  const tenantRole = hasTenantRole
    ? String(raw.tenantRole ?? raw.tenant_role)
    : String(raw.role ?? 'viewer');
  const platformRole = hasTenantRole
    ? platformRoleOf(raw.role)
    : platformRoleOf(raw.platformRole ?? raw.platform_role ?? (raw.isPlatformAdmin === true ? 'admin' : null));
  const isActive = raw.isActive ?? raw.is_active;
  return {
    id: Number(raw.id),
    username: String(raw.username ?? ''),
    displayName: str(raw.displayName ?? raw.display_name),
    email: str(raw.email),
    isActive: isActive === undefined ? true : isActive === true,
    foreignSource: str(raw.foreignSource ?? raw.foreign_source),
    tenantRole,
    platformRole,
    lastLoginAt: str(raw.lastLoginAt ?? raw.last_login_at),
  };
}

function normalizeList(rows: RawMember[] | undefined): TenantMember[] {
  return (rows ?? []).map(normalizeTenantMember);
}

export const tenantMembersApi = {
  // ── Current tenant ('users.manage') ──

  /** Members of the current tenant. */
  async listCurrent(): Promise<TenantMember[]> {
    const res = await apiClient.get<ApiResponse<RawMember[]>>('/tenant/current/members');
    return normalizeList(res.data.data);
  },

  /**
   * Adds an existing account to the current tenant, by its exact username or
   * e-mail address (no search: an unknown and an unavailable account get the
   * same 404).
   */
  async addCurrent(usernameOrEmail: string, role: string): Promise<void> {
    await apiClient.post('/tenant/current/members', { usernameOrEmail, role });
  },

  /** Changes a member's tenant role in the current tenant. */
  async setRoleCurrent(userId: number, role: string): Promise<void> {
    await apiClient.put(`/tenant/current/members/${userId}`, { role });
  },

  /** Removes a member from the current tenant (the account itself is kept). */
  async removeCurrent(userId: number): Promise<void> {
    await apiClient.delete(`/tenant/current/members/${userId}`);
  },

  // ── Any tenant (platform admins) ──

  async listForTenant(tenantId: number): Promise<TenantMember[]> {
    const res = await apiClient.get<ApiResponse<RawMember[]>>(`/tenants/${tenantId}/members`);
    return normalizeList(res.data.data);
  },

  async addToTenant(tenantId: number, userId: number, role: string): Promise<void> {
    await apiClient.post(`/tenants/${tenantId}/members`, { userId, role });
  },

  async setRoleInTenant(tenantId: number, userId: number, role: string): Promise<void> {
    await apiClient.put(`/tenants/${tenantId}/members/${userId}`, { role });
  },

  async removeFromTenant(tenantId: number, userId: number): Promise<void> {
    await apiClient.delete(`/tenants/${tenantId}/members/${userId}`);
  },
};
