import apiClient from './client';
import type {
  MonitorGroup,
  GroupTreeNode,
  ApiResponse,
  CreateGroupRequest,
  UpdateGroupRequest,
  Probe,
} from '@oblimap/shared';

/** GET /groups/:id/detail-stats */
export interface GroupDetailStats {
  uptimePct: number;
  total: number;
  up: number;
  siteCount: number;
  /** Approved probes on those sites (newer servers; absent on older ones). */
  probeCount?: number;
}

/** GET /groups/stats: one entry per visible group (subtree, readable sites only). */
export interface GroupSubtreeStats {
  uptimePct: number;
  total: number;
  up: number;
  /** Newer servers only. */
  siteCount?: number;
  onlineCount?: number;
  offlineCount?: number;
}

export const groupsApi = {
  async list(): Promise<MonitorGroup[]> {
    const res = await apiClient.get<ApiResponse<MonitorGroup[]>>('/groups');
    return res.data.data!;
  },

  async tree(): Promise<GroupTreeNode[]> {
    const res = await apiClient.get<ApiResponse<GroupTreeNode[]>>('/groups/tree');
    return res.data.data!;
  },

  async getById(id: number): Promise<MonitorGroup> {
    const res = await apiClient.get<ApiResponse<MonitorGroup>>(`/groups/${id}`);
    return res.data.data!;
  },

  async create(data: CreateGroupRequest): Promise<MonitorGroup> {
    const res = await apiClient.post<ApiResponse<MonitorGroup>>('/groups', data);
    return res.data.data!;
  },

  async update(id: number, data: UpdateGroupRequest): Promise<MonitorGroup> {
    const res = await apiClient.put<ApiResponse<MonitorGroup>>(`/groups/${id}`, data);
    return res.data.data!;
  },

  async move(id: number, newParentId: number | null): Promise<MonitorGroup> {
    const res = await apiClient.post<ApiResponse<MonitorGroup>>(`/groups/${id}/move`, { newParentId });
    return res.data.data!;
  },

  /**
   * Deletes a group; its sub-groups and sites move to its parent. Writers
   * without full access get 409 {error:'group_not_empty'} on a non-empty group.
   */
  async delete(id: number): Promise<void> {
    await apiClient.delete(`/groups/${id}`);
  },

  async getStats(): Promise<Record<number, GroupSubtreeStats>> {
    const res = await apiClient.get<ApiResponse<Record<number, GroupSubtreeStats>>>('/groups/stats');
    return res.data.data!;
  },

  /**
   * Device stats of a group and its sub-groups, over the sites the user may
   * read: total devices, online devices, uptime % and site count.
   */
  async detailStats(id: number): Promise<GroupDetailStats> {
    const res = await apiClient.get<ApiResponse<GroupDetailStats>>(`/groups/${id}/detail-stats`);
    return res.data.data!;
  },

  async reorder(items: { id: number; sortOrder: number }[]): Promise<void> {
    await apiClient.post('/groups/reorder', { items });
  },

  async getGroupProbes(groupId: number): Promise<{ probes: (Probe & { siteName: string | null })[] }> {
    const res = await apiClient.get(`/groups/${groupId}/probes`);
    return res.data as { probes: (Probe & { siteName: string | null })[] };
  },

};
