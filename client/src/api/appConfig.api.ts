import apiClient from './client';
import type { AppConfig, ObligateConfig, ApiResponse } from '@oblimap/shared';

/**
 * GET / PUT /admin/config/obligate: flags only, never a secret. The client_id
 * sent to Obligate is always the public id sha256(API key) (server side).
 */
export type ObligateAdminConfig = ObligateConfig;

/** Length bounds of the Obligate inbound secret (same rule as the server). */
export const OBLIGATE_INBOUND_SECRET_MIN = 32;
export const OBLIGATE_INBOUND_SECRET_MAX = 256;

export const appConfigApi = {
  async getConfig(): Promise<AppConfig> {
    const res = await apiClient.get<ApiResponse<AppConfig>>('/admin/config');
    return res.data.data!;
  },

  async setConfig(key: keyof AppConfig, value: boolean | number | null): Promise<void> {
    await apiClient.put(`/admin/config/${key}`, { value: String(value ?? '') });
  },

  // ── Obligate SSO gateway ────────────────────────────────────────────────

  async getObligateConfig(): Promise<ObligateAdminConfig> {
    const res = await apiClient.get<ApiResponse<ObligateAdminConfig>>('/admin/config/obligate');
    return res.data.data!;
  },

  async patchObligateConfig(patch: {
    url?: string | null;
    apiKey?: string | null;
    enabled?: boolean;
    /** Distinct secret expected from Obligate (32-256 characters); null clears it. */
    inboundSecret?: string | null;
  }): Promise<ObligateAdminConfig> {
    const res = await apiClient.put<ApiResponse<ObligateAdminConfig>>('/admin/config/obligate', patch);
    return res.data.data!;
  },
};
