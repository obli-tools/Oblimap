import apiClient from './client';
import type { ApiResponse, CapabilityGroup, TenantCapability as SharedTenantCapability } from '@oblimap/shared';

// Permission sets = the tenant roles (user_tenants.role). They are
// platform-wide: any signed-in user may list them (role pickers); only
// platform admins change them (PermissionSetsTab). The slug is what a
// membership stores: 'admin' = tenant admin (every capability), the legacy
// 'member' is read by the server as the 'viewer' set.

/** Tenant capability keys (@oblimap/shared TENANT_CAPABILITIES). */
export type TenantCapability = SharedTenantCapability;

export interface PermissionSet {
  id: number;
  name: string;
  slug: string;
  capabilities: TenantCapability[];
  isDefault: boolean;
  createdAt: string;
  /** Tenant memberships using the set, every tenant (sent to platform admins only). */
  memberCount?: number;
}

export interface CapabilityInfo {
  key: TenantCapability;
  label: string;
  /** English description (older servers send none). */
  description?: string;
  /** CAPABILITY_GROUPS id of the matrix row (older servers send none). */
  group?: CapabilityGroup['id'];
  /** Capabilities this one grants as well. */
  implies?: TenantCapability[];
  /** The baseline row ('monitoring'): locked, always ticked. */
  baseline?: boolean;
}

/** Tenant role of a tenant admin. */
export const TENANT_ADMIN_ROLE = 'admin';
/** Legacy tenant role, read by the server as the LEGACY_MEMBER_SET set. */
export const LEGACY_MEMBER_ROLE = 'member';
export const LEGACY_MEMBER_SET = 'viewer';

/** The permission set slug a tenant role stands for ('member' → 'viewer'). */
export function permissionSetSlugForRole(role: string): string {
  return role === LEGACY_MEMBER_ROLE ? LEGACY_MEMBER_SET : role;
}

export const permissionSetsApi = {
  /** Every permission set (default sets first, then by name). */
  async list(): Promise<PermissionSet[]> {
    const res = await apiClient.get<ApiResponse<PermissionSet[]>>('/permission-sets');
    return res.data.data ?? [];
  },

  /** The tenant capabilities of this app, with English labels. */
  async capabilities(): Promise<CapabilityInfo[]> {
    const res = await apiClient.get<ApiResponse<CapabilityInfo[]>>('/permission-sets/capabilities');
    return res.data.data ?? [];
  },

  /** Creates a set (platform admins). */
  async create(data: { name: string; slug: string; capabilities: TenantCapability[] }): Promise<PermissionSet> {
    const res = await apiClient.post<ApiResponse<PermissionSet>>('/permission-sets', data);
    return res.data.data as PermissionSet;
  },

  /** Renames a set and / or replaces its stored capabilities (platform admins). */
  async update(id: number, data: { name?: string; capabilities?: TenantCapability[] }): Promise<PermissionSet> {
    const res = await apiClient.put<ApiResponse<PermissionSet>>(`/permission-sets/${id}`, data);
    return res.data.data as PermissionSet;
  },

  /** Deletes a custom set no membership uses (platform admins). */
  async remove(id: number): Promise<void> {
    await apiClient.delete(`/permission-sets/${id}`);
  },
};
