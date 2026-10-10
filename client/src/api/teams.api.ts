import apiClient from './client';
import type {
  UserTeam,
  ApiResponse,
  CreateTeamRequest,
  UpdateTeamRequest,
  PermissionLevel,
} from '@oblimap/shared';

// Teams are mono-tenant: every call below works on the teams of the current
// tenant (the server answers 404 for another tenant's team). To manage the
// teams of another tenant, switch to it.

/** Permission scope of a team: a group (with its sub-groups and their sites) or one site. */
export type TeamPermissionScope = 'group' | 'site';

export interface TeamPermissionEntry {
  id: number;
  teamId: number;
  scope: TeamPermissionScope;
  scopeId: number;
  level: PermissionLevel;
}

export interface TeamPermissionInput {
  scope: TeamPermissionScope;
  scopeId: number;
  level: PermissionLevel;
}

/** A user who may join the team (a member of the team's tenant). */
export interface TeamEligibleMember {
  id: number;
  username: string;
  displayName: string | null;
  isActive: boolean;
  /** 'obligate': SSO account, its team memberships are reset at its next sign-in. */
  foreignSource: string | null;
}

export interface TeamDetail extends UserTeam {
  memberIds: number[];
  permissions: TeamPermissionEntry[];
  /** Users who may join the team: the members of the team's tenant. */
  eligibleMemberIds: number[];
  /** The same users, with their names (empty from a server that does not send them). */
  eligibleMembers: TeamEligibleMember[];
}

export const teamsApi = {
  /** Teams of the current tenant. */
  async list(): Promise<UserTeam[]> {
    const res = await apiClient.get<ApiResponse<UserTeam[]>>('/teams');
    return res.data.data!;
  },

  /** Platform admin, read-only overview: teams of every tenant (with tenantName). */
  async listAll(): Promise<UserTeam[]> {
    const res = await apiClient.get<ApiResponse<UserTeam[]>>('/teams?scope=all');
    return res.data.data!;
  },

  async getById(id: number): Promise<TeamDetail> {
    const res = await apiClient.get<ApiResponse<TeamDetail>>(`/teams/${id}`);
    const detail = res.data.data!;
    const eligibleMembers = (Array.isArray(detail.eligibleMembers) ? detail.eligibleMembers : [])
      .map((m) => {
        const raw = m as unknown as Record<string, unknown>;
        return {
          id: Number(raw.id),
          username: String(raw.username ?? ''),
          displayName: typeof (raw.displayName ?? raw.display_name) === 'string' ? String(raw.displayName ?? raw.display_name) : null,
          isActive: (raw.isActive ?? raw.is_active) !== false,
          foreignSource: typeof (raw.foreignSource ?? raw.foreign_source) === 'string' ? String(raw.foreignSource ?? raw.foreign_source) : null,
        };
      });
    return { ...detail, eligibleMemberIds: detail.eligibleMemberIds ?? [], eligibleMembers };
  },

  /** Creates the team in the current tenant. */
  async create(data: CreateTeamRequest): Promise<UserTeam> {
    const res = await apiClient.post<ApiResponse<UserTeam>>('/teams', data);
    return res.data.data!;
  },

  async update(id: number, data: UpdateTeamRequest): Promise<UserTeam> {
    const res = await apiClient.put<ApiResponse<UserTeam>>(`/teams/${id}`, data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/teams/${id}`);
  },

  async getMembers(id: number): Promise<number[]> {
    const res = await apiClient.get<ApiResponse<number[]>>(`/teams/${id}/members`);
    return res.data.data!;
  },

  /** Replaces the members; every user must be a member of the team's tenant. */
  async setMembers(id: number, data: { userIds: number[] }): Promise<void> {
    await apiClient.put(`/teams/${id}/members`, data);
  },

  async getPermissions(id: number): Promise<TeamPermissionEntry[]> {
    const res = await apiClient.get<ApiResponse<TeamPermissionEntry[]>>(`/teams/${id}/permissions`);
    return res.data.data!;
  },

  /** Replaces the permissions; groups and sites must belong to the team's tenant. */
  async setPermissions(id: number, data: { permissions: TeamPermissionInput[] }): Promise<TeamPermissionEntry[]> {
    const res = await apiClient.put<ApiResponse<TeamPermissionEntry[]>>(`/teams/${id}/permissions`, data);
    return res.data.data!;
  },

  async removePermission(teamId: number, permId: number): Promise<void> {
    await apiClient.delete(`/teams/${teamId}/permissions/${permId}`);
  },
};
