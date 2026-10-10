import apiClient from './client';
import type {
  User,
  UserTeam,
  UserTenantAssignment,
  ApiResponse,
  CreateUserRequest,
  UpdateUserRequest,
} from '@oblimap/shared';

// /api/users: platform admins see and manage every account. Holders of the
// tenant capability 'users.manage' get the current tenant's surface: the
// members of the tenant, accounts created with a membership of the current
// tenant only, and changes on targets they dominate (not a platform admin,
// not an SSO account, not a member of another tenant). Refusals are 403
// {error:'forbidden', reason}.

/** POST /users: the account, plus its role in the current tenant. */
export interface CreateUserInput extends CreateUserRequest {
  /**
   * Tenant role (a permission set slug) of the membership created in the
   * current tenant. Default on the server: 'viewer'.
   */
  tenantRole?: string;
}

/** One team of the target in the tenant, with its permission rows. */
export interface EffectiveAccessTeam {
  id: number;
  name: string;
  permissions: Array<{ scope: 'group' | 'site'; scopeId: number; level: 'ro' | 'rw' }>;
}

/** GET /users/:id/effective-access: what the user may do and see in a tenant. */
export interface EffectiveAccess {
  /** Tenant role (permission set slug, 'admin' = tenant admin), null when not a member. */
  role: string | null;
  /** True for a platform admin (every tenant, every capability). */
  platformAdmin: boolean;
  /** Full access in the tenant (server-computed: false for a disabled account). */
  fullAccess: boolean;
  /** False for a disabled account (no effective access at all). */
  isActive: boolean;
  capabilities: string[];
  teams: EffectiveAccessTeam[];
  readable: { groups: number[]; sites: number[] };
  writable: { groups: number[]; sites: number[] };
}

function ids(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const v of value) {
    const id = typeof v === 'object' && v !== null ? Number((v as { id?: unknown }).id) : Number(v);
    if (Number.isInteger(id) && id > 0) out.push(id);
  }
  return out;
}

function idSets(value: unknown): { groups: number[]; sites: number[] } {
  const v = (value ?? {}) as { groups?: unknown; sites?: unknown };
  return { groups: ids(v.groups), sites: ids(v.sites) };
}

function normalizeEffectiveAccess(raw: Record<string, unknown>): EffectiveAccess {
  const teams = Array.isArray(raw.teams) ? raw.teams as Array<Record<string, unknown>> : [];
  return {
    role: typeof raw.role === 'string' ? raw.role : null,
    platformAdmin: raw.platformAdmin === true || raw.isPlatformAdmin === true,
    isActive: raw.isActive !== false && raw.is_active !== false,
    fullAccess: typeof raw.fullAccess === 'boolean'
      ? raw.fullAccess
      : raw.isActive !== false && (raw.platformAdmin === true || raw.isPlatformAdmin === true || raw.role === 'admin'),
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.filter((c): c is string => typeof c === 'string') : [],
    teams: teams.map((team) => ({
      id: Number(team.id),
      name: String(team.name ?? ''),
      permissions: (Array.isArray(team.permissions) ? team.permissions as Array<Record<string, unknown>> : [])
        .filter((p) => (p.scope === 'group' || p.scope === 'site') && (p.level === 'ro' || p.level === 'rw'))
        .map((p) => ({
          scope: p.scope as 'group' | 'site',
          scopeId: Number(p.scopeId ?? p.scope_id),
          level: p.level as 'ro' | 'rw',
        })),
    })),
    readable: idSets(raw.readable),
    writable: idSets(raw.writable),
  };
}

export const usersApi = {
  /** Platform admins: every account. */
  async list(): Promise<User[]> {
    const res = await apiClient.get<ApiResponse<User[]>>('/users');
    return res.data.data!;
  },

  async getById(id: number): Promise<User> {
    const res = await apiClient.get<ApiResponse<User>>(`/users/${id}`);
    return res.data.data!;
  },

  async create(data: CreateUserInput): Promise<User> {
    const res = await apiClient.post<ApiResponse<User>>('/users', data);
    return res.data.data!;
  },

  async update(id: number, data: UpdateUserRequest): Promise<User> {
    const res = await apiClient.put<ApiResponse<User>>(`/users/${id}`, data);
    return res.data.data!;
  },

  async changePassword(id: number, password: string): Promise<void> {
    await apiClient.put(`/users/${id}/password`, { password });
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/users/${id}`);
  },

  /**
   * Clears the user's second factors (TOTP and e-mail code) and signs them
   * out everywhere. Refused for SSO accounts (Obligate owns them).
   */
  async resetTwoFactor(id: number): Promise<void> {
    await apiClient.delete(`/users/${id}/2fa`);
  },

  /** Role, capabilities, teams and readable / writable groups and sites in a tenant (default: the current one). */
  async effectiveAccess(id: number, tenantId?: number | null): Promise<EffectiveAccess> {
    const res = await apiClient.get<ApiResponse<Record<string, unknown>>>(`/users/${id}/effective-access`, {
      params: tenantId ? { tenantId } : undefined,
    });
    return normalizeEffectiveAccess(res.data.data ?? {});
  },

  async getTeams(id: number): Promise<UserTeam[]> {
    const res = await apiClient.get<ApiResponse<UserTeam[]>>(`/users/${id}/teams`);
    return res.data.data!;
  },

  async getTenants(id: number): Promise<UserTenantAssignment[]> {
    const res = await apiClient.get<ApiResponse<UserTenantAssignment[]>>(`/users/${id}/tenants`);
    return res.data.data!;
  },

  async setTenants(
    id: number,
    assignments: { tenantId: number; role: string }[],
  ): Promise<void> {
    await apiClient.put(`/users/${id}/tenants`, { assignments });
  },
};
