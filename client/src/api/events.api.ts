import apiClient from './client';
import type { ItemAlertMode, ItemEventKind, ItemEventsResult, SiteItem } from '@oblimap/shared';
import type { AxiosResponse } from 'axios';

// Device event history (site_item_events, migration 052). Every answer is
// limited to the sites the user may read: a site / group filter the user
// cannot read lists nothing, an item of such a site answers 404. The server
// caps the window at 30 days and `limit` at 500; `truncated` says older
// matching events were left out.

export interface ItemEventsParams {
  siteId?: number;
  /** The group and its sub-groups. */
  groupId?: number;
  /** Empty or absent = every kind. */
  kinds?: ItemEventKind[];
  /** ISO dates; default window: the last 24 h (list) / 30 days (one device). */
  from?: string;
  to?: string;
  /** Default 200 on the server, max 500. */
  limit?: number;
}

/** Query string: kinds comma-joined, empty values left out. */
function eventsQuery(params: ItemEventsParams): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (params.siteId !== undefined) out.siteId = params.siteId;
  if (params.groupId !== undefined) out.groupId = params.groupId;
  if (params.kinds && params.kinds.length > 0) out.kinds = params.kinds.join(',');
  if (params.from) out.from = params.from;
  if (params.to) out.to = params.to;
  if (params.limit !== undefined) out.limit = params.limit;
  return out;
}

export const eventsApi = {
  /** GET /api/items/events: events of the readable sites, newest first. */
  list: (params: ItemEventsParams = {}, signal?: AbortSignal): Promise<ItemEventsResult> =>
    apiClient.get('/items/events', { params: eventsQuery(params), signal })
      .then((r: AxiosResponse) => r.data as ItemEventsResult),

  /** GET /api/items/:id/events: history of one device, newest first. */
  forItem: (
    itemId: number,
    params: Omit<ItemEventsParams, 'siteId' | 'groupId'> = {},
    signal?: AbortSignal,
  ): Promise<ItemEventsResult> =>
    apiClient.get(`/items/${itemId}/events`, { params: eventsQuery(params), signal })
      .then((r: AxiosResponse) => r.data as ItemEventsResult),

  /**
   * Offline / back-online alert mode of a device (PATCH
   * /api/sites/:siteId/items/:itemId {alertMode}; site write).
   */
  setAlertMode: (siteId: number, itemId: number, alertMode: ItemAlertMode): Promise<{ item: SiteItem }> =>
    apiClient.patch(`/sites/${siteId}/items/${itemId}`, { alertMode })
      .then((r: AxiosResponse) => r.data as { item: SiteItem }),
};
