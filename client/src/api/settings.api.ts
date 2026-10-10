import apiClient from './client';
import type { ResolvedSettings, ApiResponse, SettingsScope } from '@oblimap/shared';
import type { SettingsKey, BusinessHours } from '@oblimap/shared';

type SettingRawValue = number | boolean | string | string[] | number[] | BusinessHours;

interface ResolvedWithOverrides {
  resolved: ResolvedSettings;
  overrides: Record<string, SettingRawValue>;
}

export const settingsApi = {
  async getGlobalResolved(): Promise<ResolvedWithOverrides> {
    const res = await apiClient.get<ApiResponse<ResolvedWithOverrides>>('/settings/global/resolved');
    return res.data.data!;
  },

  async getGroupResolved(groupId: number): Promise<ResolvedWithOverrides> {
    const res = await apiClient.get<ApiResponse<ResolvedWithOverrides>>(`/settings/group/${groupId}/resolved`);
    return res.data.data!;
  },

  async getSiteResolved(siteId: number): Promise<ResolvedWithOverrides> {
    const res = await apiClient.get<ApiResponse<ResolvedWithOverrides>>(`/settings/site/${siteId}/resolved`);
    return res.data.data!;
  },

  async set(scope: SettingsScope, scopeId: string, key: SettingsKey, value: SettingRawValue): Promise<void> {
    await apiClient.put(`/settings/${scope}/${scopeId}`, { key, value });
  },

  async setBulk(
    scope: SettingsScope,
    scopeId: string,
    overrides: Array<{ key: SettingsKey; value: SettingRawValue }>,
  ): Promise<void> {
    await apiClient.put(`/settings/${scope}/${scopeId}/bulk`, { overrides });
  },

  async remove(scope: SettingsScope, scopeId: string, key: SettingsKey): Promise<void> {
    await apiClient.delete(`/settings/${scope}/${scopeId}/${key}`);
  },
};
