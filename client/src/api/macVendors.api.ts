import apiClient from './client';
import type { MacVendor } from '@oblimap/shared';
import type { AxiosResponse } from 'axios';

export interface MacVendorListResponse {
  vendors: MacVendor[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface MacVendorStatsResponse {
  total: number;
  overrides: number;
  lastUpdated: string | null;
  /** Last complete download of the IEEE registries (null: never; absent: older server). */
  lastSeededAt?: string | null;
  /** Rows per prefix length: 24 = MA-L, 28 = MA-M, 36 = MA-S. */
  byPrefixBits?: { 24: number; 28: number; 36: number };
}

export interface MacVendorSeedResponse {
  inserted: number;
  complete?: boolean;
  registries?: Array<{ key: 'MA-L' | 'MA-M' | 'MA-S'; bits: number; rows: number; error?: string }>;
}

export const macVendorsApi = {
  list: (params?: {
    q?: string;
    page?: number;
    limit?: number;
    overrideOnly?: boolean;
  }): Promise<MacVendorListResponse> =>
    apiClient
      .get('/mac-vendors', { params })
      .then((r: AxiosResponse) => r.data as MacVendorListResponse),

  stats: (): Promise<MacVendorStatsResponse> =>
    apiClient
      .get('/mac-vendors/stats')
      .then((r: AxiosResponse) => r.data as MacVendorStatsResponse),

  updateCustomName: (prefix: string, customName: string | null): Promise<{ vendor: MacVendor }> =>
    apiClient
      .patch(`/mac-vendors/${encodeURIComponent(prefix)}`, { customName })
      .then((r: AxiosResponse) => r.data as { vendor: MacVendor }),

  clearOverride: (prefix: string): Promise<void> =>
    apiClient
      .delete(`/mac-vendors/${encodeURIComponent(prefix)}/override`)
      .then(() => undefined),

  /** Downloads the IEEE MA-L / MA-M / MA-S registries now (platform admin). */
  seed: (): Promise<MacVendorSeedResponse> =>
    apiClient
      .post('/mac-vendors/seed')
      .then((r: AxiosResponse) => r.data as MacVendorSeedResponse),
};
