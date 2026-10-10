// ============================================
// Tunnels — web proxy through the probe (HTTP relay)
// ============================================
//
// A tunnel's data WebSocket (/api/probe/ws/tunnel/<id>) carries either the
// legacy raw TCP stream (older probes) or, with probes that announce it, the
// multiplexed HTTP relay: every browser request is its own stream, the probe
// is an HTTP(S) client pinned to the tunnel's target IP. See
// probe/tunnel_http.go for the frame layout.

/** Probe capability (hello / push `capabilities`): the probe has the HTTP relay. */
export const TUNNEL_HTTP_CAPABILITY = 'tunnel_http:1';

/** Feature announced by the probe in `tunnel_hello` on the data socket. */
export const TUNNEL_HTTP_FEATURE = 'http:1';

/** Text frames of the tunnel data socket in HTTP relay mode. */
export const TUNNEL_DATA_MESSAGES = {
  // probe → server
  HELLO: 'tunnel_hello',
  HTTP_RES: 'http_res',
  HTTP_END: 'http_end',
  // server → probe
  MODE: 'tunnel_mode',
  HTTP_REQ: 'http_req',
  HTTP_REQ_END: 'http_req_end',
  HTTP_CREDIT: 'http_credit',
  HTTP_CANCEL: 'http_cancel',
} as const;

/** Scheme the probe speaks to the device: 'auto' guesses from the port, then follows the device. */
export type TunnelScheme = 'auto' | 'http' | 'https';
export const TUNNEL_SCHEMES: readonly TunnelScheme[] = ['auto', 'http', 'https'];

/**
 * Where the device is served:
 * - 'isolated': on the Oblimap origin under /api/tunnel/p/<token>/, in a
 *   sandboxed opaque origin (device scripts cannot reach Oblimap; device
 *   cookie logins may not work);
 * - 'origin': on the dedicated TUNNEL_ORIGIN host (no Oblimap cookie
 *   there), without sandbox: device cookies and storage work.
 */
export type TunnelProxyMode = 'isolated' | 'origin';

/**
 * How the tunnel's probe relays HTTP: 'http' = multiplexed relay (full web
 * access, HTTPS devices), 'legacy' = older probe with one raw TCP stream
 * (update the probe for full web access), 'pending' = not known yet.
 */
export type TunnelRelayMode = 'http' | 'legacy' | 'pending';

/** POST /api/tunnel/:id/proxy-access (and `proxy` in the open answer). */
export interface TunnelProxyAccess {
  /** Absolute or root-relative URL of the device's web UI; it expires with the tunnel. */
  url: string;
  mode: TunnelProxyMode;
  relay: TunnelRelayMode;
  scheme: TunnelScheme;
}

/** Diagnostic codes of a failed proxied request (shown on the proxy's error page). */
export type TunnelProxyErrorCode =
  | 'connection_refused'
  | 'connection_closed'
  | 'timeout'
  | 'unreachable'
  | 'tls_failed'
  | 'tls_required'
  | 'tls_not_supported'
  | 'legacy_tls_required'
  | 'redirect_other_host'
  | 'target_not_allowed'
  | 'too_many_streams'
  | 'request_too_large'
  | 'response_too_large'
  | 'tunnel_closed'
  | 'bad_request'
  | 'request_failed';
