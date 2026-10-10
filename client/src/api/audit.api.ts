import apiClient from './client';
import type { AuditLogEntry } from '@oblimap/shared';
import type { AxiosResponse } from 'axios';

export interface AuditListParams {
  /** Cursor: the previous page's nextCursor (only entries with a smaller id). */
  before?: number;
  /** Page size, 1..200 (server default 50). */
  limit?: number;
  /** Action prefix: 'probe.' matches every probe action, 'auth.login' also matches 'auth.login_failed'. */
  action?: string;
  resourceType?: string;
  userId?: number;
}

export interface AuditListResponse {
  items: AuditLogEntry[];
  /** Pass as `before` to fetch the next (older) page; null when there is none. */
  nextCursor: number | null;
}

/** Drops empty filters so the server never sees `?action=&resourceType=`. */
function toQuery(params: AuditListParams & { tenantId?: number }): Record<string, string | number> {
  const q: Record<string, string | number> = {};
  if (params.before !== undefined) q.before = params.before;
  if (params.limit !== undefined) q.limit = params.limit;
  if (params.action?.trim()) q.action = params.action.trim();
  if (params.resourceType) q.resourceType = params.resourceType;
  if (params.userId !== undefined) q.userId = params.userId;
  if (params.tenantId !== undefined) q.tenantId = params.tenantId;
  return q;
}

function toResponse(r: AxiosResponse): AuditListResponse {
  const data = r.data as Partial<AuditListResponse> | undefined;
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    nextCursor: typeof data?.nextCursor === 'number' ? data.nextCursor : null,
  };
}

export const auditApi = {
  /** Entries of the current tenant, newest first (admin only). */
  list: (params: AuditListParams = {}): Promise<AuditListResponse> =>
    apiClient.get('/audit', { params: toQuery(params) }).then(toResponse),

  /**
   * Every tenant, including platform events that have no tenant (failed
   * logins, SSO sync). Platform admins only; `tenantId` narrows to one tenant.
   */
  listAll: (params: AuditListParams & { tenantId?: number } = {}): Promise<AuditListResponse> =>
    apiClient.get('/audit/all', { params: toQuery(params) }).then(toResponse),
};
