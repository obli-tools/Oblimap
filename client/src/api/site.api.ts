import apiClient from './client';
import type { Site, SiteItem, IpReservation, DeviceType, NetworkFlow, FlowPeriod, ItemAlertMode } from '@oblimap/shared';
import type { AxiosResponse } from 'axios';

/** A site of the list, with its counters (onlineProbeCount: approved probes not declared offline). */
export type SiteListItem = Site & { onlineProbeCount?: number };

/**
 * A probe of a site (GET /sites/:id/probes, site read). ip / ips / mac are
 * sent to full-access users only.
 */
export interface SiteProbe {
  id: number;
  /** Display name, else hostname. */
  name: string;
  /** Server liveness verdict (null: not approved). */
  online: boolean | null;
  offlineSince: string | null;
  lastSeenAt: string | null;
  isPrimary: boolean;
  probeVersion: string | null;
  wsConnected: boolean;
  ip?: string | null;
  ips?: string[];
  mac?: string | null;
}

/** A probe a tunnel of the site can go through (GET /sites/:id/tunnel-probes). */
export interface TunnelProbe {
  id: number;
  name: string;
  isPrimary?: boolean;
  wsConnected: boolean;
}

export const siteApi = {
  // ── Sites ─────────────────────────────────────────────────────────────────

  /**
   * Sites the user may read. groupId: the sites of that group (direct
   * children; with includeDescendants, also those of its sub-groups).
   */
  list: (params?: { groupId?: number; includeDescendants?: boolean; ungrouped?: boolean }): Promise<{ sites: SiteListItem[] }> =>
    apiClient.get('/sites', { params }).then((r: AxiosResponse) => r.data as { sites: SiteListItem[] }),

  get: (id: number): Promise<{ site: Site }> =>
    apiClient.get(`/sites/${id}`).then((r: AxiosResponse) => r.data as { site: Site }),

  create: (data: { name: string; description?: string | null; groupId?: number | null }): Promise<{ site: Site }> =>
    apiClient.post('/sites', data).then((r: AxiosResponse) => r.data as { site: Site }),

  update: (
    id: number,
    data: Partial<{ name: string; description: string | null; groupId: number | null }>,
  ): Promise<{ site: Site }> =>
    apiClient.patch(`/sites/${id}`, data).then((r: AxiosResponse) => r.data as { site: Site }),

  remove: (id: number): Promise<void> =>
    apiClient.delete(`/sites/${id}`).then(() => undefined),

  // ── Probes of the site ────────────────────────────────────────────────────

  probes: (id: number): Promise<{ probes: SiteProbe[] }> =>
    apiClient.get(`/sites/${id}/probes`).then((r: AxiosResponse) => r.data as { probes: SiteProbe[] }),

  /** Asks the site's probes to scan now (site write; once per site and minute, 429 otherwise). */
  /** skipped = probes with another command queued (uninstall / update), left untouched. */
  rescan: (id: number): Promise<{ sent: number; queued: number; skipped?: number }> =>
    apiClient.post(`/sites/${id}/rescan`)
      .then((r: AxiosResponse) => r.data as { sent: number; queued: number; skipped?: number }),

  /** Probes a tunnel of the site can use (site write + tunnels.use). */
  tunnelProbes: (id: number): Promise<{ probes: TunnelProbe[] }> =>
    apiClient.get(`/sites/${id}/tunnel-probes`).then((r: AxiosResponse) => r.data as { probes: TunnelProbe[] }),

  // ── Items ─────────────────────────────────────────────────────────────────

  listItems: (siteId: number): Promise<{ items: SiteItem[] }> =>
    apiClient.get(`/sites/${siteId}/items`).then((r: AxiosResponse) => r.data as { items: SiteItem[] }),

  createItem: (
    siteId: number,
    data: { ip: string; mac?: string | null; customName?: string | null; deviceType?: DeviceType; notes?: string | null },
  ): Promise<{ item: SiteItem }> =>
    apiClient.post(`/sites/${siteId}/items`, data).then((r: AxiosResponse) => r.data as { item: SiteItem }),

  updateItem: (
    siteId: number,
    itemId: number,
    data: Partial<{ customName: string | null; deviceType: DeviceType; notes: string | null; status: SiteItem['status']; alertMode: ItemAlertMode }>,
  ): Promise<{ item: SiteItem }> =>
    apiClient.patch(`/sites/${siteId}/items/${itemId}`, data).then((r: AxiosResponse) => r.data as { item: SiteItem }),

  removeItem: (siteId: number, itemId: number): Promise<void> =>
    apiClient.delete(`/sites/${siteId}/items/${itemId}`).then(() => undefined),

  removeSubnet: (siteId: number, prefix: string): Promise<{ deleted: number }> =>
    apiClient.delete(`/sites/${siteId}/items-by-subnet`, { params: { prefix } })
      .then((r: AxiosResponse) => r.data as { deleted: number }),

  // ── Reservations ──────────────────────────────────────────────────────────

  listReservations: (siteId: number): Promise<{ reservations: IpReservation[] }> =>
    apiClient.get(`/sites/${siteId}/reservations`).then((r: AxiosResponse) => r.data as { reservations: IpReservation[] }),

  /**
   * Reserve an IP (site write). reservedMac / itemId: the device it is
   * reserved for (an item of this site; the server fills reservedMac from
   * it when absent). The answer carries the reservation's `state`.
   */
  createReservation: (
    siteId: number,
    data: {
      ip: string;
      name: string;
      description?: string | null;
      deviceType?: DeviceType | null;
      reservedMac?: string | null;
      itemId?: number | null;
    },
  ): Promise<{ reservation: IpReservation }> =>
    apiClient.post(`/sites/${siteId}/reservations`, data).then((r: AxiosResponse) => r.data as { reservation: IpReservation }),

  /** null clears reservedMac / itemId; absent keeps them. */
  updateReservation: (
    siteId: number,
    resId: number,
    data: Partial<{
      name: string;
      description: string | null;
      deviceType: DeviceType | null;
      reservedMac: string | null;
      itemId: number | null;
    }>,
  ): Promise<{ reservation: IpReservation }> =>
    apiClient.patch(`/sites/${siteId}/reservations/${resId}`, data).then((r: AxiosResponse) => r.data as { reservation: IpReservation }),

  removeReservation: (siteId: number, resId: number): Promise<void> =>
    apiClient.delete(`/sites/${siteId}/reservations/${resId}`).then(() => undefined),

  // ── Flows ────────────────────────────────────────────────────────────────

  listFlows: (siteId: number, period: FlowPeriod = '24h'): Promise<{ flows: NetworkFlow[] }> =>
    apiClient.get(`/sites/${siteId}/flows`, { params: { period } })
      .then((r: AxiosResponse) => r.data as { flows: NetworkFlow[] }),

  clearFlows: (siteId: number): Promise<{ deleted: number }> =>
    apiClient.delete(`/sites/${siteId}/flows`)
      .then((r: AxiosResponse) => r.data as { deleted: number }),
};
