import apiClient from './client';
import type { Tunnel, TunnelListEntry, TunnelListStatus, TunnelProxyAccess, TunnelScheme } from '@oblimap/shared';
import type { AxiosResponse } from 'axios';

// A tunnel of the supervision list (GET /tunnel): raw names, anonymize before display.
export type { TunnelListEntry, TunnelListStatus };
export type { TunnelProxyAccess, TunnelScheme };

/** Answer of POST /tunnel: the tunnel and, once active, a web proxy link for the opener. */
export interface OpenTunnelResult {
  tunnel: Tunnel;
  proxy: TunnelProxyAccess | null;
}

export interface TunnelListParams {
  /** 'active' (default): open tunnels; 'closed': finished ones, newest closed first. */
  status?: TunnelListStatus;
  /** Closed: default 50, max 200. */
  limit?: number;
}

export const tunnelApi = {
  open: (
    siteId: number,
    targetIp: string,
    targetPort: number,
    probeId?: number | null,
    scheme?: TunnelScheme,
  ): Promise<OpenTunnelResult> =>
    apiClient
      .post('/tunnel', { siteId, targetIp, targetPort, probeId, ...(scheme ? { scheme } : {}) })
      .then((r: AxiosResponse) => {
        const data = r.data as { tunnel: Tunnel; proxy?: TunnelProxyAccess | null };
        return { tunnel: data.tunnel, proxy: data.proxy ?? null };
      }),

  /**
   * A new web proxy link for an open tunnel (its opener only); `scheme`
   * switches what the probe speaks to the device. The link expires with the tunnel.
   */
  proxyAccess: (id: string, scheme?: TunnelScheme): Promise<TunnelProxyAccess> =>
    apiClient
      .post(`/tunnel/${id}/proxy-access`, scheme ? { scheme } : {})
      .then((r: AxiosResponse) => (r.data as { proxy: TunnelProxyAccess }).proxy),

  /** Full access: every tunnel of the tenant; otherwise the requester's own. */
  list: (params: TunnelListParams = {}): Promise<{ tunnels: TunnelListEntry[] }> =>
    apiClient
      .get('/tunnel', { params })
      .then((r: AxiosResponse) => r.data as { tunnels: TunnelListEntry[] }),

  get: (id: string): Promise<{ tunnel: Tunnel }> =>
    apiClient.get(`/tunnel/${id}`).then((r: AxiosResponse) => r.data as { tunnel: Tunnel }),

  close: (id: string): Promise<void> =>
    apiClient.delete(`/tunnel/${id}`).then(() => undefined),
};
