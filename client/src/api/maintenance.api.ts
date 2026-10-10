import apiClient from './client';
import type { AxiosResponse } from 'axios';

/** Maintenance windows (server routes/maintenance.routes.ts). */

export type MaintenanceScope = 'tenant' | 'group' | 'site';
export type MaintenanceKind = 'one_time' | 'recurring';
export type MaintenanceDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface MaintenanceRecurrence {
  days: MaintenanceDay[];
  /** 'HH:MM' local start. */
  start: string;
  /** 'HH:MM' local end ('24:00' = end of the day); before start = crosses midnight. */
  end: string;
}

export interface MaintenanceWindow {
  id: number;
  uuid: string;
  tenantId: number;
  name: string;
  scope: MaintenanceScope;
  scopeId: number | null;
  /** Name of the scoped group / site (null for 'tenant', or when it was deleted). */
  scopeName: string | null;
  kind: MaintenanceKind;
  startsAt: string | null;
  endsAt: string | null;
  recurrence: MaintenanceRecurrence | null;
  timezone: string;
  enabled: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  /** Active when the server answered. */
  active: boolean;
  /** Whether the caller may edit / delete it (list and get answers only). */
  canEdit?: boolean;
}

export interface MaintenanceWindowInput {
  name: string;
  scope: MaintenanceScope;
  scopeId: number | null;
  kind: MaintenanceKind;
  startsAt: string | null;
  endsAt: string | null;
  recurrence: MaintenanceRecurrence | null;
  timezone: string;
  enabled: boolean;
}

/** The editable fields of a stored window (PUT takes the full body). */
export function windowInputOf(w: MaintenanceWindow): MaintenanceWindowInput {
  return {
    name: w.name,
    scope: w.scope,
    scopeId: w.scopeId,
    kind: w.kind,
    startsAt: w.startsAt,
    endsAt: w.endsAt,
    recurrence: w.recurrence,
    timezone: w.timezone,
    enabled: w.enabled,
  };
}

export const maintenanceApi = {
  /** Windows of the tenant the user can see ('settings' capability). */
  list: (): Promise<MaintenanceWindow[]> =>
    apiClient.get('/maintenance').then((r: AxiosResponse) => (r.data as { windows: MaintenanceWindow[] }).windows),

  /** Windows active now for a site (site readers). */
  activeForSite: (siteId: number): Promise<MaintenanceWindow[]> =>
    apiClient.get('/maintenance/active', { params: { siteId } })
      .then((r: AxiosResponse) => (r.data as { windows: MaintenanceWindow[] }).windows),

  create: (data: MaintenanceWindowInput): Promise<MaintenanceWindow> =>
    apiClient.post('/maintenance', data).then((r: AxiosResponse) => (r.data as { window: MaintenanceWindow }).window),

  update: (id: number, data: MaintenanceWindowInput): Promise<MaintenanceWindow> =>
    apiClient.put(`/maintenance/${id}`, data).then((r: AxiosResponse) => (r.data as { window: MaintenanceWindow }).window),

  remove: (id: number): Promise<void> =>
    apiClient.delete(`/maintenance/${id}`).then(() => undefined),
};
