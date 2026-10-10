import apiClient from './client';
import type { Probe, ProbeApiKey, ProbeScanConfig, ProbeUpdatePolicy, ResolvedSettings, SettingsScope } from '@oblimap/shared';
import type { AxiosResponse } from 'axios';

export type ProbeBulkAction = 'approve' | 'delete' | 'uninstall' | 'suspend' | 'unsuspend';
export type ProbeCommandName = 'uninstall' | 'update' | 'rescan';

export interface ProbeBulkResult {
  action: ProbeBulkAction;
  /** Ids the action was applied to */
  affectedIds: number[];
  /** Ids skipped (not in the tenant, or in a state the action does not apply to) */
  skipped: number;
  /** approve only: the ids actually approved (pending / refused ones) */
  approvedIds?: number[];
}

export interface ProbeInstallInfo {
  /** Server URL written into the installers (APP_URL unless loopback, else the request host); null when none is usable. */
  serverUrl: string | null;
}

export type ProbeEffectiveScanKey =
  | 'scanIntervalSeconds'
  | 'excludedSubnets'
  | 'extraSubnets'
  | 'portScanEnabled'
  | 'portScanPorts'
  | 'flowAnalysisEnabled';

export interface ProbeEffectiveScanConfig {
  scanConfigOverride: boolean;
  config: {
    scanIntervalSeconds: number;
    excludedSubnets: string[];
    extraSubnets: string[];
    portScanEnabled: boolean;
    portScanPorts: number[];
    flowAnalysisEnabled: boolean;
    acceptsSkippedSubnets?: boolean;
  };
  sources: Record<ProbeEffectiveScanKey, {
    source: 'probe' | SettingsScope | 'default';
    sourceId: number | null;
    sourceName: string | null;
  }>;
  /** Device Checks assignment summary (capable probes only). */
  deviceChecks: { rev: string; rules: number; targets: number } | null;
  /** probeUpdatePolicy in effect for the probe (its site chain); absent from older servers. */
  updatePolicy?: {
    policy: ProbeUpdatePolicy;
    source: SettingsScope | 'default';
    sourceId: number | null;
    sourceName: string | null;
  };
}

export interface ProbeVersionDistribution {
  /** Probe version shipped by the server (null when unknown). */
  latestVersion: string | null;
  total: number;
  outdated: number;
  /** Approved probes per reported version, newest first ('unknown' = never reported). */
  versions: Array<{ version: string; count: number; outdated: boolean }>;
  /** Paced "Update outdated probes" still running (null when idle). */
  rollout: { remaining: number; perMinute: number } | null;
}

export interface ProbeFleetUpdatePreview {
  latestVersion: string | null;
  probes: Array<{ id: number; name: string; probeVersion: string | null; siteId: number | null; wsConnected: boolean }>;
  /** Outdated probes skipped because their scope's update policy is 'frozen'. */
  frozen: number;
  perMinute: number;
}

export interface ProbeFleetUpdateResult {
  queued: number;
  targets: number;
  frozen: number;
  perMinute: number;
  latestVersion: string | null;
}

export const probeApi = {
  // ── Install info ──────────────────────────────────────────────────────────

  installInfo: (): Promise<ProbeInstallInfo> =>
    apiClient.get('/probe/install-info').then((r: AxiosResponse) => {
      const data = r.data as { serverUrl?: unknown } | undefined;
      return { serverUrl: typeof data?.serverUrl === 'string' && data.serverUrl ? data.serverUrl : null };
    }),

  // ── API Keys ──────────────────────────────────────────────────────────────

  listKeys: (): Promise<{ keys: ProbeApiKey[] }> =>
    apiClient.get('/probe/keys').then((r: AxiosResponse) => r.data as { keys: ProbeApiKey[] }),

  createKey: (name: string, defaultSiteId?: number | null): Promise<{ key: ProbeApiKey }> =>
    apiClient
      .post('/probe/keys', { name, ...(defaultSiteId != null ? { defaultSiteId } : {}) })
      .then((r: AxiosResponse) => r.data as { key: ProbeApiKey }),

  /** Rename a key and / or set its default site (null clears it). */
  updateKey: (id: number, updates: { name?: string; defaultSiteId?: number | null }): Promise<{ key: ProbeApiKey }> =>
    apiClient.patch(`/probe/keys/${id}`, updates).then((r: AxiosResponse) => r.data as { key: ProbeApiKey }),

  deleteKey: (id: number): Promise<void> =>
    apiClient.delete(`/probe/keys/${id}`).then(() => undefined),

  // ── Probes ────────────────────────────────────────────────────────────────

  list: (): Promise<{ probes: Probe[] }> =>
    apiClient.get('/probe/devices').then((r: AxiosResponse) => r.data as { probes: Probe[] }),

  get: (id: number): Promise<{ probe: Probe }> =>
    apiClient.get(`/probe/devices/${id}`).then((r: AxiosResponse) => r.data as { probe: Probe }),

  update: (
    id: number,
    updates: Partial<{
      name: string;
      siteId: number | null;
      scanIntervalSeconds: number;
      scanConfig: ProbeScanConfig;
      scanConfigOverride: boolean;
      isPrimary: boolean;
    }>,
  ): Promise<{ probe: Probe }> =>
    apiClient.patch(`/probe/devices/${id}`, updates).then((r: AxiosResponse) => r.data as { probe: Probe }),

  /** Approve; `siteId` assigns that site, else a probe without a site gets its API key's default site. */
  approve: (id: number, siteId?: number): Promise<{ probe: Probe }> =>
    apiClient
      .post(`/probe/devices/${id}/approve`, siteId != null ? { siteId } : {})
      .then((r: AxiosResponse) => r.data as { probe: Probe }),

  refuse: (id: number): Promise<void> =>
    apiClient.post(`/probe/devices/${id}/refuse`).then(() => undefined),

  suspend: (id: number): Promise<{ probe: Probe }> =>
    apiClient.post(`/probe/devices/${id}/suspend`).then((r: AxiosResponse) => r.data as { probe: Probe }),

  unsuspend: (id: number): Promise<{ probe: Probe }> =>
    apiClient.post(`/probe/devices/${id}/unsuspend`).then((r: AxiosResponse) => r.data as { probe: Probe }),

  /**
   * delivered: sent over the WebSocket now; false: queued until the probe's
   * next push. 409 {error:'probe_not_approved'} for refused / suspended probes.
   */
  sendCommand: (id: number, command: ProbeCommandName | string): Promise<{ delivered: boolean }> =>
    apiClient
      .post(`/probe/devices/${id}/command`, { command })
      .then((r: AxiosResponse) => ({ delivered: Boolean((r.data as { delivered?: boolean } | undefined)?.delivered) })),

  /** Cancel the queued command (and a pending uninstall). */
  cancelCommand: (id: number): Promise<{ cancelled: string | null; uninstallCleared?: boolean }> =>
    apiClient
      .delete(`/probe/devices/${id}/command`)
      .then((r: AxiosResponse) => r.data as { cancelled: string | null; uninstallCleared?: boolean }),

  remove: (id: number): Promise<void> =>
    apiClient.delete(`/probe/devices/${id}`).then(() => undefined),

  // ── Effective Config ─────────────────────────────────────────────────────

  /** The settings chain resolved for the probe (probe-level settings panel). */
  getEffectiveConfig: (id: number): Promise<ResolvedSettings> =>
    apiClient.get(`/probe/devices/${id}/effective-config`).then((r: AxiosResponse) => (r.data as { data: ResolvedSettings }).data),

  /**
   * The scan config exactly as the probe receives it, with the source of each
   * value ('probe' while it overrides the settings chain). Null from a server
   * that does not return it yet.
   */
  getEffectiveScanConfig: (id: number): Promise<ProbeEffectiveScanConfig | null> =>
    apiClient.get(`/probe/devices/${id}/effective-config`).then((r: AxiosResponse) => {
      const effective = (r.data as { effective?: ProbeEffectiveScanConfig } | undefined)?.effective;
      return effective && typeof effective === 'object' && effective.config ? effective : null;
    }),

  // ── Bulk ──────────────────────────────────────────────────────────────────

  /** Creates (or reuses by name) one site per entry and attaches its probes (probes.manage + sites.manage). */
  createSites: (body: {
    groupId: number | null;
    approvePending: boolean;
    sites: Array<{ name: string; probeIds: number[]; primaryProbeId: number }>;
  }): Promise<{ sites: Array<{ siteId: number; name: string; created: boolean; probeIds: number[]; primaryProbeId: number }> }> =>
    apiClient.post('/probe/devices/create-sites', body).then((r: AxiosResponse) => r.data),

  bulk: (action: ProbeBulkAction | string, ids: number[]): Promise<ProbeBulkResult> =>
    apiClient.post('/probe/devices/bulk', { action, ids }).then((r: AxiosResponse) => r.data as ProbeBulkResult),

  // ── Fleet versions (probes.manage) ────────────────────────────────────────

  /** Version distribution of the approved probes. */
  fleetVersions: (): Promise<ProbeVersionDistribution> =>
    apiClient.get('/probe/fleet/versions').then((r: AxiosResponse) => (r.data as { data: ProbeVersionDistribution }).data),

  /** The outdated probes "Update outdated probes" would update (nothing is sent). */
  previewUpdateOutdated: (perMinute?: number): Promise<ProbeFleetUpdatePreview> =>
    apiClient
      .post('/probe/fleet/update-outdated', { dryRun: true, ...(perMinute ? { perMinute } : {}) })
      .then((r: AxiosResponse) => (r.data as { data: ProbeFleetUpdatePreview }).data),

  /** Queue the 'update' command for every outdated probe, `perMinute` at most per minute. */
  updateOutdated: (perMinute: number): Promise<ProbeFleetUpdateResult> =>
    apiClient
      .post('/probe/fleet/update-outdated', { perMinute })
      .then((r: AxiosResponse) => (r.data as { data: ProbeFleetUpdateResult }).data),

  /** Stop the paced rollout (commands already sent stay sent). */
  cancelUpdateOutdated: (): Promise<{ cancelled: number }> =>
    apiClient.delete('/probe/fleet/update-outdated').then((r: AxiosResponse) => (r.data as { data: { cancelled: number } }).data),
};
