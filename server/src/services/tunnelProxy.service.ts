/**
 * Web proxy through a probe tunnel.
 *
 * The browser opens the device's web UI at /api/tunnel/p/<token>/... — on the
 * Oblimap origin ('isolated' mode) or on the dedicated TUNNEL_ORIGIN host
 * ('origin' mode). Every request, sub-resources included, is authorized by
 * the unguessable per-tunnel proxy token in its path (bound to the tunnel,
 * the user who asked for it and the tenant; revoked when the tunnel closes),
 * never by the Oblimap session — the session cookie is never forwarded to the
 * device, and in 'isolated' mode the device's documents run in a sandboxed
 * opaque origin that cannot use it.
 *
 * Relay: probes with the HTTP relay (tunnel_hello {features:['http:1']} on
 * the data socket) carry one stream per request (TunnelHttpChannel, frame
 * layout in probe/tunnel_http.go): concurrent sub-resources, keep-alive,
 * HTTPS devices, Basic auth. Older probes keep the legacy single TCP stream,
 * one request at a time (legacyExchange).
 *
 * Responses: header allowlist; Location / Content-Location and same-device
 * URLs in HTML / CSS rewritten under the proxy prefix (another scheme / port
 * of the same device as /~o/<scheme>/<port>/...); device cookies kept under
 * the prefix; a small script in HTML pages maps the root-relative URLs that
 * device scripts build at run time. Failures answer a diagnostic page.
 *
 * Limitation: WebSocket upgrades of device pages are not relayed (the
 * server's upgrade dispatcher only serves probe sockets); pages that need
 * one load, their live parts do not.
 *
 * Mounting (outside the session-authenticated tenant router):
 * routes/index.ts mounts tunnelProxyRouter (tunnel.routes.ts) at /tunnel/p,
 * and app.ts mounts tunnelOriginGuard first so that the TUNNEL_ORIGIN host
 * reaches nothing but the proxy. app.ts also wraps its app-wide cors() and
 * express.json() in skipForTunnelProxy: cors() would answer the device
 * page's preflights itself (without Access-Control-Allow-Origin: null) and
 * express.json() would cap / re-serialise device bodies.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { IncomingHttpHeaders } from 'http';
import type WebSocket from 'ws';
import {
  TUNNEL_DATA_MESSAGES,
  TUNNEL_HTTP_FEATURE,
  type TunnelProxyAccess,
  type TunnelProxyErrorCode,
  type TunnelProxyMode,
  type TunnelRelayMode,
  type TunnelScheme,
} from '@oblimap/shared';
import { db } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { clientIp } from '../utils/clientIp';
import { auditService } from './audit.service';
import { permissionService } from './permission.service';
import { onUserSessionsKilled } from './userSessions.service';
import {
  getTunnelDataWs,
  getTunnelDataInfo,
  markTunnelDataLegacy,
  onTunnelDataHello,
  sendTunnelData,
  setTunnelDataHandler,
  touchTunnelActivity,
  waitForTunnelDataHello,
} from './probeHub.service';

// ─── Limits ─────────────────────────────────────────────────────────────────

/** Request body relayed to the device (the probe accepts 8 MiB). */
export const PROXY_BODY_LIMIT = 8 * 1024 * 1024;
const PROXY_HEAD_LIMIT = 64 * 1024;
/** HTML / CSS bodies larger than this are relayed without rewriting. */
const REWRITE_LIMIT = 4 * 1024 * 1024;
/** No frame for a stream for this long ends it (504). */
const STREAM_IDLE_TIMEOUT_MS = 60_000;
/** Concurrent streams per tunnel (the probe's cap); further requests wait. */
const MAX_STREAMS_PER_TUNNEL = 16;
const MAX_STREAM_WAITERS = 64;
const STREAM_SLOT_WAIT_MS = 30_000;
/** Initial flow-control window of a stream (the probe's), and the most a probe may overrun it. */
const STREAM_WINDOW = 256 * 1024;
const STREAM_OVERRUN_LIMIT = 2 * STREAM_WINDOW;
/** Legacy probes attach the data socket just after reporting the tunnel ready. */
const DATA_WS_WAIT_MS = 8_000;
/** A data socket that sent no tunnel_hello within this delay belongs to a legacy probe. */
const HELLO_GRACE_MS = 2_000;
/** Proxy tokens: per tunnel, in total, absolute lifetime. */
const MAX_TOKENS_PER_TUNNEL = 8;
const MAX_TOKENS = 10_000;
const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Tunnel / user rights re-checked at most this often per token. */
const AUTH_RECHECK_MS = 5_000;
/** Requests per tunnel: sustained rate and burst. */
const RATE_PER_SEC = 50;
const RATE_BURST = 300;
/** Sampled audit of proxied requests: the first one, then one per window with the count. */
const AUDIT_SAMPLE_MS = 10 * 60 * 1000;

const PROXY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const TLS_PORTS = new Set([443, 8443, 4443, 9443]);

// ─── TUNNEL_ORIGIN (dedicated origin mode) ──────────────────────────────────

export interface TunnelOriginConfig {
  /** e.g. https://tunnel.oblimap.example.com (no path). */
  origin: string;
  /** Lower-case host name (cookies are isolated by host name, not port). */
  hostname: string;
}

function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Parses TUNNEL_ORIGIN. Empty → null (isolated mode). Refused (null + warning)
 * when it is not a bare http(s) origin, or when it names the host of the
 * Oblimap app itself: the dedicated origin only isolates the device from
 * Oblimap's cookies on another host name.
 */
export function parseTunnelOrigin(
  raw: string | undefined,
  mainOrigins: readonly string[],
): { config: TunnelOriginConfig | null; warning: string | null } {
  const value = (raw ?? '').trim();
  if (!value) return { config: null, warning: null };
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { config: null, warning: `TUNNEL_ORIGIN "${value}" is not a URL — the web proxy stays on the Oblimap origin (isolated mode)` };
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password
    || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    return { config: null, warning: `TUNNEL_ORIGIN must be a bare origin such as https://tunnel.oblimap.example.com — ignored (isolated mode)` };
  }
  const hostname = u.hostname.toLowerCase();
  for (const main of mainOrigins) {
    if (hostnameOf(main) === hostname) {
      return { config: null, warning: `TUNNEL_ORIGIN uses the host name of Oblimap itself (${hostname}) — ignored (isolated mode): it must be a separate host name` };
    }
  }
  const config: TunnelOriginConfig = { origin: u.origin, hostname };
  for (const main of mainOrigins) {
    const mainHost = hostnameOf(main);
    if (mainHost && sameSiteHosts(hostname, mainHost)) {
      // Device scripts run unsandboxed on the tunnel host: on the same site
      // they can set a cookie for the shared parent domain (Domain=...) that
      // shadows the Oblimap session cookie (forced sign-out / session
      // fixation), and Oblimap's Lax cookie rides on their same-site requests.
      return {
        config,
        warning: `TUNNEL_ORIGIN host ${hostname} shares its domain with Oblimap (${mainHost}): device pages there can set cookies `
          + `that reach Oblimap (session fixation / forced sign-out). Use a host on a separate registrable domain `
          + `(e.g. https://tunnel.example-devices.net), or leave TUNNEL_ORIGIN empty for the sandboxed mode`,
      };
    }
  }
  return { config, warning: null };
}

const IPV4_LITERAL_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Two host names on the same site, approximated without a public-suffix list:
 * one is the other or a sub-domain of it, or both share their last two labels
 * (tunnel.example.com / oblimap.example.com). IP literals never share cookies.
 */
export function sameSiteHosts(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/\.$/, '');
  const y = b.toLowerCase().replace(/\.$/, '');
  if (!x || !y) return false;
  if (IPV4_LITERAL_RE.test(x) || IPV4_LITERAL_RE.test(y) || x.includes(':') || y.includes(':')
    || x.startsWith('[') || y.startsWith('[')) return x === y;
  if (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)) return true;
  const xl = x.split('.');
  const yl = y.split('.');
  if (xl.length < 2 || yl.length < 2) return false;
  return xl.slice(-2).join('.') === yl.slice(-2).join('.');
}

let tunnelOriginCache: { config: TunnelOriginConfig | null } | null = null;

/** The dedicated tunnel origin, or null (isolated mode). Read once from the environment. */
export function tunnelOrigin(): TunnelOriginConfig | null {
  if (!tunnelOriginCache) {
    const parsed = parseTunnelOrigin(process.env.TUNNEL_ORIGIN, [...config.clientOrigins, config.appUrl]);
    if (parsed.warning) logger.warn(`[config] ${parsed.warning}`);
    tunnelOriginCache = { config: parsed.config };
  }
  return tunnelOriginCache.config;
}

/** Test hook: forget the cached TUNNEL_ORIGIN. */
export function resetTunnelOriginCache(): void {
  tunnelOriginCache = null;
}

export function tunnelProxyMode(): TunnelProxyMode {
  return tunnelOrigin() ? 'origin' : 'isolated';
}

/** Host name of a Host header ("a.example:8443" → "a.example", "[::1]:80" → "::1"). */
export function hostHeaderName(host: string | undefined): string {
  const h = (host ?? '').trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : h;
  }
  const colon = h.indexOf(':');
  return colon >= 0 ? h.slice(0, colon) : h;
}

/** The request was sent to the dedicated tunnel origin. */
export function isTunnelOriginHost(host: string | undefined, cfg: TunnelOriginConfig | null): boolean {
  return !!cfg && hostHeaderName(host) === cfg.hostname;
}

/** Path prefix of the proxy (the router is mounted there). */
export const PROXY_PATH_PREFIX = '/api/tunnel/p/';

/**
 * Host isolation of the dedicated origin (mount first in app.ts): requests
 * sent to TUNNEL_ORIGIN reach the proxy routes only — never the API, the
 * SPA or Socket.io.
 */
export function tunnelOriginGuard(req: Request, res: Response, next: NextFunction): void {
  const cfg = tunnelOrigin();
  if (!cfg || !isTunnelOriginHost(req.headers.host, cfg)) {
    next();
    return;
  }
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (path.startsWith(PROXY_PATH_PREFIX)) {
    next();
    return;
  }
  // A device page that escaped the URL rewriting (root-relative URL built by
  // its scripts: script.src, import(), workers…) lands here without the token:
  // route it to the tunnel the browser last opened on this host. The binding
  // cookie only exists on the dedicated tunnel host (no Oblimap cookie there),
  // and the token is re-checked by the proxy handler like any other request.
  const bound = readCookie(req.headers.cookie, TUNNEL_BINDING_COOKIE);
  const original = req.originalUrl || req.url || '/';
  if (bound && TOKEN_RE.test(bound) && original.startsWith('/') && !original.startsWith('//')) {
    const mapped = `${PROXY_PATH_PREFIX}${bound}${original}`;
    req.url = mapped;
    req.originalUrl = mapped;
    next();
    return;
  }
  res.status(404).setHeader('Cache-Control', 'no-store');
  res.type('text/plain').send('Not found');
}

/**
 * Wraps an app-wide middleware so that it skips the proxy paths (app.ts):
 * - cors(): it answers every OPTIONS itself (204, no
 *   Access-Control-Allow-Origin: null), so the sandboxed device page's
 *   preflights (JSON POST, PUT / DELETE, custom headers) never reached the
 *   proxy and the browser blocked them;
 * - express.json(): device bodies must reach the device byte for byte, up to
 *   PROXY_BODY_LIMIT (not 1 MiB, not re-serialised, no strict-mode 400), and
 *   a rejected body must not be logged with the token-bearing path.
 */
export function skipForTunnelProxy(mw: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const path = (req.originalUrl || req.url || '').split('?')[0];
    if (path.startsWith(PROXY_PATH_PREFIX)) {
      next();
      return;
    }
    mw(req, res, next);
  };
}

// ─── Proxy tokens ───────────────────────────────────────────────────────────

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface ProxyGrant {
  tunnelId: string;
  tenantId: number;
  userId: number;
  siteId: number;
  probeId: number;
  targetIp: string;
  targetPort: number;
  /** Names of the device (redirects to them are the device itself). */
  hostNames: string[];
  issuedAt: number;
}

interface StoredGrant extends ProxyGrant {
  digest: Buffer;
}

/** sha256(token) hex → grant. Only digests are kept. */
const grants = new Map<string, StoredGrant>();

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Issues a proxy token (32 random bytes, base64url) for the grant. */
export function issueProxyToken(grant: Omit<ProxyGrant, 'issuedAt'>): string {
  const token = randomBytes(32).toString('base64url');
  const digest = tokenDigest(token);
  // At most MAX_TOKENS_PER_TUNNEL per tunnel (the oldest goes) and MAX_TOKENS in all.
  const ofTunnel = [...grants.entries()].filter(([, g]) => g.tunnelId === grant.tunnelId)
    .sort((a, b) => a[1].issuedAt - b[1].issuedAt);
  while (ofTunnel.length >= MAX_TOKENS_PER_TUNNEL) grants.delete(ofTunnel.shift()![0]);
  if (grants.size >= MAX_TOKENS) {
    const oldest = [...grants.entries()].sort((a, b) => a[1].issuedAt - b[1].issuedAt);
    for (const [key] of oldest.slice(0, Math.ceil(MAX_TOKENS / 10))) grants.delete(key);
  }
  grants.set(digest.toString('hex'), { ...grant, hostNames: [...grant.hostNames], issuedAt: Date.now(), digest });
  return token;
}

/** The grant of a presented token, or null (malformed, unknown, revoked, expired). */
export function lookupProxyToken(token: unknown): ProxyGrant | null {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const digest = tokenDigest(token);
  const stored = grants.get(digest.toString('hex'));
  if (!stored || !timingSafeEqual(stored.digest, digest)) return null;
  if (Date.now() - stored.issuedAt > TOKEN_MAX_AGE_MS) {
    grants.delete(digest.toString('hex'));
    return null;
  }
  const { digest: _digest, ...grant } = stored;
  return grant;
}

export function revokeTunnelProxyTokens(tunnelId: string): void {
  for (const [key, g] of grants) if (g.tunnelId === tunnelId) grants.delete(key);
  for (const key of authChecked.keys()) if (key.startsWith(`${tunnelId}:`)) authChecked.delete(key);
}

export function revokeUserProxyTokens(userId: number): void {
  for (const [key, g] of grants) if (g.userId === userId) grants.delete(key);
}

function revokeUserProxyTokensForTunnel(tunnelId: string, userId: number): void {
  for (const [key, g] of grants) if (g.tunnelId === tunnelId && g.userId === userId) grants.delete(key);
  authChecked.delete(`${tunnelId}:${userId}`);
}

// A user whose sessions are killed (deactivated, deleted, demoted, tenant
// access removed, password changed) loses their proxy links at once.
onUserSessionsKilled((userId) => revokeUserProxyTokens(userId));

// ─── Per-tunnel relay options and HTTP channels ─────────────────────────────

export interface RelayOrigin {
  scheme: 'http' | 'https';
  port: number;
}

interface TunnelHttpOptions {
  scheme: TunnelScheme;
  hostNames: string[];
  targetPort: number;
}

const tunnelOptions = new Map<string, TunnelHttpOptions>();
const channels = new Map<string, TunnelHttpChannel>();

// ─── Web tunnel auto-release ────────────────────────────────────────────────
// Closing the device tab tells nobody: a web tunnel would stay open (and count
// against the per-user limit) until the 30 min inactivity expiry. Device pages
// served through the proxy send a keepalive every 45 s (proxyShimScript), so a
// web tunnel with no proxied request, no keepalive and no request in flight for
// WEB_TUNNEL_IDLE_MS is closed: about 3 minutes after its last tab went away.
// Pages that run no script still keep it alive with their own requests.
const WEB_KEEPALIVE_PATH = '/__oblimap/keepalive';
const WEB_TUNNEL_IDLE_MS = 3 * 60_000;
const WEB_REAPER_INTERVAL_MS = 30_000;
const webActivity = new Map<string, { at: number; tenantId: number }>();
let webReaper: ReturnType<typeof setInterval> | null = null;

function markWebActivity(tunnelId: string, tenantId: number): void {
  webActivity.set(tunnelId, { at: Date.now(), tenantId });
  if (!webReaper) {
    webReaper = setInterval(() => { void reapIdleWebTunnels(); }, WEB_REAPER_INTERVAL_MS);
    webReaper.unref?.();
  }
}

async function reapIdleWebTunnels(): Promise<void> {
  const now = Date.now();
  for (const [tunnelId, entry] of webActivity) {
    if (now - entry.at < WEB_TUNNEL_IDLE_MS) continue;
    if (channels.get(tunnelId)?.busy) continue; // a live stream is still relayed
    webActivity.delete(tunnelId);
    try {
      const { tunnelService } = await import('./tunnel.service');
      const result = await tunnelService.closeTunnel(tunnelId, entry.tenantId);
      revokeTunnelProxyTokens(tunnelId);
      if (result?.closed) logger.info({ tunnelId }, 'Web tunnel closed: no device page open any more');
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, tunnelId }, 'Web tunnel auto-release failed');
    }
  }
  if (webActivity.size === 0 && webReaper) {
    clearInterval(webReaper);
    webReaper = null;
  }
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*$/;

/** Device names usable as redirect hosts: the DNS name and its first label. */
export function deviceHostNames(hostname: string | null | undefined): string[] {
  const h = (hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!h || h.length > 253 || !HOSTNAME_RE.test(h)) return [];
  const short = h.split('.')[0];
  return short !== h ? [h, short] : [h];
}

export function isTunnelScheme(value: unknown): value is TunnelScheme {
  return value === 'auto' || value === 'http' || value === 'https';
}

/** Set before tunnel_open: what the probe receives in tunnel_mode. */
export function setTunnelHttpOptions(tunnelId: string, opts: TunnelHttpOptions): void {
  if (tunnelOptions.size >= 10_000) tunnelOptions.clear();
  tunnelOptions.set(tunnelId, { ...opts, hostNames: opts.hostNames.slice(0, 8) });
}

export function getTunnelScheme(tunnelId: string): TunnelScheme {
  return tunnelOptions.get(tunnelId)?.scheme ?? 'auto';
}

/** Changes the scheme of an open tunnel (TunnelDialog); applied by the probe at once. */
export function changeTunnelScheme(tunnelId: string, scheme: TunnelScheme): void {
  const opts = tunnelOptions.get(tunnelId);
  if (opts) opts.scheme = scheme;
  const channel = channels.get(tunnelId);
  if (channel && !channel.closed) {
    channel.base = null;
    sendTunnelData(tunnelId, JSON.stringify({
      type: TUNNEL_DATA_MESSAGES.MODE, mode: 'http', scheme, hostNames: opts?.hostNames ?? [],
    }));
  }
}

/** Everything the proxy holds for a tunnel goes when it closes. */
export function clearTunnelProxyState(tunnelId: string): void {
  revokeTunnelProxyTokens(tunnelId);
  tunnelOptions.delete(tunnelId);
  const channel = channels.get(tunnelId);
  if (channel) {
    channels.delete(tunnelId);
    channel.onClose();
  }
  legacyLocks.delete(tunnelId);
  rateBuckets.delete(tunnelId);
  auditSamples.delete(tunnelId);
}

/** How the tunnel relays HTTP right now. */
export function tunnelRelayMode(tunnelId: string): TunnelRelayMode {
  if (channels.has(tunnelId)) return 'http';
  const info = getTunnelDataInfo(tunnelId);
  if (!info) return 'pending';
  if (info.features !== null) return info.features.includes(TUNNEL_HTTP_FEATURE) ? 'http' : 'legacy';
  return Date.now() - info.attachedAt >= HELLO_GRACE_MS ? 'legacy' : 'pending';
}

/** Waits (bounded) until the relay mode of a freshly opened tunnel is known. */
export async function resolveTunnelRelayMode(tunnelId: string, maxWaitMs = HELLO_GRACE_MS): Promise<TunnelRelayMode> {
  const mode = tunnelRelayMode(tunnelId);
  if (mode !== 'pending') return mode;
  await waitForTunnelDataHello(tunnelId, maxWaitMs);
  return tunnelRelayMode(tunnelId);
}

// The probe announced itself on the data socket: HTTP relay when it can.
onTunnelDataHello((tunnelId, features) => {
  if (!features.includes(TUNNEL_HTTP_FEATURE)) return;
  const opts = tunnelOptions.get(tunnelId);
  const previous = channels.get(tunnelId);
  if (previous) previous.onClose();
  const channel = new TunnelHttpChannel(tunnelId, (data) => sendTunnelData(tunnelId, data));
  channels.set(tunnelId, channel);
  setTunnelDataHandler(tunnelId, {
    onMessage: (data, isBinary) => channel.onMessage(data, isBinary),
    onClose: () => {
      channel.onClose();
      if (channels.get(tunnelId) === channel) channels.delete(tunnelId);
    },
  });
  sendTunnelData(tunnelId, JSON.stringify({
    type: TUNNEL_DATA_MESSAGES.MODE,
    mode: 'http',
    scheme: opts?.scheme ?? 'auto',
    hostNames: opts?.hostNames ?? [],
  }));
});

export interface RelayHead {
  status: number;
  headers: Array<[string, string]>;
  /** Origin of the device the answer came from. */
  origin: RelayOrigin;
  /** The tunnel's current base origin (moves when the device redirects to https). */
  base: RelayOrigin;
}

export interface RelayFailure {
  code: TunnelProxyErrorCode;
  detail: string;
}

export interface StreamHandlers {
  onHead(head: RelayHead): void;
  /** `ack` once the chunk is consumed (flow control). */
  onData(chunk: Buffer, ack: () => void): void;
  onEnd(failure: RelayFailure | null): void;
}

interface StreamEntry {
  handlers: StreamHandlers;
  outstanding: number;
  gotHead: boolean;
}

export interface ChannelRequest {
  method: string;
  path: string;
  headers: Array<[string, string]>;
  origin: RelayOrigin | null;
}

const ERROR_CODE_RE = /^[a-z_]{1,40}$/;

function parseOrigin(value: unknown): RelayOrigin | null {
  if (!value || typeof value !== 'object') return null;
  const { scheme, port } = value as { scheme?: unknown; port?: unknown };
  if ((scheme !== 'http' && scheme !== 'https') || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { scheme, port };
}

function parseHeaderPairs(value: unknown): Array<[string, string]> | null {
  if (!Array.isArray(value) || value.length > 300) return null;
  const out: Array<[string, string]> = [];
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue;
    if (!HEADER_NAME_RE.test(pair[0]) || !HEADER_VALUE_OK_RE.test(pair[1]) || pair[1].length > 8192) continue;
    out.push([pair[0].toLowerCase(), pair[1]]);
  }
  return out;
}

/**
 * The multiplexed HTTP relay of one tunnel's data socket. Requests are
 * capped at MAX_STREAMS_PER_TUNNEL in flight (the probe's cap); further ones
 * wait their turn. Everything received from the probe is validated: nothing
 * it sends may throw out of the socket listener.
 */
export class TunnelHttpChannel {
  closed = false;
  /** Last base origin reported by the probe (null: unknown, use the tunnel's port). */
  base: RelayOrigin | null = null;
  private nextId = 1;
  private readonly streams = new Map<number, StreamEntry>();
  private active = 0;
  private readonly waiters: Array<(ok: boolean) => void> = [];

  constructor(readonly tunnelId: string, private readonly send: (data: string | Buffer) => boolean) {}

  /** A request is in flight (a live stream keeps an unattended tunnel alive). */
  get busy(): boolean {
    return this.active > 0;
  }

  /** Takes a stream slot, waiting up to `waitMs`; false when none came. */
  acquire(waitMs = STREAM_SLOT_WAIT_MS): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.active < MAX_STREAMS_PER_TUNNEL) {
      this.active += 1;
      return Promise.resolve(true);
    }
    if (this.waiters.length >= MAX_STREAM_WAITERS) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      }, waitMs);
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next && !this.closed) next(true); // the slot passes on
    else this.active = Math.max(0, this.active - 1);
  }

  /** Sends a request; the returned id names its stream (null: channel closed). */
  start(req: ChannelRequest, body: Buffer | null, handlers: StreamHandlers): number | null {
    if (this.closed) return null;
    const id = this.nextId;
    this.nextId = this.nextId >= 0x7fffffff ? 1 : this.nextId + 1;
    this.streams.set(id, { handlers, outstanding: 0, gotHead: false });
    const frame: Record<string, unknown> = {
      type: TUNNEL_DATA_MESSAGES.HTTP_REQ, id, method: req.method, path: req.path, headers: req.headers,
    };
    if (req.origin) {
      frame.scheme = req.origin.scheme;
      frame.port = req.origin.port;
    }
    let ok = this.send(JSON.stringify(frame));
    if (ok && body && body.length > 0) {
      for (let off = 0; ok && off < body.length; off += 32 * 1024) {
        const part = body.subarray(off, Math.min(body.length, off + 32 * 1024));
        const chunk = Buffer.allocUnsafe(4 + part.length);
        chunk.writeUInt32BE(id, 0);
        part.copy(chunk, 4);
        ok = this.send(chunk);
      }
    }
    if (ok) ok = this.send(JSON.stringify({ type: TUNNEL_DATA_MESSAGES.HTTP_REQ_END, id }));
    if (!ok) {
      this.streams.delete(id);
      return null;
    }
    return id;
  }

  cancel(id: number): void {
    if (!this.streams.delete(id)) return;
    this.send(JSON.stringify({ type: TUNNEL_DATA_MESSAGES.HTTP_CANCEL, id }));
  }

  private credit(id: number, bytes: number): void {
    const entry = this.streams.get(id);
    if (!entry) return;
    entry.outstanding = Math.max(0, entry.outstanding - bytes);
    this.send(JSON.stringify({ type: TUNNEL_DATA_MESSAGES.HTTP_CREDIT, id, bytes }));
  }

  private fail(id: number, failure: RelayFailure): void {
    const entry = this.streams.get(id);
    if (!entry) return;
    this.cancel(id);
    entry.handlers.onEnd(failure);
  }

  onMessage(data: Buffer, isBinary: boolean): void {
    if (this.closed) return;
    try {
      if (isBinary) {
        if (data.length < 4) return;
        const id = data.readUInt32BE(0);
        const entry = this.streams.get(id);
        if (!entry || !entry.gotHead) return;
        const chunk = data.subarray(4);
        entry.outstanding += chunk.length;
        if (entry.outstanding > STREAM_OVERRUN_LIMIT) {
          this.fail(id, { code: 'request_failed', detail: 'The probe ignored flow control' });
          return;
        }
        let acked = false;
        entry.handlers.onData(chunk, () => {
          if (acked) return;
          acked = true;
          this.credit(id, chunk.length);
        });
        return;
      }
      if (data.length > PROXY_HEAD_LIMIT * 8) return;
      const msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (!msg || typeof msg !== 'object') return;
      const id = typeof msg.id === 'number' && Number.isInteger(msg.id) ? msg.id : 0;
      const entry = this.streams.get(id);
      if (!entry) return;
      if (msg.type === TUNNEL_DATA_MESSAGES.HTTP_RES) {
        if (entry.gotHead) return;
        const status = msg.status;
        const headers = parseHeaderPairs(msg.headers);
        const origin = parseOrigin(msg.origin);
        const base = parseOrigin(msg.base);
        if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599 || !headers || !origin || !base) {
          this.fail(id, { code: 'request_failed', detail: 'Invalid answer from the probe' });
          return;
        }
        entry.gotHead = true;
        this.base = base;
        entry.handlers.onHead({ status, headers, origin, base });
      } else if (msg.type === TUNNEL_DATA_MESSAGES.HTTP_END) {
        this.streams.delete(id);
        const code = typeof msg.error === 'string' && ERROR_CODE_RE.test(msg.error) ? msg.error : null;
        const detail = typeof msg.detail === 'string' ? msg.detail.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300) : '';
        entry.handlers.onEnd(code ? { code: code as TunnelProxyErrorCode, detail } : null);
      }
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, tunnelId: this.tunnelId }, 'Tunnel HTTP relay: invalid frame from the probe');
    }
  }

  /** The data socket closed: every stream fails, waiters give up. */
  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    const entries = [...this.streams.values()];
    this.streams.clear();
    for (const entry of entries) {
      try {
        entry.handlers.onEnd({ code: 'tunnel_closed', detail: 'The tunnel closed' });
      } catch { /* ignore */ }
    }
    for (const waiter of this.waiters.splice(0)) waiter(false);
  }
}

// ─── URL rewriting (pure, exported for tests) ───────────────────────────────

export interface RewriteContext {
  /** Proxy root of the token, e.g. /api/tunnel/p/<token> (no trailing slash). */
  root: string;
  targetIp: string;
  /** Lower-case names of the device. */
  hostNames: readonly string[];
  /** Tunnel's base origin: served directly under root. */
  base: RelayOrigin;
  /** Origin of the document being rewritten. */
  current: RelayOrigin;
}

function defaultPort(scheme: string): number {
  return scheme === 'https' ? 443 : 80;
}

/** Prefix of an origin of the device: root for the base, root/~o/<scheme>/<port> otherwise. */
export function originPrefix(ctx: Pick<RewriteContext, 'root' | 'base'>, o: RelayOrigin): string {
  return o.scheme === ctx.base.scheme && o.port === ctx.base.port ? ctx.root : `${ctx.root}/~o/${o.scheme}/${o.port}`;
}

const ALT_ORIGIN_RE = /^\/~o\/(https?)\/(\d{1,5})(\/.*)?$/;

/**
 * The part of a proxy URL after the token: another origin of the device
 * (/~o/<scheme>/<port>/...) or the base one; path = origin-form target.
 * null when the alternative origin is malformed.
 */
export function parseProxySubPath(rest: string): { origin: RelayOrigin | null; path: string } | null {
  const q = rest.indexOf('?');
  const pathPart = q >= 0 ? rest.slice(0, q) : rest;
  const query = q >= 0 ? rest.slice(q) : '';
  if (pathPart.startsWith('/~o/') || pathPart === '/~o') {
    const m = ALT_ORIGIN_RE.exec(pathPart);
    if (!m) return null;
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { origin: { scheme: m[1] as 'http' | 'https', port }, path: (m[3] ?? '/') + query };
  }
  return { origin: null, path: (pathPart || '/') + query };
}

/**
 * The raw target after /<token> in the request URL (percent-encoding kept:
 * req.params is decoded). '' = the bare root. null when it is not a clean
 * origin-form target (visible ASCII only, bounded).
 */
export function proxySubTarget(originalUrl: string, baseUrl: string, token: string): string | null {
  const prefix = `${baseUrl}/${token}`;
  if (!originalUrl.startsWith(prefix)) return null;
  const rest = originalUrl.slice(prefix.length);
  if (rest !== '' && !rest.startsWith('/') && !rest.startsWith('?')) return null;
  if (rest.length > 8192 || !/^[\x21-\x7e]*$/.test(rest)) return null;
  return rest;
}

export type UrlRewrite =
  | { kind: 'device'; value: string }
  | { kind: 'other'; host: string }
  | { kind: 'keep' };

function isDeviceHost(host: string, ctx: Pick<RewriteContext, 'targetIp' | 'hostNames'>): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return h === ctx.targetIp || ctx.hostNames.includes(h);
}

/**
 * Maps a URL found in a device answer: root-relative and absolute URLs of
 * the device go under the proxy prefix (with their scheme / port), relative
 * ones and non-http URLs are kept, other hosts are reported.
 */
export function rewriteDeviceUrl(value: string, ctx: RewriteContext): UrlRewrite {
  const v = value.trim();
  if (!v || v.length > 8192) return { kind: 'keep' };
  if (v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\')) {
    if (v === ctx.root || v.startsWith(`${ctx.root}/`) || v.startsWith(`${ctx.root}?`)) return { kind: 'keep' };
    return { kind: 'device', value: `${originPrefix(ctx, ctx.current)}${v}` };
  }
  const schemeRelative = v.startsWith('//');
  if (!schemeRelative && !/^[a-z][a-z0-9+.-]*:/i.test(v)) return { kind: 'keep' };
  let u: URL;
  try {
    u = new URL(schemeRelative ? `${ctx.current.scheme}:${v}` : v);
  } catch {
    return { kind: 'keep' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'keep' };
  if (!isDeviceHost(u.hostname, ctx)) return { kind: 'other', host: u.host };
  const scheme = u.protocol === 'https:' ? 'https' : 'http';
  const port = u.port ? Number(u.port) : defaultPort(scheme);
  return { kind: 'device', value: `${originPrefix(ctx, { scheme, port })}${u.pathname}${u.search}${u.hash}` };
}

/** Location / Content-Location: the rewritten value, or the foreign host. */
export function rewriteLocationHeader(value: string, ctx: RewriteContext): { value: string } | { otherHost: string } | null {
  const v = value.trim();
  if (!v || v.length > 8192 || !/^[\x21-\x7e]+$/.test(v)) return null;
  const r = rewriteDeviceUrl(v, ctx);
  if (r.kind === 'device') return { value: r.value };
  if (r.kind === 'other') return { otherHost: r.host };
  return { value: v };
}

function rewriteValue(raw: string, ctx: RewriteContext): string {
  const r = rewriteDeviceUrl(raw, ctx);
  return r.kind === 'device' ? r.value : raw;
}

const URL_ATTR_RE = /(\s(?:href|src|action|formaction|poster|background|data|longdesc|cite|manifest|icon|codebase|archive)\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>"'`=<]+))/gi;
const SRCSET_ATTR_RE = /(\s(?:srcset|imagesrcset)\s*=\s*)("([^"]*)"|'([^']*)')/gi;
const META_REFRESH_RE = /(<meta\b[^>]*?\bcontent\s*=\s*["']\s*\d+\s*[;,]\s*url\s*=\s*)([^"'>\s]+)/gi;
const CSS_URL_RE = /(url\(\s*)(["']?)([^"')\s]+)(\2\s*\))/gi;
const CSS_IMPORT_RE = /(@import\s+)(["'])([^"']+)(\2)/gi;

/** Rewrites url(...) and @import of a style sheet (or of a page's styles). */
export function rewriteCss(css: string, ctx: RewriteContext): string {
  return css
    .replace(CSS_URL_RE, (_m, pre: string, q: string, url: string, post: string) => `${pre}${q}${rewriteValue(url, ctx)}${post}`)
    .replace(CSS_IMPORT_RE, (_m, pre: string, q: string, url: string, post: string) => `${pre}${q}${rewriteValue(url, ctx)}${post}`);
}

/** The run-time URL mapper injected into device pages (fetch / XHR / EventSource / window.open / setAttribute). */
export function proxyShimScript(ctx: RewriteContext): string {
  const cfg = JSON.stringify({
    r: ctx.root,
    p: originPrefix(ctx, ctx.current),
    h: [ctx.targetIp, ...ctx.hostNames],
    b: ctx.base,
    c: ctx.current,
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<script>(function(){try{var C=${cfg};`
    + 'function pre(s,p){return(s===C.b.scheme&&p===C.b.port)?C.r:C.r+"/~o/"+s+"/"+p;}'
    + 'function fx(u){if(typeof u!=="string")return u;'
    + 'if(u.charAt(0)==="/"&&u.charAt(1)!=="/"){if(u===C.r||u.indexOf(C.r+"/")===0||u.indexOf(C.r+"?")===0)return u;return C.p+u;}'
    + 'var m=/^(https?:)?\\/\\/([^\\/?#:]+|\\[[^\\]]+\\])(?::(\\d+))?([\\s\\S]*)$/i.exec(u);'
    + 'if(m&&C.h.indexOf(m[2].toLowerCase())>=0){var s=m[1]?m[1].slice(0,-1).toLowerCase():C.c.scheme;'
    + 'var p=m[3]?parseInt(m[3],10):(s==="https"?443:80);var rest=m[4]||"/";if(rest.charAt(0)!=="/")rest="/"+rest;return pre(s,p)+rest;}'
    + 'return u;}'
    + `var K=C.r+${JSON.stringify(WEB_KEEPALIVE_PATH)};setInterval(function(){try{if(navigator.sendBeacon){navigator.sendBeacon(K);}else if(window.fetch){window.fetch(K,{method:"POST",keepalive:true});}}catch(e){}},45000);`
    + 'var F=window.fetch;if(F){window.fetch=function(i,o){try{if(typeof i==="string")i=fx(i);else if(typeof URL!=="undefined"&&i instanceof URL)i=fx(i.href);}catch(e){}return F.call(this,i,o);};}'
    + 'if(window.XMLHttpRequest){var X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){var a=Array.prototype.slice.call(arguments);try{if(a.length>1)a[1]=fx(String(a[1]));}catch(e){}return X.apply(this,a);};}'
    + 'var E=window.EventSource;if(E){var NE=function(u,o){return new E(fx(String(u)),o);};NE.prototype=E.prototype;window.EventSource=NE;}'
    + 'var O=window.open;if(O){window.open=function(){var a=Array.prototype.slice.call(arguments);try{if(typeof a[0]==="string")a[0]=fx(a[0]);}catch(e){}return O.apply(this,a);};}'
    + 'var S=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){try{var l=String(n).toLowerCase();if(l==="src"||l==="href"||l==="action"||l==="formaction")v=fx(String(v));}catch(e){}return S.call(this,n,v);};'
    + '}catch(e){}})();</script>';
}

/**
 * Rewrites a device HTML page: URL attributes, srcset, meta refresh, inline
 * styles and style blocks, then injects the run-time URL mapper right after
 * <head> (or <html>, or at the top).
 */
export function rewriteHtml(html: string, ctx: RewriteContext, xhtml = false): string {
  let out = html.replace(URL_ATTR_RE, (_m, pre: string, _q: string, dq?: string, sq?: string, bare?: string) => {
    if (dq !== undefined) return `${pre}"${rewriteValue(dq, ctx)}"`;
    if (sq !== undefined) return `${pre}'${rewriteValue(sq, ctx)}'`;
    return `${pre}${rewriteValue(bare ?? '', ctx)}`;
  });
  out = out.replace(SRCSET_ATTR_RE, (_m, pre: string, _q: string, dq?: string, sq?: string) => {
    const list = (dq ?? sq ?? '').split(',').map((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (parts[0]) parts[0] = rewriteValue(parts[0], ctx);
      return parts.join(' ');
    }).join(', ');
    return dq !== undefined ? `${pre}"${list}"` : `${pre}'${list}'`;
  });
  out = out.replace(META_REFRESH_RE, (_m, pre: string, url: string) => `${pre}${rewriteValue(url, ctx)}`);
  out = rewriteCss(out, ctx);

  // XHTML is parsed as XML: the script body (raw && and <) must sit in CDATA.
  const shim = xhtml
    ? proxyShimScript(ctx).replace(/^<script>/, '<script>//<![CDATA[\n').replace(/<\/script>$/, '\n//]]></script>')
    : proxyShimScript(ctx);
  const head = /<head\b[^>]*>/i.exec(out);
  if (head) return out.slice(0, head.index + head[0].length) + shim + out.slice(head.index + head[0].length);
  const htmlTag = /<html\b[^>]*>/i.exec(out);
  if (htmlTag) return out.slice(0, htmlTag.index + htmlTag[0].length) + shim + out.slice(htmlTag.index + htmlTag[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(out);
  if (doctype) return doctype[0] + shim + out.slice(doctype[0].length);
  return shim + out;
}

// ─── Header handling (pure, exported for tests) ─────────────────────────────

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
/** Header values Node accepts as they are (latin1 range, no CR / LF / NUL). */
const HEADER_VALUE_OK_RE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** Request headers relayed to the device (cookie / origin / referer filtered or rewritten). */
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'cache-control', 'pragma', 'content-type', 'user-agent',
  'range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since',
  'authorization', 'x-requested-with', 'soapaction',
]);
/** Custom X- headers are relayed (device APIs use them), except these. */
const BLOCKED_X_HEADERS = /^x-(forwarded-|real-ip$|auth-token$|oblimap)/i;

/** Cookie names of Oblimap itself: never forwarded to the device, never set by it. */
export function oblimapCookieNames(): Set<string> {
  return new Set([config.sessionCookieName, 'connect.sid', TUNNEL_BINDING_COOKIE]);
}

/**
 * Dedicated origin only: names the tunnel token the browser last opened on the
 * tunnel host, so that root-relative requests the URL rewriting missed still
 * reach the device (tunnelOriginGuard). Never relayed to, nor settable by, the
 * device (oblimapCookieNames).
 */
export const TUNNEL_BINDING_COOKIE = 'obl_tunnel';

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export interface RequestHeaderOptions {
  blockedCookies: ReadonlySet<string>;
  /** e.g. https://192.168.1.20:8443 — Origin / Referer as the device expects them. */
  deviceOrigin: string;
  /** Proxy prefix of the device origin (Referer mapping). */
  prefix: string;
  /** Public origin of the proxy (Referer mapping). */
  proxyOrigin: string | null;
}

/**
 * Request headers for the device: an allowlist (Authorization included: Basic
 * auth of the device), the Cookie header without Oblimap's own cookies,
 * Origin / Referer mapped to the device; never Host, X-Forwarded-*, X-Real-IP,
 * X-Auth-Token or a hop-by-hop header.
 */
export function buildRelayRequestHeaders(headers: IncomingHttpHeaders, opts: RequestHeaderOptions): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (typeof rawValue !== 'string' || rawValue.length > 8192 || !HEADER_VALUE_OK_RE.test(rawValue)) continue;
    if (name === 'cookie') {
      const kept = rawValue.split(';').map((p) => p.trim()).filter((p) => {
        const eq = p.indexOf('=');
        const cookieName = (eq >= 0 ? p.slice(0, eq) : p).trim();
        return cookieName !== '' && !opts.blockedCookies.has(cookieName);
      });
      if (kept.length > 0) out.push(['cookie', kept.join('; ')]);
      continue;
    }
    if (name === 'origin') {
      out.push(['origin', opts.deviceOrigin]);
      continue;
    }
    if (name === 'referer') {
      try {
        const u = new URL(rawValue);
        if (opts.proxyOrigin && u.origin === opts.proxyOrigin && (u.pathname === opts.prefix || u.pathname.startsWith(`${opts.prefix}/`))) {
          out.push(['referer', `${opts.deviceOrigin}${u.pathname.slice(opts.prefix.length) || '/'}${u.search}`]);
        }
      } catch { /* dropped */ }
      continue;
    }
    if (FORWARDED_REQUEST_HEADERS.has(name) || (name.startsWith('x-') && !BLOCKED_X_HEADERS.test(name) && HEADER_NAME_RE.test(name))) {
      out.push([name, rawValue]);
    }
  }
  return out;
}

/** Response headers relayed to the browser (Location, Content-Location and Set-Cookie rewritten). */
const RELAYED_RESPONSE_HEADERS = new Set([
  'content-type', 'content-length', 'content-encoding', 'content-language', 'content-disposition',
  'content-range', 'accept-ranges', 'cache-control', 'pragma', 'expires', 'etag', 'last-modified', 'age',
  'vary', 'location', 'content-location', 'www-authenticate', 'set-cookie', 'retry-after', 'allow',
]);

/**
 * A device Set-Cookie kept under the proxy prefix: Path moved under it,
 * Domain dropped. null for cookies that must not exist there (Oblimap's own
 * names, __Host- cookies that require Path=/).
 */
export function rewriteSetCookie(value: string, prefix: string, blocked: ReadonlySet<string>, keepPath = false): string | null {
  const parts = value.split(';');
  const first = parts.shift() ?? '';
  const eq = first.indexOf('=');
  const name = (eq >= 0 ? first.slice(0, eq) : '').trim();
  if (!name || !HEADER_NAME_RE.test(name) || blocked.has(name) || /^__host-/i.test(name)) return null;
  let path = '/';
  const attrs: string[] = [];
  for (const raw of parts) {
    const attr = raw.trim();
    if (!attr) continue;
    const key = attr.split('=')[0].trim().toLowerCase();
    if (key === 'domain') continue;
    if (key === 'path') {
      const p = attr.slice(attr.indexOf('=') + 1).trim();
      if (p.startsWith('/')) path = p;
      continue;
    }
    attrs.push(attr);
  }
  // Dedicated origin: the device keeps its own paths (its root-relative
  // requests reach it through the binding cookie, without the prefix).
  return [first.trim(), `Path=${keepPath ? path : `${prefix}${path}`}`, ...attrs].join('; ');
}

export interface FilteredResponseHeaders {
  headers: Array<[string, string]>;
  /** A redirect to another host (refused: the tunnel only reaches the device). */
  otherHostRedirect: string | null;
}

/** The device's response headers as relayed to the browser. */
export function filterResponseHeaders(
  status: number,
  headers: ReadonlyArray<[string, string]>,
  ctx: RewriteContext,
  blockedCookies: ReadonlySet<string>,
  keepCookiePaths = false,
): FilteredResponseHeaders {
  const out: Array<[string, string]> = [];
  let otherHostRedirect: string | null = null;
  const seen = new Set<string>();
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (!RELAYED_RESPONSE_HEADERS.has(name) || !HEADER_VALUE_OK_RE.test(value)) continue;
    if (name === 'set-cookie') {
      const cookie = rewriteSetCookie(value, originPrefix(ctx, ctx.current), blockedCookies, keepCookiePaths);
      if (cookie) out.push([name, cookie]);
      continue;
    }
    if (name !== 'www-authenticate' && name !== 'vary') {
      if (seen.has(name)) continue;
      seen.add(name);
    }
    if (name === 'location' || name === 'content-location') {
      const r = rewriteLocationHeader(value, ctx);
      if (!r) continue;
      if ('otherHost' in r) {
        if (name === 'location' && status >= 300 && status < 400) otherHostRedirect = r.otherHost;
        continue;
      }
      out.push([name, r.value]);
      continue;
    }
    out.push([name, value]);
  }
  return { headers: out, otherHostRedirect };
}

/**
 * Security headers of proxied device responses (they replace helmet's).
 * null = remove the header. 'isolated': sandboxed opaque origin (no
 * allow-same-origin), resources usable cross-origin by that opaque document.
 * 'origin': the dedicated host, nothing of Oblimap's there.
 */
export function proxySecurityHeaders(mode: TunnelProxyMode, requestOrigin: string | undefined): Record<string, string | null> {
  if (mode === 'isolated') {
    const h: Record<string, string | null> = {
      'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      // Popups of the sandboxed page inherit its sandbox flags, and a
      // sandboxed browsing context cannot load a response whose COOP is not
      // unsafe-none (network error): target=_blank / window.open of device
      // pages would break. The sandbox (opaque origin) is the isolation.
      'Cross-Origin-Opener-Policy': 'unsafe-none',
      'Referrer-Policy': 'no-referrer',
      // Embedded devices often serve scripts with a wrong type: no nosniff.
      'X-Content-Type-Options': null,
    };
    if (requestOrigin === 'null') {
      // The sandboxed device document (opaque origin) reading its own resources.
      h['Access-Control-Allow-Origin'] = 'null';
      h['Access-Control-Allow-Credentials'] = 'true';
      h.Vary = 'Origin';
    }
    return h;
  }
  return {
    'Content-Security-Policy': null,
    'Cross-Origin-Resource-Policy': 'same-site',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': null,
  };
}

// ─── Diagnostic pages ───────────────────────────────────────────────────────

const DIAGNOSTICS: Record<string, { status: number; title: string; text: string }> = {
  connection_refused: { status: 502, title: 'Connection refused', text: 'The device refused the connection: nothing listens on this port, or a firewall blocks the probe.' },
  connection_closed: { status: 502, title: 'Connection closed by the device', text: 'The device closed the connection without answering. If this port is HTTPS-only, reopen the tunnel with the HTTPS scheme.' },
  timeout: { status: 504, title: 'The device did not answer', text: 'The device did not answer in time.' },
  unreachable: { status: 502, title: 'Device unreachable', text: 'The probe cannot reach the device (no route).' },
  tls_failed: { status: 502, title: 'HTTPS handshake failed', text: 'The probe could not establish an HTTPS connection with the device.' },
  tls_required: { status: 502, title: 'This port requires HTTPS', text: 'The device answers HTTPS on this port: reopen the tunnel with the HTTPS (or Auto) scheme.' },
  tls_not_supported: { status: 502, title: 'This port does not speak HTTPS', text: 'The device answers plain HTTP on this port: reopen the tunnel with the HTTP (or Auto) scheme.' },
  legacy_tls_required: { status: 502, title: 'This device requires HTTPS', text: 'This port is HTTPS-only and the probe of this tunnel is too old to speak HTTPS to devices. Update the probe to the current version for HTTPS tunnels and full web access.' },
  redirect_other_host: { status: 502, title: 'Redirect to another host refused', text: 'The device redirects to another host, which this tunnel cannot reach: a tunnel only reaches its device.' },
  target_not_allowed: { status: 502, title: 'Target refused by the probe', text: 'The probe refuses this target (outside the subnets it scans, excluded, or its own address).' },
  too_many_streams: { status: 503, title: 'Too many requests in flight', text: 'Too many requests are in flight through this tunnel. Try again.' },
  request_too_large: { status: 413, title: 'Request too large', text: 'The request body is larger than the tunnel accepts.' },
  response_too_large: { status: 502, title: 'Answer too large', text: 'The device answer is larger than the tunnel relays (32 MiB).' },
  tunnel_closed: { status: 502, title: 'Tunnel closed', text: 'The tunnel closed. Open it again from Oblimap.' },
  bad_request: { status: 400, title: 'Invalid request', text: 'The request cannot be relayed to the device.' },
  request_failed: { status: 502, title: 'Request failed', text: 'The request to the device failed.' },
  not_found: { status: 404, title: 'Link expired', text: 'This tunnel link is unknown or expired: it lives as long as its tunnel. Open the tunnel again from Oblimap.' },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** A small self-contained error page (no script, no external resource). */
export function diagnosticPage(code: string, detail: string | null, target: string | null): { status: number; html: string } {
  const d = DIAGNOSTICS[code] ?? DIAGNOSTICS.request_failed;
  const lines = [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(d.title)}</title>`,
    '<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:32px 16px}'
      + 'main{max-width:560px;margin:0 auto}h1{font-size:20px;color:#8dc63f}p{line-height:1.5}code{color:#aaa;word-break:break-all}</style>',
    '</head><body><main>',
    `<h1>${escapeHtml(d.title)}</h1>`,
    `<p>${escapeHtml(d.text)}</p>`,
  ];
  if (target) lines.push(`<p>Target: <code>${escapeHtml(target)}</code></p>`);
  if (detail) lines.push(`<p><code>${escapeHtml(detail.slice(0, 300))}</code></p>`);
  lines.push(`<p><code>oblimap tunnel: ${escapeHtml(code)}</code></p></main></body></html>`);
  return { status: d.status, html: lines.join('') };
}

function sendDiagnostic(res: Response, code: string, detail: string | null, target: string | null): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const page = diagnosticPage(code, detail, target);
  res.status(page.status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.removeHeader('Content-Location');
  res.removeHeader('Location');
  res.end(page.html);
}

// ─── Authorization of a token request ───────────────────────────────────────

/** `${tunnelId}:${digest}` → time of the last positive check. */
const authChecked = new Map<string, number>();

/** revoked_opener: the tunnel's opener lost the right (the tunnel closes); revoked: someone else's link. */
type GrantCheck = 'ok' | 'tunnel_gone' | 'revoked' | 'revoked_opener';

/**
 * The tunnel is still active and its opener still may use it: active
 * account, tunnels.use in the tenant, write permission on the site (as at
 * the open). Cached AUTH_RECHECK_MS per tunnel + user.
 */
async function checkGrant(grant: ProxyGrant): Promise<GrantCheck> {
  const key = `${grant.tunnelId}:${grant.userId}`;
  const now = Date.now();
  const at = authChecked.get(key);
  if (at !== undefined && now - at < AUTH_RECHECK_MS) return 'ok';

  const tunnel = await db('tunnels')
    .where({ id: grant.tunnelId, tenant_id: grant.tenantId, status: 'active' })
    .first('id', 'requested_by') as { id: string; requested_by: number | null } | undefined;
  if (!tunnel) return 'tunnel_gone';
  const revoked: GrantCheck = tunnel.requested_by != null && Number(tunnel.requested_by) === grant.userId
    ? 'revoked_opener' : 'revoked';
  const user = await db('users').where({ id: grant.userId }).first('role', 'is_active') as
    { role: string; is_active: boolean } | undefined;
  if (!user || user.is_active === false) return revoked;
  const platformAdmin = user.role === 'admin';
  if (!platformAdmin && !(await permissionService.userHasTenantCapability(grant.userId, grant.tenantId, 'tunnels.use'))) {
    return revoked;
  }
  const perm = await permissionService.getSitePermission(grant.userId, grant.siteId, grant.tenantId, platformAdmin);
  if (perm !== 'rw') return revoked;
  if (authChecked.size >= 10_000) authChecked.clear();
  authChecked.set(key, now);
  return 'ok';
}

// ─── Rate cap and audit sampling ────────────────────────────────────────────

const rateBuckets = new Map<string, { tokens: number; at: number }>();

function takeRate(tunnelId: string): boolean {
  const now = Date.now();
  const b = rateBuckets.get(tunnelId) ?? { tokens: RATE_BURST, at: now };
  b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.at) * RATE_PER_SEC) / 1000);
  b.at = now;
  if (rateBuckets.size >= 10_000 && !rateBuckets.has(tunnelId)) rateBuckets.clear();
  rateBuckets.set(tunnelId, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

const auditSamples = new Map<string, { at: number; count: number }>();

function sampleAudit(req: Request, grant: ProxyGrant, relay: TunnelRelayMode): void {
  const now = Date.now();
  const s = auditSamples.get(grant.tunnelId);
  if (s && now - s.at < AUDIT_SAMPLE_MS) {
    s.count += 1;
    return;
  }
  if (auditSamples.size >= 10_000) auditSamples.clear();
  auditSamples.set(grant.tunnelId, { at: now, count: 0 });
  void auditService.log({
    tenantId: grant.tenantId,
    userId: grant.userId,
    probeId: grant.probeId,
    action: 'tunnel.proxy_used',
    resourceType: 'tunnel',
    resourceId: grant.tunnelId,
    details: {
      siteId: grant.siteId,
      target: `${grant.targetIp}:${grant.targetPort}`,
      relay,
      mode: tunnelProxyMode(),
      // Requests since the previous sample (none for the first one).
      requestsSincePrevious: s ? s.count : 0,
    },
    ipAddress: clientIp(req) || null,
  });
}

// ─── Proxy access (issued to the tunnel's opener) ───────────────────────────

/** URL of the device's web UI for a token: absolute on TUNNEL_ORIGIN, root-relative otherwise. */
export function proxyUrlForToken(token: string, cfg: TunnelOriginConfig | null = tunnelOrigin()): string {
  const path = `${PROXY_PATH_PREFIX}${token}/`;
  return cfg ? `${cfg.origin}${path}` : path;
}

/** A new proxy link for a tunnel, bound to the user asking for it. */
export async function createProxyAccess(tunnel: {
  id: string; tenantId: number; siteId: number; probeId: number; targetIp: string; targetPort: number;
}, userId: number): Promise<TunnelProxyAccess> {
  const item = await db('site_items')
    .where({ site_id: tunnel.siteId, tenant_id: tunnel.tenantId, ip: tunnel.targetIp })
    .first('hostname') as { hostname: string | null } | undefined;
  const token = issueProxyToken({
    tunnelId: tunnel.id,
    tenantId: tunnel.tenantId,
    userId,
    siteId: tunnel.siteId,
    probeId: tunnel.probeId,
    targetIp: tunnel.targetIp,
    targetPort: tunnel.targetPort,
    hostNames: deviceHostNames(item?.hostname),
  });
  return {
    url: proxyUrlForToken(token),
    mode: tunnelProxyMode(),
    relay: tunnelRelayMode(tunnel.id),
    scheme: getTunnelScheme(tunnel.id),
  };
}

// ─── Relaying one browser request ───────────────────────────────────────────

/** Request body, at most PROXY_BODY_LIMIT bytes (null: none). */
async function readProxyBody(req: Request, res: Response): Promise<Buffer | null> {
  // Fallback only: app.ts wraps express.json() in skipForTunnelProxy, so the
  // raw body is streamed below. Were it parsed anyway, re-serialise it.
  if ((req as unknown as { _body?: boolean })._body === true) {
    const json = Buffer.from(JSON.stringify(req.body ?? null), 'utf8');
    if (json.length > PROXY_BODY_LIMIT) throw new BodyTooLarge();
    return json;
  }
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > PROXY_BODY_LIMIT) {
    res.setHeader('Connection', 'close');
    throw new BodyTooLarge();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > PROXY_BODY_LIMIT) {
      res.setHeader('Connection', 'close');
      throw new BodyTooLarge();
    }
    chunks.push(buf);
  }
  return total > 0 ? Buffer.concat(chunks, total) : null;
}

class BodyTooLarge extends Error {}

function isRewritable(contentType: string | undefined): 'html' | 'xhtml' | 'css' | null {
  const t = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (t === 'text/html') return 'html';
  if (t === 'application/xhtml+xml') return 'xhtml';
  if (t === 'text/css') return 'css';
  return null;
}

interface BrowserContext {
  req: Request;
  res: Response;
  method: string;
  root: string;
  grant: ProxyGrant;
  mode: TunnelProxyMode;
  blockedCookies: ReadonlySet<string>;
}

/**
 * Writes one relayed answer to the browser: headers filtered / rewritten,
 * HTML and CSS rewritten (buffered up to REWRITE_LIMIT), anything else
 * streamed with backpressure (ack once written). Diagnostic page on failure.
 */
class BrowserResponse {
  finished = false;
  private rewrite: 'html' | 'xhtml' | 'css' | null = null;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private rewriteCtx: RewriteContext | null = null;
  private skipBody = false;

  constructor(private readonly c: BrowserContext) {}

  private target(): string {
    return `${this.c.grant.targetIp}:${this.c.grant.targetPort}`;
  }

  head(h: RelayHead): void {
    if (this.finished) return;
    const { res } = this.c;
    const ctx: RewriteContext = {
      root: this.c.root,
      targetIp: this.c.grant.targetIp,
      hostNames: this.c.grant.hostNames,
      base: h.base,
      current: h.origin,
    };
    this.rewriteCtx = ctx;
    const filtered = filterResponseHeaders(h.status, h.headers, ctx, this.c.blockedCookies, this.c.mode === 'origin');
    if (filtered.otherHostRedirect) {
      this.skipBody = true;
      this.fail('redirect_other_host', `Redirect to ${filtered.otherHostRedirect}`);
      return;
    }
    const encoding = filtered.headers.find(([n]) => n === 'content-encoding')?.[1];
    const contentType = filtered.headers.find(([n]) => n === 'content-type')?.[1];
    const noBody = this.c.method === 'HEAD' || h.status === 204 || h.status === 304;
    this.rewrite = !noBody && h.status !== 206 && (!encoding || encoding.toLowerCase() === 'identity')
      ? isRewritable(contentType) : null;

    try {
      for (const [name, value] of Object.entries(proxySecurityHeaders(this.c.mode, this.c.req.headers.origin))) {
        if (value === null) res.removeHeader(name);
        else res.setHeader(name, value);
      }
      const cookies: string[] = [];
      for (const [name, value] of filtered.headers) {
        if (name === 'set-cookie') cookies.push(value);
        else if (name === 'content-length' && this.rewrite) continue;
        else if (name === 'www-authenticate' || name === 'vary') res.append(name, value);
        else res.setHeader(name, value);
      }
      if (this.c.mode === 'origin') {
        // Bind this browser to the tunnel on the dedicated host (see tunnelOriginGuard).
        const token = this.c.root.slice(this.c.root.lastIndexOf('/') + 1);
        const secure = tunnelOrigin()?.origin.startsWith('https:') ? '; Secure' : '';
        cookies.push(`${TUNNEL_BINDING_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`);
      }
      if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);
      if (!res.getHeader('cache-control')) res.setHeader('Cache-Control', 'private, no-cache');
      res.status(h.status);
      if (!this.rewrite) res.writeHead(h.status);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, tunnelId: this.c.grant.tunnelId }, 'Tunnel proxy: unusable response headers');
      this.skipBody = true;
      this.fail('request_failed', 'Unusable response headers from the device');
    }
  }

  data(chunk: Buffer, ack: () => void): void {
    if (this.finished || this.skipBody) {
      ack();
      return;
    }
    const { res } = this.c;
    if (this.rewrite) {
      this.bufferedBytes += chunk.length;
      if (this.bufferedBytes <= REWRITE_LIMIT) {
        this.buffered.push(chunk);
        ack();
        return;
      }
      // Too large to rewrite: relay it as it is.
      this.rewrite = null;
      res.writeHead(res.statusCode);
      for (const b of this.buffered) res.write(b);
      this.buffered = [];
    }
    if (res.write(chunk)) ack();
    else res.once('drain', ack);
  }

  end(failure: RelayFailure | null): void {
    if (this.finished) return;
    if (failure) {
      this.fail(failure.code, failure.detail);
      return;
    }
    this.finished = true;
    const { res } = this.c;
    try {
      if (this.rewrite && this.rewriteCtx) {
        const text = Buffer.concat(this.buffered).toString('latin1');
        const out = this.rewrite === 'css'
          ? rewriteCss(text, this.rewriteCtx)
          : rewriteHtml(text, this.rewriteCtx, this.rewrite === 'xhtml');
        const body = Buffer.from(out, 'latin1');
        res.setHeader('Content-Length', String(body.length));
        res.writeHead(res.statusCode);
        res.end(body);
        return;
      }
      if (!res.headersSent) {
        sendDiagnostic(res, 'request_failed', 'No answer from the device', this.target());
        return;
      }
      res.end();
    } catch {
      res.destroy();
    }
  }

  fail(code: string, detail: string | null): void {
    if (this.finished) return;
    this.finished = true;
    if (this.c.res.headersSent) {
      this.c.res.destroy(); // the browser must see a truncated answer as failed
      return;
    }
    // Our own page: none of the device's headers.
    for (const name of this.c.res.getHeaderNames()) {
      if (RELAYED_RESPONSE_HEADERS.has(name)) this.c.res.removeHeader(name);
    }
    sendDiagnostic(this.c.res, code, detail, this.target());
  }
}

/** One request through the multiplexed HTTP relay. */
async function relayHttp(channel: TunnelHttpChannel, creq: ChannelRequest, body: Buffer | null, browser: BrowserResponse, res: Response): Promise<void> {
  if (!(await channel.acquire())) {
    browser.fail(channel.closed ? 'tunnel_closed' : 'too_many_streams', null);
    return;
  }
  try {
    await new Promise<void>((resolve) => {
      let id: number | null = null;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (idle) clearTimeout(idle);
        res.off('close', onClientGone);
        resolve();
      };
      const arm = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
          if (id !== null) channel.cancel(id);
          browser.fail('timeout', null);
          done();
        }, STREAM_IDLE_TIMEOUT_MS);
      };
      const onClientGone = () => {
        if (browser.finished) return;
        browser.finished = true;
        if (id !== null) channel.cancel(id);
        done();
      };
      res.on('close', onClientGone);
      arm();
      id = channel.start(creq, body, {
        onHead: (h) => {
          arm();
          browser.head(h);
        },
        onData: (chunk, ack) => {
          arm();
          browser.data(chunk, ack);
        },
        onEnd: (failure) => {
          browser.end(failure);
          done();
        },
      });
      if (id === null) {
        browser.fail('tunnel_closed', null);
        done();
      }
    });
  } finally {
    channel.release();
  }
}

// ── Legacy relay (probes without the HTTP relay: one raw TCP stream) ────────

const HEADER_VALUE_BAD_RE = /[\x00-\x08\x0a-\x1f\x7f]/;
const STATUS_LINE_RE = /^HTTP\/\d(?:\.\d)?[ \t]+(\d{3})(?:[ \t].*)?$/;
const LEGACY_IDLE_TIMEOUT_MS = 30_000;

/** Raw HTTP/1.1 request for the device (legacy relay): keep-alive, so later requests reuse the stream. */
export function buildLegacyRequest(method: string, targetPath: string, host: string, headers: Array<[string, string]>, body: Buffer | null): Buffer {
  let head = `${method} ${targetPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n`;
  for (const [name, value] of headers) {
    if (HEADER_VALUE_BAD_RE.test(value)) continue;
    head += `${name}: ${value}\r\n`;
  }
  if (body && body.length > 0) head += `Content-Length: ${body.length}\r\n`;
  else if (method === 'POST' || method === 'PUT' || method === 'PATCH') head += 'Content-Length: 0\r\n';
  head += '\r\n';
  const headBuf = Buffer.from(head, 'latin1');
  return body && body.length > 0 ? Buffer.concat([headBuf, body]) : headBuf;
}

/** End of the response head: index of the blank line and start of the body. */
export function findHeadEnd(buf: Buffer): { headEnd: number; bodyStart: number } | null {
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n'); // non-compliant devices ending lines with a bare LF
  if (crlf === -1 && lf === -1) return null;
  if (lf !== -1 && (crlf === -1 || lf < crlf)) return { headEnd: lf, bodyStart: lf + 2 };
  return { headEnd: crlf, bodyStart: crlf + 4 };
}

/** Parses a response head (latin1). null when the status line is not HTTP. */
export function parseResponseHead(block: Buffer): { status: number; headers: Array<[string, string]> } | null {
  const lines = block.toString('latin1').split(/\r?\n/);
  const m = STATUS_LINE_RE.exec(lines[0] ?? '');
  if (!m) return null;
  const headers: Array<[string, string]> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon);
    if (!HEADER_NAME_RE.test(name)) continue;
    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, '');
    if (HEADER_VALUE_BAD_RE.test(value)) continue;
    headers.push([name.toLowerCase(), value]);
  }
  return { status: Number(m[1]), headers };
}

/** Streaming decoder of a chunked body. */
export class ChunkedDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private remaining = 0;
  private state: 'size' | 'data' | 'data-end' | 'trailer' | 'done' = 'size';

  get done(): boolean {
    return this.state === 'done';
  }

  /** Returns the decoded bytes found in `chunk`; throws on malformed framing. */
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    while (this.state !== 'done') {
      if (this.state === 'size') {
        const eol = this.buf.indexOf('\r\n');
        if (eol === -1) {
          if (this.buf.length > 1024) throw new Error('chunk size line too long');
          break;
        }
        const line = this.buf.subarray(0, eol).toString('latin1');
        this.buf = this.buf.subarray(eol + 2);
        const m = /^([0-9a-fA-F]{1,8})[ \t]*(?:;.*)?$/.exec(line);
        if (!m) throw new Error('invalid chunk size');
        this.remaining = parseInt(m[1], 16);
        this.state = this.remaining === 0 ? 'trailer' : 'data';
      } else if (this.state === 'data') {
        if (this.buf.length === 0) break;
        const n = Math.min(this.remaining, this.buf.length);
        out.push(this.buf.subarray(0, n));
        this.buf = this.buf.subarray(n);
        this.remaining -= n;
        if (this.remaining === 0) this.state = 'data-end';
      } else if (this.state === 'data-end') {
        if (this.buf.length < 2) break;
        if (this.buf[0] !== 0x0d || this.buf[1] !== 0x0a) throw new Error('missing CRLF after chunk data');
        this.buf = this.buf.subarray(2);
        this.state = 'size';
      } else {
        const eol = this.buf.indexOf('\r\n');
        if (eol === -1) {
          if (this.buf.length > PROXY_HEAD_LIMIT) throw new Error('chunked trailers too large');
          break;
        }
        this.buf = this.buf.subarray(eol + 2);
        if (eol === 0) this.state = 'done';
      }
    }
    return out;
  }
}

export type ResponseFraming =
  | { kind: 'none' }
  | { kind: 'length'; remaining: number }
  | { kind: 'chunked'; decoder: ChunkedDecoder }
  | { kind: 'close' };

/** How the end of the response body is known (RFC 9112 §6.3); throws when it cannot be trusted. */
export function responseFraming(status: number, headers: Array<[string, string]>, method: string): ResponseFraming {
  if (method === 'HEAD' || status === 204 || status === 304) return { kind: 'none' };
  const codings = headers
    .filter(([name]) => name === 'transfer-encoding')
    .flatMap(([, value]) => value.toLowerCase().split(','))
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (codings.length > 0) {
    if (codings[codings.length - 1] !== 'chunked') return { kind: 'close' };
    if (codings.length > 1) throw new Error('unsupported transfer coding');
    return { kind: 'chunked', decoder: new ChunkedDecoder() };
  }
  const lengths = new Set(
    headers
      .filter(([name]) => name === 'content-length')
      .flatMap(([, value]) => value.split(','))
      .map((v) => v.trim()),
  );
  if (lengths.size > 1) throw new Error('conflicting Content-Length');
  if (lengths.size === 1) {
    const [value] = [...lengths];
    if (!/^\d{1,15}$/.test(value)) throw new Error('invalid Content-Length');
    return { kind: 'length', remaining: Number(value) };
  }
  return { kind: 'close' };
}

function rawToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function closeDataChannel(ws: WebSocket): void {
  try {
    ws.close(1000, 'Proxy exchange aborted');
  } catch {
    try { ws.terminate(); } catch { /* ignore */ }
  }
}

/**
 * One exchange on a legacy tunnel's single TCP stream: sends the raw request
 * and parses the device's answer into head / body / end. An exchange that
 * did not end cleanly closes the data socket: bytes of an unfinished answer
 * must never be read as the answer to a later request. A first answer byte
 * that opens a TLS record, or a close without answer on a TLS port, means
 * the device wants HTTPS, which these probes cannot speak.
 */
function legacyExchange(ws: WebSocket, request: Buffer, method: string, targetPort: number, h: StreamHandlers): Promise<void> {
  return new Promise<void>((resolve) => {
    let finished = false;
    let head: Buffer = Buffer.alloc(0);
    let framing: ResponseFraming | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let sawBytes = false;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      ws.off('message', onMessage);
      ws.off('close', onWsClose);
      if (ws.isPaused) ws.resume();
    };
    const finish = (failure: RelayFailure | null, dropChannel = false) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (failure || dropChannel) closeDataChannel(ws);
      h.onEnd(failure);
      resolve();
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (framing && framing.kind === 'close') finish(null, true); // body delimited by the close: the device went quiet
        else finish({ code: 'timeout', detail: 'The device did not answer in time' });
      }, LEGACY_IDLE_TIMEOUT_MS);
    };
    const complete = (): boolean =>
      framing !== null && (framing.kind === 'none'
        || (framing.kind === 'length' && framing.remaining === 0)
        || (framing.kind === 'chunked' && framing.decoder.done));
    const ack = () => {
      if (ws.isPaused) ws.resume();
    };
    const writeBody = (chunk: Buffer) => {
      if (!framing || chunk.length === 0 || framing.kind === 'none') return;
      let parts: Buffer[];
      if (framing.kind === 'length') {
        const n = Math.min(framing.remaining, chunk.length);
        framing.remaining -= n;
        parts = n > 0 ? [chunk.subarray(0, n)] : [];
      } else if (framing.kind === 'chunked') {
        parts = framing.decoder.push(chunk);
      } else {
        parts = [chunk];
      }
      for (const part of parts) {
        if (part.length === 0) continue;
        let acked = false;
        h.onData(part, () => { acked = true; ack(); });
        if (!acked && !ws.isPaused) ws.pause(); // backpressure until the browser caught up
      }
    };

    function onMessage(data: WebSocket.RawData): void {
      if (finished) return;
      try {
        armIdle();
        let chunk = rawToBuffer(data);
        if (!sawBytes && chunk.length > 0) {
          sawBytes = true;
          if (chunk[0] === 0x15 || chunk[0] === 0x16) {
            finish({ code: 'legacy_tls_required', detail: 'The device answered with TLS' });
            return;
          }
        }
        if (!framing) {
          head = head.length > 0 ? Buffer.concat([head, chunk]) : chunk;
          for (;;) {
            const end = findHeadEnd(head);
            if (!end || end.headEnd > PROXY_HEAD_LIMIT) {
              if (head.length > PROXY_HEAD_LIMIT) finish({ code: 'request_failed', detail: 'Response headers too large' });
              return;
            }
            const parsed = parseResponseHead(head.subarray(0, end.headEnd));
            const rest = head.subarray(end.bodyStart);
            if (!parsed) {
              finish({ code: 'request_failed', detail: 'Invalid response from the device' });
              return;
            }
            if (parsed.status >= 100 && parsed.status < 200 && parsed.status !== 101) {
              head = rest;
              continue;
            }
            if (parsed.status < 200 || parsed.status > 599) {
              finish({ code: 'request_failed', detail: 'Unsupported response status from the device' });
              return;
            }
            framing = responseFraming(parsed.status, parsed.headers, method);
            const relayHeaders = parsed.headers.filter(([n]) => n !== 'transfer-encoding' && n !== 'connection' && n !== 'keep-alive'
              && !(n === 'content-length' && framing!.kind !== 'length'));
            const origin: RelayOrigin = { scheme: 'http', port: targetPort };
            h.onHead({ status: parsed.status, headers: relayHeaders, origin, base: origin });
            head = Buffer.alloc(0);
            chunk = rest;
            break;
          }
        }
        writeBody(chunk);
        if (complete()) finish(null);
      } catch (err) {
        logger.warn({ err: (err as Error)?.message }, 'Tunnel proxy: invalid response from the device (legacy relay)');
        finish({ code: 'request_failed', detail: 'Invalid response from the device' });
      }
    }

    function onWsClose(): void {
      if (finished) return;
      if (!framing) {
        finish(!sawBytes && TLS_PORTS.has(targetPort)
          ? { code: 'legacy_tls_required', detail: 'The device closed the connection on an HTTPS port' }
          : { code: 'connection_closed', detail: 'The tunnel closed before the device answered' });
      } else if (framing.kind === 'close' || complete()) finish(null);
      else finish({ code: 'connection_closed', detail: 'The tunnel closed before the answer was complete' });
    }

    ws.on('message', onMessage);
    ws.on('close', onWsClose);
    armIdle();
    try {
      ws.send(request, (err) => {
        if (err) finish({ code: 'tunnel_closed', detail: 'Failed to send through the tunnel' });
      });
    } catch {
      finish({ code: 'tunnel_closed', detail: 'Failed to send through the tunnel' });
    }
  });
}

/** A legacy tunnel carries one exchange at a time: requests queue (bounded wait). */
const legacyLocks = new Map<string, Promise<void>>();
const LEGACY_QUEUE_WAIT_MS = 30_000;

async function withLegacyLock<T>(tunnelId: string, fn: () => Promise<T>): Promise<T | null> {
  const previous = legacyLocks.get(tunnelId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const chained = previous.then(() => mine);
  legacyLocks.set(tunnelId, chained);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const turn = await Promise.race([
    previous.then(() => true),
    new Promise<boolean>((r) => { timer = setTimeout(() => r(false), LEGACY_QUEUE_WAIT_MS); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!turn) {
    // Gave up: release our place once our turn would have come.
    void previous.then(() => release());
    return null;
  }
  try {
    return await fn();
  } finally {
    release();
    if (legacyLocks.get(tunnelId) === chained) legacyLocks.delete(tunnelId);
  }
}

/** The tunnel's data socket, waiting a little for older probes that attach it late. */
async function waitForDataWs(tunnelId: string, req: Request): Promise<WebSocket | null> {
  const deadline = Date.now() + DATA_WS_WAIT_MS;
  for (;;) {
    const ws = getTunnelDataWs(tunnelId);
    if (ws && ws.readyState === 1) return ws;
    if (Date.now() >= deadline || req.socket.destroyed) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ─── Express handler: ALL /api/tunnel/p/:token[/*] ──────────────────────────

function preflightAnswer(req: Request, res: Response): boolean {
  if (req.method !== 'OPTIONS' || req.headers.origin !== 'null' || !req.headers['access-control-request-method']) return false;
  const method = String(req.headers['access-control-request-method']).toUpperCase();
  const reqHeaders = String(req.headers['access-control-request-headers'] ?? '');
  res.status(204);
  res.setHeader('Access-Control-Allow-Origin', 'null');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', PROXY_METHODS.has(method) ? method : 'GET');
  if (/^[A-Za-z0-9 ,_-]{0,1024}$/.test(reqHeaders) && reqHeaders) res.setHeader('Access-Control-Allow-Headers', reqHeaders);
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.end();
  return true;
}

/**
 * The web proxy: authorizes the token, then relays the request to the
 * tunnel's device through the HTTP relay (or the legacy stream).
 */
export async function proxyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.params.token;
    const grant = lookupProxyToken(token);
    const cfg = tunnelOrigin();
    if (!grant) {
      sendDiagnostic(res, 'not_found', null, null);
      return;
    }
    if (cfg && !isTunnelOriginHost(req.headers.host, cfg)) {
      // Dedicated origin configured: device content is never served on the
      // Oblimap origin (its cookies are there).
      res.redirect(302, `${cfg.origin}${req.originalUrl}`);
      return;
    }
    const target = `${grant.targetIp}:${grant.targetPort}`;
    if (!takeRate(grant.tunnelId)) {
      res.setHeader('Retry-After', '1');
      sendDiagnostic(res, 'too_many_streams', 'Rate limit of the tunnel reached', target);
      return;
    }
    const check = await checkGrant(grant);
    if (check === 'tunnel_gone') {
      revokeTunnelProxyTokens(grant.tunnelId);
      sendDiagnostic(res, 'tunnel_closed', null, target);
      return;
    }
    if (check === 'revoked') {
      // Someone else's link (platform admin) who lost the right: their links go.
      revokeUserProxyTokensForTunnel(grant.tunnelId, grant.userId);
      sendDiagnostic(res, 'not_found', null, null);
      return;
    }
    if (check === 'revoked_opener') {
      // The opener lost the right to use this tunnel: it is closed.
      const { tunnelService } = await import('./tunnel.service');
      const result = await tunnelService.closeTunnel(grant.tunnelId, grant.tenantId);
      if (result?.closed) {
        logger.info({ tunnelId: grant.tunnelId, siteId: grant.siteId }, 'Tunnel closed: its opener lost the right to use it');
        void auditService.log({
          tenantId: grant.tenantId,
          userId: grant.userId,
          probeId: grant.probeId,
          action: 'tunnel.closed',
          resourceType: 'tunnel',
          resourceId: grant.tunnelId,
          details: { siteId: grant.siteId, probeId: grant.probeId, target, reason: 'site_permission_revoked' },
          ipAddress: clientIp(req) || null,
        });
      }
      revokeTunnelProxyTokens(grant.tunnelId);
      sendDiagnostic(res, 'not_found', null, null);
      return;
    }

    const method = req.method.toUpperCase();
    if (!PROXY_METHODS.has(method)) {
      sendDiagnostic(res, 'bad_request', `Method ${method.slice(0, 16)} is not relayed`, target);
      return;
    }
    const mode: TunnelProxyMode = cfg ? 'origin' : 'isolated';
    if (mode === 'isolated' && preflightAnswer(req, res)) return;

    const rest = proxySubTarget(req.originalUrl, req.baseUrl, token);
    const sub = rest === null ? null : parseProxySubPath(rest);
    if (rest === null || !sub) {
      sendDiagnostic(res, 'bad_request', 'Invalid request path', target);
      return;
    }
    const root = `${req.baseUrl}/${token}`;
    if (rest === '' || rest.startsWith('?')) {
      // Relative URLs of the page must resolve under the prefix.
      res.redirect(302, `${root}/${rest}`);
      return;
    }
    markWebActivity(grant.tunnelId, grant.tenantId);
    if (rest.split('?')[0] === WEB_KEEPALIVE_PATH) {
      // Heartbeat of an open device tab (never relayed to the device).
      touchTunnelActivity(grant.tunnelId);
      res.status(204).setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }

    let body: Buffer | null;
    try {
      body = await readProxyBody(req, res);
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        sendDiagnostic(res, 'request_too_large', null, target);
        return;
      }
      throw err;
    }

    touchTunnelActivity(grant.tunnelId);
    const relay = await resolveTunnelRelayMode(grant.tunnelId);
    sampleAudit(req, grant, relay);

    const channel = channels.get(grant.tunnelId);
    const fallbackBase: RelayOrigin = { scheme: TLS_PORTS.has(grant.targetPort) ? 'https' : 'http', port: grant.targetPort };
    const base = channel?.base ?? fallbackBase;
    const deviceOrigin = sub.origin ?? base;
    const prefix = originPrefix({ root, base }, deviceOrigin);
    const blockedCookies = oblimapCookieNames();
    const proxyOrigin = cfg ? cfg.origin : null;
    const headers = buildRelayRequestHeaders(req.headers, {
      blockedCookies,
      deviceOrigin: `${deviceOrigin.scheme}://${grant.targetIp}${deviceOrigin.port === (deviceOrigin.scheme === 'https' ? 443 : 80) ? '' : `:${deviceOrigin.port}`}`,
      prefix,
      proxyOrigin,
    });
    const browser = new BrowserResponse({
      req, res, method, root, grant, mode, blockedCookies,
    });

    if (channel && !channel.closed) {
      await relayHttp(channel, { method, path: sub.path, headers, origin: sub.origin }, body, browser, res);
      return;
    }

    // Legacy probe: one raw TCP stream, the tunnel's own port only.
    if (sub.origin && (sub.origin.port !== grant.targetPort || sub.origin.scheme === 'https')) {
      browser.fail(sub.origin.scheme === 'https' ? 'legacy_tls_required' : 'bad_request',
        'This probe relays only the tunnel\'s own port over plain HTTP: update the probe for full web access');
      return;
    }
    const ws = await waitForDataWs(grant.tunnelId, req);
    if (!ws) {
      sendDiagnostic(res, 'tunnel_closed', 'The tunnel data channel is not connected (the probe may still be connecting)', target);
      return;
    }
    const request = buildLegacyRequest(method, sub.path, target, headers, body);
    const ran = await withLegacyLock(grant.tunnelId, async () => {
      if (res.writableEnded || req.socket.destroyed) return true;
      const onClientGone = () => {
        if (!browser.finished) {
          browser.finished = true;
          closeDataChannel(ws);
        }
      };
      res.on('close', onClientGone);
      // From the first raw frame on, a late tunnel_hello is ignored.
      markTunnelDataLegacy(grant.tunnelId, ws);
      try {
        await legacyExchange(ws, request, method, grant.targetPort, {
          onHead: (h) => browser.head(h),
          onData: (chunk, ack) => browser.data(chunk, ack),
          onEnd: (failure) => browser.end(failure),
        });
      } finally {
        res.off('close', onClientGone);
      }
      return true;
    });
    if (ran === null) {
      res.setHeader('Retry-After', '1');
      browser.fail('too_many_streams', 'This probe relays one request at a time: update the probe for full web access');
    }
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // Answered here, not by the app's errorHandler: it would log req.path,
    // which carries the proxy token.
    logger.warn({ err: (err as Error)?.message }, 'Tunnel proxy request failed');
    try {
      sendDiagnostic(res, 'request_failed', null, null);
    } catch {
      next(err);
    }
  }
}

