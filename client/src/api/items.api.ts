import apiClient from './client';
import type {
  DeviceType,
  FlowPeriod,
  IpReservation,
  ItemIpHistory,
  ItemStatus,
  NetworkFlow,
  SiteItem,
} from '@oblimap/shared';
import type { AxiosResponse } from 'axios';

// Tenant-wide devices (GET /api/items…). Every answer is limited to the sites
// the user may read: a site / group filter the user cannot read gives an
// empty list, an item of such a site a 404.

export type ItemSortKey = 'ip' | 'name' | 'lastSeen' | 'firstSeen' | 'site';

/** GET /api/items filters (all optional; lists are sent comma-separated). */
export interface ItemListParams {
  /** IP, MAC (with or without separators), hostname, name, vendor, notes — ≤ 100 chars. */
  q?: string;
  status?: ItemStatus[];
  type?: DeviceType[];
  vendor?: string;
  siteId?: number;
  groupId?: number;
  /** '24h', '7d' or an ISO date: first seen since. */
  new?: string;
  /** Reservation conflict or unresolved IP takeover alert. */
  conflict?: boolean;
  /** A device check currently fails. */
  checks?: 'failing';
  /** No name, unknown type, IP not reserved. */
  undocumented?: boolean;
  /** Not seen for this many days. */
  stale?: number;
  sort?: ItemSortKey;
  dir?: 'asc' | 'desc';
  page?: number;
  /** Default 50, max 200. */
  pageSize?: number;
}

/** A device of the tenant-wide list: the site item and where it is. */
export type ItemListEntry = SiteItem & {
  siteName: string;
  groupId: number | null;
  hasFailingCheck: boolean;
};

export interface ItemListResponse {
  items: ItemListEntry[];
  total: number;
  page: number;
  pageSize: number;
  /** Counts over the filtered set, each ignoring its own filter. */
  facets: {
    status: Partial<Record<ItemStatus, number>>;
    type: Partial<Record<DeviceType, number>>;
  };
}

export interface ItemDetailResponse {
  item: ItemListEntry;
  site: { id: number; name: string; groupId: number | null };
  /** The probe that discovered it (tenant's). */
  probe: { id: number; name: string } | null;
  /** The reservation of its IP on its site, with its state. */
  reservation: IpReservation | null;
  /** Other readable sites where the same MAC appears. */
  otherSites: Array<{ siteId: number; siteName: string; itemId: number }>;
}

export type ItemBulkRequest =
  | { siteId: number; ids: number[]; action: 'delete'; params?: Record<string, never> }
  | { siteId: number; ids: number[]; action: 'setType'; params: { deviceType: DeviceType } }
  | { siteId: number; ids: number[]; action: 'reserve'; params?: { description?: string | null } };

export interface ItemBulkResponse {
  affected: number;
  /** Ids that are not devices of that site (other site / tenant, deleted). */
  ignored: number;
  /** reserve: IP already reserved, not IPv4, or twice in the selection. */
  skipped?: number;
  /** delete: flows removed with the devices. */
  flowsDeleted?: number;
}

/** Query string of the list: arrays comma-joined, booleans as 1, empty values left out. */
function listQuery(params: ItemListParams): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params) as Array<[string, unknown]>) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value.join(',');
    } else if (value === true) {
      out[key] = 1;
    } else if (typeof value === 'string' || typeof value === 'number') {
      out[key] = value;
    }
  }
  return out;
}

export const itemsApi = {
  list: (params: ItemListParams = {}, signal?: AbortSignal): Promise<ItemListResponse> =>
    apiClient.get('/items', { params: listQuery(params), signal })
      .then((r: AxiosResponse) => r.data as ItemListResponse),

  get: (id: number): Promise<ItemDetailResponse> =>
    apiClient.get(`/items/${id}`).then((r: AxiosResponse) => r.data as ItemDetailResponse),

  /** IP history of the item's MAC on its site, newest first ([] without a MAC). */
  ipHistory: (id: number): Promise<{ history: ItemIpHistory[] }> =>
    apiClient.get(`/items/${id}/ip-history`).then((r: AxiosResponse) => r.data as { history: ItemIpHistory[] }),

  /** Flows of the site involving the item's IP over the period. */
  flows: (id: number, period: FlowPeriod = '24h'): Promise<{ flows: NetworkFlow[] }> =>
    apiClient.get(`/items/${id}/flows`, { params: { period } })
      .then((r: AxiosResponse) => r.data as { flows: NetworkFlow[] }),

  /** Bulk action on devices of one site (site write; at most 1000 ids). */
  bulk: (body: ItemBulkRequest): Promise<ItemBulkResponse> =>
    apiClient.post('/items/bulk', body).then((r: AxiosResponse) => r.data as ItemBulkResponse),
};
