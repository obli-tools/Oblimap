import apiClient from './client';

/** GET /api/tenants/locate-site/:id: the tenant of a site the user may read. */
export interface SiteLocation {
  siteId: number;
  tenantId: number;
  tenantName: string;
  /** The session's tenant when the server answered (null when none). */
  currentTenantId: number | null;
}

/**
 * Locates a site across the user's tenants (shared deep links). null when the
 * site is unknown or not readable by the user: the server answers the same
 * 404 for both. Other failures (network, 429) reject.
 */
export async function locateSite(siteId: number): Promise<SiteLocation | null> {
  try {
    const res = await apiClient.get<{ data: SiteLocation }>(`/tenants/locate-site/${siteId}`);
    return res.data.data;
  } catch (err) {
    if ((err as { response?: { status?: number } } | null)?.response?.status === 404) return null;
    throw err;
  }
}
