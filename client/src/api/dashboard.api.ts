import apiClient from './client';
import type { ApiResponse } from '@oblimap/shared';

// Dashboard API. Every aggregate covers only the sites
// the user may read; probe KPIs are null unless the user holds 'probes.manage'.

export interface DashboardSummary {
  sites: { total: number };
  devices: { total: number; online: number; offline: number; reserved: number };
  newDevices24h: number;
  ipConflictsActive: number;
  ipInstabilityActive: number;
  /** null when the tenant has no enabled device-check rule. */
  checks: { ok: number; fail: number; error: number; alerting: number } | null;
  deviceTypes: Array<{ type: string; count: number }>;
  /** Top 5 /24 subnets by number of addresses in use. */
  topSubnets: Array<{ siteId: number; siteName: string; subnet: string; used: number; usable: number; pct: number }>;
  /** ISO timestamp of the latest device sighting, null without devices. */
  lastScanAt: string | null;
  /** Today vs yesterday's snapshot; null when there is no snapshot of yesterday. */
  deltas: { devicesOnline: number | null; newDevices: number | null };
  /** Approved + pending probes (refused / suspended left out): total = online + offline + pending. */
  probes: { total: number; online: number; offline: number; pending: number } | null;
  pendingProbes: number | null;
}

export interface DashboardTimeseriesPoint {
  /** YYYY-MM-DD (UTC) */
  day: string;
  hostsTotal: number;
  hostsOnline: number;
  newHosts: number;
  ipConflicts: number;
  failingChecks: number;
}

export const dashboardApi = {
  async summary(): Promise<DashboardSummary> {
    const res = await apiClient.get<ApiResponse<DashboardSummary>>('/dashboard/summary');
    return res.data.data!;
  },

  /** One point per day, oldest first, missing days as zeros. `days` in 1..90. */
  async timeseries(days = 14): Promise<DashboardTimeseriesPoint[]> {
    const res = await apiClient.get<ApiResponse<DashboardTimeseriesPoint[]>>('/dashboard/timeseries', {
      params: { days },
    });
    return res.data.data!;
  },
};
