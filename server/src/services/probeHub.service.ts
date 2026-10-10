/**
 * ProbeHub — manages raw WebSocket connections from probes.
 *
 * Architecture mirrors Obliance's agentHub.service.ts:
 * - Dedicated endpoint /api/probe/ws (NOT Socket.io)
 * - Auth via X-API-Key + X-Probe-UUID (+ X-Probe-Token once issued), checked
 *   by authenticateProbe in the upgrade handler (index.ts) before the socket
 *   reaches this module
 * - Simple JSON messages over RFC 6455 text frames
 * - Server-initiated ping every 15s (RFC 6455 ping/pong)
 *
 * Identity is ALWAYS the connection's (probe id / tenant / API key fixed at
 * the upgrade), never anything a message claims.
 */

import type WebSocket from 'ws';
import { db } from '../db';
import { logger } from '../utils/logger';
import { PROBE_WS_MESSAGES } from '@oblimap/shared';
import { AppError } from '../middleware/errorHandler';
import { helloSchema } from '../validators/deviceCheck.schema';
import { issueProbeToken, confirmIssuedProbeToken, advertisesProbeToken } from './probeAuth.service';
import { ingest } from './deviceChecks/ingest.service';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProbeConn {
  ws: WebSocket;
  probeId: number;
  tenantId: number;
  probeUuid: string;
  apiKeyId: number;
}

interface ProbeWsMessage {
  type: string;
  [key: string]: unknown;
}

/** Per-connection state (ProbeConn is the part other modules rely on). */
interface ConnState extends ProbeConn {
  /** false until an unknown probe registered itself with its first scan_result (probeId is 0 until then). */
  registered: boolean;
  /** X-Probe-Features as presented at the upgrade. */
  features: string;
  ip: string | null;
  /** Identity token sent on THIS connection, until the probe acknowledges it. Never logged. */
  issuedToken: string | null;
  // Message rate cap (token bucket) and abuse tracking
  bucketTokens: number;
  bucketAt: number;
  dropped: number;
  dropWindowAt: number;
  lastParseWarnAt: number;
  // scan_result: processed one at a time and spaced out; only the newest
  // waiting one is kept (never dropped, deferred at most SCAN_MIN_INTERVAL_MS)
  scanBusy: boolean;
  nextScan: unknown;
  /** When the previous scan_result finished processing (0: none yet). */
  lastScanAt: number;
  scanTimer: ReturnType<typeof setTimeout> | null;
  lastHeartbeatWriteAt: number;
  /** Counted in unregisteredByKey (until registered or closed). */
  holdsSlot: boolean;
  registerTimer: ReturnType<typeof setTimeout> | null;
  /** When the last hello was processed (0: none yet). */
  lastHelloAt: number;
  /** configUpdateSeq value of the last config_update delivered on this connection (0: none yet). */
  lastConfigSeq: number;
  // check_results: token bucket (1 batch/s), then ingested one batch at a
  // time in arrival order; extra batches are dropped and counted.
  checkTokens: number;
  checkTokensAt: number;
  checkQueue: CheckBatch[];
  checkBusy: boolean;
  checkDropped: number;
  checkDropLogAt: number;
  checkInvalidWarnAt: number;
}

/** A check_results batch waiting for ingestion, with the identity of the connection it came on. */
interface CheckBatch {
  probeId: number;
  tenantId: number;
  batch: ProbeWsMessage;
}

// WebSocket.OPEN — `ws` is only imported as a type here.
const WS_OPEN = 1;

// Per-connection message rate cap: 20 messages/s with a burst of 20. Excess
// messages are dropped; a connection that keeps flooding is closed (1008).
const RATE_PER_SEC = 20;
const RATE_BURST = 20;
const ABUSE_WINDOW_MS = 10_000;
const ABUSE_MAX_DROPS = 200;

/**
 * Minimum idle time between the end of one scan_result's processing and the
 * start of the next on a connection. An earlier one waits (the newest waiting
 * one wins) — it is deferred, never dropped: an admin rescan on a small site
 * may legitimately finish within a few seconds.
 */
const SCAN_MIN_INTERVAL_MS = 5_000;
/** last_seen_at is written (or, not registered yet, the API key re-checked) at most this often from heartbeats. */
const HEARTBEAT_WRITE_MIN_MS = 10_000;

/** Unknown probes (no row yet) connected per API key, and how long they may stay unregistered. */
const MAX_UNREGISTERED_PER_KEY = 10;
const UNREGISTERED_TTL_MS = 60 * 60 * 1000;

/**
 * hello is sent once per connection; a repeated one within this delay is
 * ignored (each one rebuilds the probe's config, Device Checks included).
 */
const HELLO_MIN_INTERVAL_MS = 30_000;

/** Incremented on every config_update delivered, whichever the connection (see lastConfigUpdateSeq). */
let configUpdateSeq = 0;

/**
 * check_results: at most one batch per second per probe (sustained). The
 * burst of 2 absorbs network jitter — the probe spaces its batches by 1.1 s.
 * Batches are ingested one at a time, in arrival order; at most
 * CHECK_QUEUE_MAX wait. Anything beyond is dropped and counted (a warning per
 * minute at most).
 */
const CHECK_BATCHES_PER_SEC = 1;
const CHECK_BATCH_BURST = 2;
const CHECK_QUEUE_MAX = 3;
const CHECK_WARN_INTERVAL_MS = 60_000;

// ─── Registry ───────────────────────────────────────────────────────────────

const byProbeId = new Map<number, ConnState>();
/** Every open control connection, registered or not (ping keepalive). */
const allConns = new Set<ConnState>();
const unregisteredByKey = new Map<number, number>();

// ─── Probe replies (tunnel_ready / tunnel_error, check_test_result, ...) ────

/** Why waitForProbeReply rejected. */
export class ProbeReplyError extends Error {
  constructor(
    public readonly code: 'timeout' | 'disconnected' | 'cancelled' | 'superseded' | 'overloaded',
    message: string,
  ) {
    super(message);
    this.name = 'ProbeReplyError';
  }
}

interface PendingReply {
  probeId: number;
  resolve: (payload: unknown) => void;
  reject: (err: ProbeReplyError) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const MAX_PENDING_REPLIES = 10_000;
const pendingReplies = new Map<string, PendingReply>();

function replyKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Waits for a probe's reply of `kind` to the request `id` (tunnel id, test
 * id, ...). Only a reply sent by probe `probeId` on its own control
 * connection resolves it (resolveProbeReply). Rejects with ProbeReplyError
 * on timeout, when the probe is disconnected (disconnectProbe), when the wait
 * is cancelled or when a newer wait for the same kind + id replaces it.
 * Register the wait BEFORE sending the request to the probe.
 */
export function waitForProbeReply<T>(kind: string, id: string, probeId: number, ms: number): Promise<T> {
  const key = replyKey(kind, id);
  return new Promise<T>((resolve, reject) => {
    const previous = pendingReplies.get(key);
    if (previous) {
      clearTimeout(previous.timeout);
      pendingReplies.delete(key);
      previous.reject(new ProbeReplyError('superseded', 'Replaced by a newer request'));
    }
    if (pendingReplies.size >= MAX_PENDING_REPLIES) {
      reject(new ProbeReplyError('overloaded', 'Too many requests waiting for a probe reply'));
      return;
    }
    const entry: PendingReply = {
      probeId,
      resolve: resolve as (payload: unknown) => void,
      reject,
      timeout: setTimeout(() => {
        if (pendingReplies.get(key) === entry) pendingReplies.delete(key);
        reject(new ProbeReplyError('timeout', 'The probe did not respond in time'));
      }, ms),
    };
    pendingReplies.set(key, entry);
  });
}

/**
 * Delivers a probe's reply to the matching waitForProbeReply. Ignored (false)
 * when nobody waits for it or when it comes from another probe than the one
 * the request was sent to.
 */
export function resolveProbeReply(kind: string, id: string, fromProbeId: number, payload: unknown): boolean {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return false;
  const key = replyKey(kind, id);
  const entry = pendingReplies.get(key);
  if (!entry) return false;
  if (entry.probeId !== fromProbeId) {
    logger.warn({ kind, fromProbeId, expectedProbeId: entry.probeId }, 'Probe reply ignored: sent by another probe');
    return false;
  }
  clearTimeout(entry.timeout);
  pendingReplies.delete(key);
  entry.resolve(payload);
  return true;
}

/** Abandons a wait (e.g. the request could not be sent). */
export function cancelProbeReply(kind: string, id: string): void {
  const key = replyKey(kind, id);
  const entry = pendingReplies.get(key);
  if (!entry) return;
  clearTimeout(entry.timeout);
  pendingReplies.delete(key);
  entry.reject(new ProbeReplyError('cancelled', 'Request cancelled'));
}

function rejectRepliesForProbe(probeId: number): void {
  for (const [key, entry] of pendingReplies) {
    if (entry.probeId !== probeId) continue;
    clearTimeout(entry.timeout);
    pendingReplies.delete(key);
    entry.reject(new ProbeReplyError('disconnected', 'The probe was disconnected'));
  }
}

/**
 * Tunnel open: resolves {} on tunnel_ready, {error} on tunnel_error, timeout
 * or disconnection. Thin wrapper over waitForProbeReply (kind 'tunnel').
 */
export function waitForTunnelResponse(tunnelId: string, probeId: number, timeoutMs = 15_000): Promise<{ error?: string }> {
  return waitForProbeReply<{ error?: string }>('tunnel', tunnelId, probeId, timeoutMs).catch((err: unknown) => {
    if (err instanceof ProbeReplyError && err.code === 'timeout') {
      return { error: 'Tunnel open timed out (probe did not respond)' };
    }
    if (err instanceof ProbeReplyError && err.code === 'disconnected') {
      return { error: 'Probe disconnected' };
    }
    return { error: 'Tunnel open cancelled' };
  });
}

// ─── Tunnel data WebSockets ─────────────────────────────────────────────────

/**
 * Consumer of a tunnel's data socket in HTTP relay mode (tunnelProxy.service):
 * every frame received after the probe's tunnel_hello, and the close.
 */
export interface TunnelDataHandler {
  onMessage(data: Buffer, isBinary: boolean): void;
  onClose(): void;
}

interface TunnelDataConn {
  ws: WebSocket;
  probeId: number;
  tenantId: number;
  attachedAt: number;
  /** Features of the probe's tunnel_hello (HTTP relay); null until (or unless) it is received. */
  features: string[] | null;
  handler: TunnelDataHandler | null;
}

/** Tunnel data WebSocket connections (tunnelId → WebSocket from the owning probe) */
const tunnelDataWs = new Map<string, TunnelDataConn>();

export function getTunnelDataWs(tunnelId: string): WebSocket | undefined {
  return tunnelDataWs.get(tunnelId)?.ws;
}

/** State of a tunnel's data socket (null when none is attached). */
export function getTunnelDataInfo(tunnelId: string): { attachedAt: number; features: string[] | null } | null {
  const entry = tunnelDataWs.get(tunnelId);
  if (!entry || entry.ws.readyState > WS_OPEN) return null;
  return { attachedAt: entry.attachedAt, features: entry.features };
}

type TunnelDataHelloListener = (tunnelId: string, features: string[]) => void;
let tunnelDataHelloListener: TunnelDataHelloListener | null = null;
/** tunnelId → callbacks waiting for its tunnel_hello (waitForTunnelDataHello). */
const tunnelHelloWaiters = new Map<string, Set<(features: string[] | null) => void>>();

/** Called once per data socket when the probe sends tunnel_hello (tunnelProxy.service). */
export function onTunnelDataHello(fn: TunnelDataHelloListener): void {
  tunnelDataHelloListener = fn;
}

function settleHelloWaiters(tunnelId: string, features: string[] | null): void {
  const waiters = tunnelHelloWaiters.get(tunnelId);
  if (!waiters) return;
  tunnelHelloWaiters.delete(tunnelId);
  for (const w of waiters) w(features);
}

/**
 * Resolves with the features of the tunnel's tunnel_hello, or null when none
 * came within `ms` (legacy probe) or the socket closed.
 */
export function waitForTunnelDataHello(tunnelId: string, ms: number): Promise<string[] | null> {
  const entry = tunnelDataWs.get(tunnelId);
  if (entry?.features) return Promise.resolve(entry.features);
  return new Promise((resolve) => {
    let waiters = tunnelHelloWaiters.get(tunnelId);
    if (!waiters) {
      if (tunnelHelloWaiters.size >= MAX_TRACKED_TUNNELS) {
        resolve(null);
        return;
      }
      waiters = new Set();
      tunnelHelloWaiters.set(tunnelId, waiters);
    }
    const waiter = (features: string[] | null) => {
      clearTimeout(timer);
      resolve(features);
    };
    const timer = setTimeout(() => {
      const set = tunnelHelloWaiters.get(tunnelId);
      set?.delete(waiter);
      if (set && set.size === 0) tunnelHelloWaiters.delete(tunnelId);
      resolve(null);
    }, ms);
    waiters.add(waiter);
  });
}

/**
 * The server is about to use `ws` as a legacy raw relay: its first binary
 * frame makes a new probe pick the raw relay too, so a tunnel_hello arriving
 * later on this socket must be ignored (no HTTP channel, no tunnel_mode text
 * frame written into the device's TCP stream).
 */
export function markTunnelDataLegacy(tunnelId: string, ws: WebSocket): void {
  const entry = tunnelDataWs.get(tunnelId);
  if (!entry || entry.ws !== ws || entry.features !== null) return;
  entry.features = [];
  settleHelloWaiters(tunnelId, []);
}

/** Routes the frames of an HTTP relay data socket to `handler` (false: no socket). */
export function setTunnelDataHandler(tunnelId: string, handler: TunnelDataHandler | null): boolean {
  const entry = tunnelDataWs.get(tunnelId);
  if (!entry) return false;
  entry.handler = handler;
  return true;
}

/** Sends a frame on a tunnel's data socket (text for a string). False when it is not open. */
export function sendTunnelData(tunnelId: string, data: string | Buffer): boolean {
  const entry = tunnelDataWs.get(tunnelId);
  if (!entry || entry.ws.readyState !== WS_OPEN) return false;
  try {
    entry.ws.send(data, { binary: typeof data !== 'string' }, (err) => {
      if (err) logger.debug({ err: err.message, tunnelId }, 'Tunnel data send failed');
    });
    return true;
  } catch {
    return false;
  }
}

/** A tunnel_hello frame: {type:'tunnel_hello', features: short strings}. null otherwise. */
export function parseTunnelHello(data: Buffer): string[] | null {
  if (data.length > 4096) return null;
  try {
    const msg = JSON.parse(data.toString('utf8')) as { type?: unknown; features?: unknown };
    if (!msg || msg.type !== 'tunnel_hello' || !Array.isArray(msg.features)) return null;
    return msg.features
      .filter((f): f is string => typeof f === 'string' && /^[a-z0-9_:.-]{1,32}$/i.test(f))
      .slice(0, 16);
  } catch {
    return null;
  }
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** A data socket is attached (connecting or open) for this tunnel. */
export function hasTunnelDataWs(tunnelId: string): boolean {
  const entry = tunnelDataWs.get(tunnelId);
  return entry != null && entry.ws.readyState <= WS_OPEN;
}

/**
 * Attaches the probe's data socket of a tunnel (the upgrade handler checked
 * that the tunnel belongs to this probe and tenant). Refuses (false) when a
 * socket is already attached: a second "probe" would otherwise receive the
 * traffic of the tunnel.
 */
export function registerTunnelDataWs(tunnelId: string, ws: WebSocket, probeId: number, tenantId: number): boolean {
  if (hasTunnelDataWs(tunnelId)) return false;
  const entry: TunnelDataConn = { ws, probeId, tenantId, attachedAt: Date.now(), features: null, handler: null };
  tunnelDataWs.set(tunnelId, entry);
  let dropped = false;
  const drop = () => {
    if (tunnelDataWs.get(tunnelId) === entry) tunnelDataWs.delete(tunnelId);
    if (dropped) return;
    dropped = true;
    settleHelloWaiters(tunnelId, null);
    const handler = entry.handler;
    entry.handler = null;
    try {
      handler?.onClose();
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, tunnelId }, 'Tunnel data close handler failed');
    }
  };
  // Without an 'error' listener a protocol error (bad frame, oversized
  // payload) would be thrown as an uncaught exception and stop the server.
  ws.on('error', (err) => {
    logger.warn({ err: err?.message, tunnelId, probeId }, 'Tunnel data WS error');
    drop();
    ws.terminate();
  });
  ws.on('close', drop);
  // Frames of the HTTP relay (probes announcing it with tunnel_hello); the
  // legacy raw relay reads the socket itself (tunnelProxy legacyExchange).
  // Nothing the probe sends may throw out of this listener.
  ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    touchTunnelActivity(tunnelId);
    try {
      if (entry.features === null) {
        if (isBinary) return;
        const features = parseTunnelHello(rawDataToBuffer(data));
        if (!features) return;
        entry.features = features;
        settleHelloWaiters(tunnelId, features);
        tunnelDataHelloListener?.(tunnelId, features);
        return;
      }
      entry.handler?.onMessage(rawDataToBuffer(data), isBinary);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, tunnelId, probeId }, 'Tunnel data frame handling failed');
    }
  });
  touchTunnelActivity(tunnelId);
  return true;
}

/** Closes and forgets the data socket of a tunnel (tunnel closed or expired). */
export function closeTunnelDataWs(tunnelId: string, code = 1000, reason = 'Tunnel closed'): void {
  const entry = tunnelDataWs.get(tunnelId);
  if (!entry) return;
  tunnelDataWs.delete(tunnelId);
  closeSocket(entry.ws, code, reason);
  settleHelloWaiters(tunnelId, null);
}

// tunnels.last_activity_at is written at most once a minute per tunnel.
const TUNNEL_ACTIVITY_WRITE_MS = 60 * 1000;
const MAX_TRACKED_TUNNELS = 10_000;
const tunnelActivityWrites = new Map<string, number>();

/** Records traffic on a tunnel (idle expiry, see tunnelService.cleanupStaleTunnels). */
export function touchTunnelActivity(tunnelId: string): void {
  const now = Date.now();
  const last = tunnelActivityWrites.get(tunnelId);
  if (last !== undefined && now - last < TUNNEL_ACTIVITY_WRITE_MS) return;
  if (last === undefined && tunnelActivityWrites.size >= MAX_TRACKED_TUNNELS) {
    for (const [id, at] of tunnelActivityWrites) {
      if (now - at > TUNNEL_ACTIVITY_WRITE_MS) tunnelActivityWrites.delete(id);
    }
    if (tunnelActivityWrites.size >= MAX_TRACKED_TUNNELS) tunnelActivityWrites.clear();
  }
  tunnelActivityWrites.set(tunnelId, now);
  db('tunnels')
    .where({ id: tunnelId })
    .whereIn('status', ['opening', 'active'])
    .update({ last_activity_at: new Date(now) })
    .catch((err: unknown) => logger.warn({ err: (err as Error)?.message, tunnelId }, 'tunnels.last_activity_at update failed'));
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function isProbeConnected(probeId: number): boolean {
  const conn = byProbeId.get(probeId);
  return conn != null && conn.ws.readyState === WS_OPEN;
}

export function getConnectedProbes(): Map<number, ProbeConn> {
  return byProbeId;
}

export function sendToProbe(probeId: number, msg: ProbeWsMessage): boolean {
  const conn = byProbeId.get(probeId);
  if (!conn) return false;
  return sendToConn(conn, msg);
}

/**
 * Marker of the last config_update delivered to this probe's live connection
 * (0: none, or not connected). Two reads differ when one was delivered in
 * between — on this connection or on a new one.
 */
export function lastConfigUpdateSeq(probeId: number): number {
  return byProbeId.get(probeId)?.lastConfigSeq ?? 0;
}

/**
 * Cuts a probe off: closes its control WebSocket and every tunnel data socket
 * it holds (probe refused / suspended / deleted, API key deleted). Waits for
 * replies of this probe are rejected. Returns true when something was closed.
 * A revoked probe that reconnects is refused by the upgrade handler.
 */
export function disconnectProbe(probeId: number, code = 4003, reason = 'revoked'): boolean {
  let closed = false;
  const conn = byProbeId.get(probeId);
  if (conn) {
    byProbeId.delete(probeId);
    closeSocket(conn.ws, code, reason);
    closed = true;
  }
  for (const [tunnelId, entry] of tunnelDataWs) {
    if (entry.probeId !== probeId) continue;
    tunnelDataWs.delete(tunnelId);
    closeSocket(entry.ws, code, reason);
    closed = true;
  }
  rejectRepliesForProbe(probeId);
  if (closed) logger.info({ probeId, code, reason }, 'Probe disconnected by the server');
  return closed;
}

/**
 * Identity v2: the probe row was re-keyed to the shared Obli* device ID
 * (probeIdentity.service). Its open control connection(s) follow, so their
 * scan_result keeps authenticating (authenticateConnectedProbe looks the row
 * up by UUID); the probe itself redials under the new UUID once it saw the
 * ack. Everything else in the hub is keyed by probe id and needs nothing.
 */
export function rekeyProbeConnections(probeId: number, newUuid: string): void {
  for (const conn of allConns) {
    if (conn.registered && conn.probeId === probeId) conn.probeUuid = newUuid;
  }
}

/**
 * Cuts off every control connection opened with API key `apiKeyId` of
 * `tenantId` (API key deleted): registered probes as disconnectProbe does
 * (with their tunnel data sockets), and unknown probes that have not
 * registered yet — getConnectedProbes() does not list those. Returns how many
 * open connections were closed.
 */
export function disconnectApiKey(apiKeyId: number, tenantId: number, code = 4003, reason = 'revoked'): number {
  let closed = 0;
  for (const conn of [...allConns]) {
    if (conn.apiKeyId !== apiKeyId || conn.tenantId !== tenantId) continue;
    const wasOpen = conn.ws.readyState === WS_OPEN;
    if (conn.registered && byProbeId.get(conn.probeId) === conn) {
      disconnectProbe(conn.probeId, code, reason);
    } else {
      closeSocket(conn.ws, code, reason);
    }
    if (wasOpen) closed++;
  }
  if (closed) logger.info({ apiKeyId, tenantId, closed, code, reason }, 'Probe connections of an API key closed by the server');
  return closed;
}

/** An unknown probe (no row yet) of this API key may still open a control WebSocket. */
export function canAcceptUnregisteredProbe(apiKeyId: number): boolean {
  return (unregisteredByKey.get(apiKeyId) ?? 0) < MAX_UNREGISTERED_PER_KEY;
}

// ─── Connection helpers ─────────────────────────────────────────────────────

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    try { ws.terminate(); } catch { /* ignore */ }
  }
}

function sendToConn(conn: ConnState, msg: ProbeWsMessage): boolean {
  if (conn.ws.readyState !== WS_OPEN) return false;
  try {
    conn.ws.send(JSON.stringify(msg));
    if (msg.type === PROBE_WS_MESSAGES.CONFIG_UPDATE) conn.lastConfigSeq = ++configUpdateSeq;
    return true;
  } catch {
    return false;
  }
}

/** Token bucket: true when the message may be processed. */
function takeRateToken(conn: ConnState): boolean {
  const now = Date.now();
  conn.bucketTokens = Math.min(RATE_BURST, conn.bucketTokens + ((now - conn.bucketAt) * RATE_PER_SEC) / 1000);
  conn.bucketAt = now;
  if (conn.bucketTokens >= 1) {
    conn.bucketTokens -= 1;
    return true;
  }
  return false;
}

function onRateExceeded(conn: ConnState): void {
  const now = Date.now();
  if (now - conn.dropWindowAt > ABUSE_WINDOW_MS) {
    if (conn.dropped > 0) {
      logger.warn({ probeId: conn.probeId || undefined, probeUuid: conn.probeUuid, dropped: conn.dropped }, 'Probe WS messages dropped (rate limit)');
    }
    conn.dropWindowAt = now;
    conn.dropped = 0;
  }
  conn.dropped += 1;
  if (conn.dropped > ABUSE_MAX_DROPS) {
    logger.warn({ probeId: conn.probeId || undefined, probeUuid: conn.probeUuid }, 'Probe WS closed: sustained message flood');
    closeSocket(conn.ws, 1008, 'Message rate exceeded');
  }
}

function parseMessage(data: WebSocket.RawData): ProbeWsMessage | null {
  const text = Array.isArray(data)
    ? Buffer.concat(data).toString('utf8')
    : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
  const msg = JSON.parse(text) as unknown;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const type = (msg as { type?: unknown }).type;
  if (typeof type !== 'string' || type.length === 0 || type.length > 64) return null;
  return msg as ProbeWsMessage;
}

/** Makes `conn` the live connection of probe `probeId` (replacing an older one). */
function bindConn(conn: ConnState, probeId: number): void {
  if (!conn.registered) {
    conn.registered = true;
    releaseUnregisteredSlot(conn);
  }
  conn.probeId = probeId;
  const existing = byProbeId.get(probeId);
  if (existing && existing !== conn) {
    closeSocket(existing.ws, 4000, 'Replaced by new connection');
  }
  byProbeId.set(probeId, conn);
}

function releaseUnregisteredSlot(conn: ConnState): void {
  if (conn.registerTimer) {
    clearTimeout(conn.registerTimer);
    conn.registerTimer = null;
  }
  if (!conn.holdsSlot) return;
  conn.holdsSlot = false;
  const n = (unregisteredByKey.get(conn.apiKeyId) ?? 1) - 1;
  if (n > 0) unregisteredByKey.set(conn.apiKeyId, n);
  else unregisteredByKey.delete(conn.apiKeyId);
}

/** Issues the per-probe identity token on this connection (see probeAuth.service). */
async function issueTokenOnConn(conn: ConnState): Promise<void> {
  if (!conn.registered || conn.issuedToken) return;
  const token = await issueProbeToken(conn.probeId);
  if (!token) return;
  conn.issuedToken = token;
  if (!sendToConn(conn, { type: PROBE_WS_MESSAGES.PROBE_TOKEN, token })) {
    // Not delivered: it stays pending (never bound) and a new one is issued on a later contact.
    conn.issuedToken = null;
  }
}

// ─── Connection Handler ─────────────────────────────────────────────────────

export interface RegisterProbeWsOptions {
  /** null: the probe has no row yet — it registers with its first scan_result. */
  probeId: number | null;
  tenantId: number;
  probeUuid: string;
  apiKeyId: number;
  /** X-Probe-Features header of the upgrade. */
  features?: string;
  ip?: string | null;
  /** authenticateProbe said so: issue the identity token right away. */
  shouldIssueToken?: boolean;
}

export async function registerProbeWs(ws: WebSocket, opts: RegisterProbeWsOptions): Promise<void> {
  const now = Date.now();
  const conn: ConnState = {
    ws,
    probeId: opts.probeId ?? 0,
    tenantId: opts.tenantId,
    probeUuid: opts.probeUuid,
    apiKeyId: opts.apiKeyId,
    registered: opts.probeId != null,
    features: opts.features ?? '',
    ip: opts.ip ?? null,
    issuedToken: null,
    bucketTokens: RATE_BURST,
    bucketAt: now,
    dropped: 0,
    dropWindowAt: now,
    lastParseWarnAt: 0,
    scanBusy: false,
    nextScan: undefined,
    lastScanAt: 0,
    scanTimer: null,
    lastHeartbeatWriteAt: 0,
    holdsSlot: false,
    registerTimer: null,
    lastHelloAt: 0,
    lastConfigSeq: 0,
    checkTokens: CHECK_BATCH_BURST,
    checkTokensAt: now,
    checkQueue: [],
    checkBusy: false,
    checkDropped: 0,
    checkDropLogAt: 0,
    checkInvalidWarnAt: 0,
  };

  // Listeners first, synchronously: a frame that arrives while the database
  // is being updated below must neither be lost nor raise an 'error' event
  // nobody listens to (which would crash the process).
  ws.on('message', (data: WebSocket.RawData) => {
    if (!takeRateToken(conn)) {
      onRateExceeded(conn);
      return;
    }
    let msg: ProbeWsMessage | null;
    try {
      msg = parseMessage(data);
    } catch {
      msg = null;
    }
    if (!msg) {
      const t = Date.now();
      if (t - conn.lastParseWarnAt > 60_000) {
        conn.lastParseWarnAt = t;
        logger.warn({ probeId: conn.probeId || undefined, probeUuid: conn.probeUuid }, 'Failed to parse probe WS message');
      }
      return;
    }
    handleProbeMessage(conn, msg).catch((err: unknown) => {
      logger.warn({ err, probeId: conn.probeId || undefined, type: msg!.type.slice(0, 64) }, 'Probe WS message handling failed');
    });
  });

  ws.on('close', () => {
    allConns.delete(conn);
    conn.issuedToken = null;
    if (conn.scanTimer) {
      clearTimeout(conn.scanTimer);
      conn.scanTimer = null;
    }
    conn.nextScan = undefined;
    releaseUnregisteredSlot(conn);
    if (conn.registered && byProbeId.get(conn.probeId) === conn) {
      byProbeId.delete(conn.probeId);
    }
    logger.info({ probeId: conn.probeId || undefined, probeUuid: conn.probeUuid }, 'Probe WS disconnected');
  });

  ws.on('error', (err) => {
    logger.warn({ err: err?.message, probeId: conn.probeId || undefined }, 'Probe WS error');
  });

  allConns.add(conn);

  if (opts.probeId == null) {
    // Unknown probe (its registration push failed or it was deleted): it
    // registers itself — as pending — with its first scan_result.
    unregisteredByKey.set(opts.apiKeyId, (unregisteredByKey.get(opts.apiKeyId) ?? 0) + 1);
    conn.holdsSlot = true;
    conn.registerTimer = setTimeout(() => {
      conn.registerTimer = null;
      if (!conn.registered) closeSocket(ws, 4001, 'Registration timeout');
    }, UNREGISTERED_TTL_MS);
    logger.info({ probeUuid: opts.probeUuid, tenantId: opts.tenantId }, 'Probe WS connected (not registered yet)');
    return;
  }

  bindConn(conn, opts.probeId);

  // Update last_seen_at (never for a probe revoked meanwhile)
  await db('probes')
    .where({ id: opts.probeId, tenant_id: opts.tenantId })
    .whereNotIn('status', ['refused', 'suspended'])
    .update({ last_seen_at: new Date() })
    .catch((err: unknown) => logger.error(err, 'Failed to update probe last_seen_at'));

  logger.info({ probeId: opts.probeId, probeUuid: opts.probeUuid, tenantId: opts.tenantId }, 'Probe WS connected (raw)');

  if (opts.shouldIssueToken) {
    await issueTokenOnConn(conn).catch((err: unknown) =>
      logger.warn({ err: (err as Error)?.message, probeId: opts.probeId }, 'Probe identity token issuance failed'));
  }
}

// ─── Message Dispatch ───────────────────────────────────────────────────────

async function handleProbeMessage(conn: ConnState, msg: ProbeWsMessage): Promise<void> {
  switch (msg.type) {
    case PROBE_WS_MESSAGES.SCAN_RESULT:
      onScanResult(conn, msg.payload);
      break;

    case PROBE_WS_MESSAGES.HEARTBEAT:
      await onHeartbeat(conn);
      break;

    case PROBE_WS_MESSAGES.TUNNEL_READY: {
      if (!conn.registered) break;
      if (typeof msg.tunnelId === 'string') {
        resolveProbeReply('tunnel', msg.tunnelId, conn.probeId, {});
      }
      break;
    }

    case PROBE_WS_MESSAGES.TUNNEL_ERROR: {
      if (!conn.registered) break;
      if (typeof msg.tunnelId === 'string') {
        const raw = typeof msg.error === 'string' && msg.error.trim() ? msg.error : 'Unknown error';
        // Shown to the admin and stored in tunnels.error_message: plain, short text.
        const error = raw.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200) || 'Unknown error';
        resolveProbeReply('tunnel', msg.tunnelId, conn.probeId, { error });
      }
      break;
    }

    case PROBE_WS_MESSAGES.PROBE_TOKEN_ACK:
      await onProbeTokenAck(conn, msg);
      break;

    case PROBE_WS_MESSAGES.UPDATE_ABORTED:
      await onUpdateAborted(conn, msg);
      break;

    case PROBE_WS_MESSAGES.HELLO:
      await onHello(conn, msg);
      break;

    case PROBE_WS_MESSAGES.CHECK_RESULTS:
      onCheckResults(conn, msg);
      break;

    case PROBE_WS_MESSAGES.CHECK_TEST_RESULT: {
      if (!conn.registered) break;
      // Resolves only the test sent to THIS probe (waitForProbeReply bound it
      // to the probe id); the result is validated by the waiting test.
      if (typeof msg.testId === 'string') {
        resolveProbeReply('check_test', msg.testId, conn.probeId, msg.result);
      }
      break;
    }

    default:
      logger.debug({ type: msg.type.slice(0, 64), probeId: conn.probeId || undefined }, 'Unknown probe WS message');
  }
}

function onScanResult(conn: ConnState, payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  // Newest wins: a result still waiting its turn is superseded, never lost
  // behind an older one.
  conn.nextScan = payload;
  pumpScans(conn);
}

/**
 * Processes the waiting scan_result of `conn`, one at a time and never sooner
 * than SCAN_MIN_INTERVAL_MS after the previous one finished: an early one is
 * deferred with a single timer per connection.
 */
function pumpScans(conn: ConnState): void {
  if (conn.scanBusy || conn.scanTimer || conn.nextScan === undefined) return;
  if (conn.ws.readyState !== WS_OPEN) {
    conn.nextScan = undefined;
    return;
  }
  const wait = conn.lastScanAt + SCAN_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) {
    conn.scanTimer = setTimeout(() => {
      conn.scanTimer = null;
      pumpScans(conn);
    }, wait);
    return;
  }
  const payload = conn.nextScan;
  conn.nextScan = undefined;
  conn.scanBusy = true;
  processScanResult(conn, payload)
    .catch((err: unknown) => {
      logger.warn({ err, probeId: conn.probeId || undefined }, 'Probe WS scan_result processing failed');
    })
    .finally(() => {
      conn.scanBusy = false;
      conn.lastScanAt = Date.now();
      pumpScans(conn);
    });
}

async function processScanResult(conn: ConnState, payload: unknown): Promise<void> {
  // Lazy import to avoid circular dependency at startup
  const { probeService } = await import('./probe.service');

  let result: unknown;
  if (conn.registered) {
    // The push re-checks what may have changed since the upgrade (key still
    // there, probe not refused / deleted / re-keyed) and never registers.
    result = await probeService.handlePush(
      '', // apiKey not needed — already authenticated at the upgrade
      conn.probeUuid,
      payload,
      conn.apiKeyId, // pass pre-validated key ID
    );
  } else {
    // Unknown probe: registered exactly as its HTTP push would register it
    // (same checks, same pending cap), with this connection's API key.
    const key = await db('probe_api_keys')
      .where({ id: conn.apiKeyId, tenant_id: conn.tenantId })
      .first('key') as { key: string } | undefined;
    if (!key) {
      closeSocket(conn.ws, 4003, 'revoked');
      return;
    }
    result = await probeService.handlePush(key.key, conn.probeUuid, payload, undefined, {
      features: conn.features,
      ip: conn.ip,
    });
  }
  const { httpStatus, ...body } = result as { httpStatus: number } & Record<string, unknown>;

  if (conn.ws.readyState !== WS_OPEN) return;

  if (httpStatus >= 400) {
    // Rejected: never answer with a config (an older probe would apply
    // defaults and lose its subnet exclusions).
    if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
      // Key deleted, probe refused / suspended / deleted since the upgrade:
      // cut it off; a reconnect goes through authenticateProbe again.
      if (conn.registered) disconnectProbe(conn.probeId, 4003, 'revoked');
      else closeSocket(conn.ws, 4003, 'revoked');
    } else if (!conn.registered && httpStatus === 409) {
      closeSocket(conn.ws, 4009, 'Registration refused'); // e.g. too many probes pending approval
    }
    // 400 (invalid payload): the connection stays, the next scan may be valid.
    return;
  }

  // A token delivered inside the config_update is confirmed like probe_token.
  const deliveredToken = typeof body.probeToken === 'string' && body.probeToken ? body.probeToken : null;

  let issueToken = false;
  if (!conn.registered) {
    // The push just registered this probe (pending): bind the connection to it.
    const row = await db('probes')
      .where({ uuid: conn.probeUuid, tenant_id: conn.tenantId })
      .first('id', 'status', 'api_key_id', 'token_hash') as
      { id: number; status: string; api_key_id: number | null; token_hash: string | null } | undefined;
    if (!row || row.status === 'refused' || row.status === 'suspended' || row.api_key_id !== conn.apiKeyId) {
      closeSocket(conn.ws, 4003, 'revoked');
      return;
    }
    if (conn.ws.readyState !== WS_OPEN) return;
    bindConn(conn, row.id);
    logger.info({ probeId: row.id, probeUuid: conn.probeUuid, tenantId: conn.tenantId }, 'Probe WS registered');
    issueToken = !deliveredToken && !row.token_hash && advertisesProbeToken(conn.features);
  }

  if (deliveredToken) conn.issuedToken = deliveredToken;

  sendToConn(conn, { type: PROBE_WS_MESSAGES.CONFIG_UPDATE, ...body });

  if (issueToken) await issueTokenOnConn(conn);
}

async function onHeartbeat(conn: ConnState): Promise<void> {
  // Always answered: the probe's read deadline relies on it.
  sendToConn(conn, { type: PROBE_WS_MESSAGES.HEARTBEAT_ACK });

  const now = Date.now();
  if (now - conn.lastHeartbeatWriteAt < HEARTBEAT_WRITE_MIN_MS) return;
  conn.lastHeartbeatWriteAt = now;

  if (!conn.registered) {
    // No probe row yet: only the API key it connected with can have been
    // revoked since the upgrade (a safety net next to disconnectApiKey).
    let key: unknown;
    try {
      key = await db('probe_api_keys').where({ id: conn.apiKeyId, tenant_id: conn.tenantId }).first('id');
    } catch {
      return;
    }
    if (!key && !conn.registered) closeSocket(conn.ws, 4003, 'revoked');
    return;
  }

  let updated: number;
  try {
    updated = await db('probes')
      .where({ id: conn.probeId, tenant_id: conn.tenantId, api_key_id: conn.apiKeyId })
      .whereNotIn('status', ['refused', 'suspended'])
      .update({ last_seen_at: new Date(now) });
  } catch {
    return;
  }
  if (!updated && byProbeId.get(conn.probeId) === conn) {
    // Deleted, refused / suspended or API key revoked since the upgrade.
    disconnectProbe(conn.probeId, 4003, 'revoked');
  }
}

/**
 * hello {probeVersion, capabilities, serverScheme}, sent right after the
 * connect: stores the capabilities and server scheme on the probe row and
 * answers with a config_update (Device Checks assignment included for a
 * capable probe). A probe without a row yet is ignored — the scan_result
 * that registers it carries the same fields.
 */
async function onHello(conn: ConnState, msg: ProbeWsMessage): Promise<void> {
  if (!conn.registered) return;
  const now = Date.now();
  if (conn.lastHelloAt !== 0 && now - conn.lastHelloAt < HELLO_MIN_INTERVAL_MS) return;
  // Set before processing so that concurrent hellos are gated too.
  conn.lastHelloAt = now;

  const parsed = helloSchema.safeParse(msg);
  if (!parsed.success) {
    logger.warn({ probeId: conn.probeId }, 'Probe WS hello ignored: malformed');
    return;
  }

  // Lazy import to avoid circular dependency at startup
  const { probeService } = await import('./probe.service');
  let reply: Awaited<ReturnType<typeof probeService.handleHello>>;
  try {
    reply = await probeService.handleHello(conn.tenantId, conn.probeId, conn.apiKeyId, parsed.data);
  } catch (err) {
    // Transient failure (database): a resent hello is processed at once.
    conn.lastHelloAt = 0;
    throw err;
  }
  if (!reply) {
    // Deleted, refused / suspended or re-keyed since the upgrade.
    if (byProbeId.get(conn.probeId) === conn) disconnectProbe(conn.probeId, 4003, 'revoked');
    return;
  }
  sendToConn(conn, { type: PROBE_WS_MESSAGES.CONFIG_UPDATE, ...reply });
}

/** Counts a dropped check_results batch; warns at most once a minute per connection. */
function noteDroppedCheckBatch(conn: ConnState, now: number, reason: 'rate' | 'queue'): void {
  conn.checkDropped += 1;
  if (now - conn.checkDropLogAt < CHECK_WARN_INTERVAL_MS) return;
  conn.checkDropLogAt = now;
  logger.warn({ probeId: conn.probeId, dropped: conn.checkDropped, reason },
    'Probe WS check_results batches dropped (at most one batch per second)');
  conn.checkDropped = 0;
}

/**
 * check_results: at most one batch per second per probe (extra ones dropped
 * and counted), then ingested with the identity of THIS connection — never a
 * probe or tenant id from the message.
 */
function onCheckResults(conn: ConnState, msg: ProbeWsMessage): void {
  if (!conn.registered) return;
  const now = Date.now();
  conn.checkTokens = Math.min(
    CHECK_BATCH_BURST,
    conn.checkTokens + ((now - conn.checkTokensAt) * CHECK_BATCHES_PER_SEC) / 1000,
  );
  conn.checkTokensAt = now;
  if (conn.checkTokens < 1) {
    noteDroppedCheckBatch(conn, now, 'rate');
    return;
  }
  conn.checkTokens -= 1;
  if (conn.checkQueue.length >= CHECK_QUEUE_MAX) {
    noteDroppedCheckBatch(conn, now, 'queue');
    return;
  }
  conn.checkQueue.push({ probeId: conn.probeId, tenantId: conn.tenantId, batch: msg });
  pumpCheckResults(conn);
}

/**
 * Ingests the waiting check_results of `conn`, one batch at a time. Batches
 * received before the socket closed are still ingested: they were
 * authenticated on arrival and the probe no longer holds them (ingest
 * re-checks that the probe is approved and on a site).
 */
function pumpCheckResults(conn: ConnState): void {
  if (conn.checkBusy) return;
  const next = conn.checkQueue.shift();
  if (!next) return;
  conn.checkBusy = true;
  ingest({ probeId: next.probeId, tenantId: next.tenantId }, next.batch)
    .then((r) => {
      if (r.rejected > 0) logger.debug({ probeId: next.probeId, accepted: r.accepted, rejected: r.rejected }, 'Probe check results ingested');
    })
    .catch((err: unknown) => {
      if (err instanceof AppError && err.statusCode === 400) {
        // Malformed batch: dropped, the connection stays.
        const t = Date.now();
        if (t - conn.checkInvalidWarnAt > CHECK_WARN_INTERVAL_MS) {
          conn.checkInvalidWarnAt = t;
          logger.warn({ probeId: next.probeId }, 'Probe WS check_results batch rejected: invalid payload');
        }
        return;
      }
      logger.warn({ err: (err as Error)?.message, probeId: next.probeId }, 'Probe WS check_results ingestion failed');
    })
    .finally(() => {
      conn.checkBusy = false;
      pumpCheckResults(conn);
    });
}

async function onProbeTokenAck(conn: ConnState, msg: ProbeWsMessage): Promise<void> {
  const token = conn.issuedToken;
  conn.issuedToken = null;
  if (!token || !conn.registered) return;
  if (msg.persisted !== true) {
    logger.warn({ probeId: conn.probeId }, 'Probe could not store its identity token — a new one is issued on a later contact');
    return;
  }
  const bound = await confirmIssuedProbeToken(conn.probeId, conn.tenantId, token, conn.ip);
  if (!bound) logger.warn({ probeId: conn.probeId }, 'Probe identity token acknowledgement not applied');
}

/**
 * update_aborted {reason, version, targetVersion}: the probe did not apply an
 * update. Recorded by probeService.recordUpdateAborted (shared with the HTTP
 * route of probes in HTTP mode, POST /api/probe/agent/update-aborted).
 */
async function onUpdateAborted(conn: ConnState, msg: ProbeWsMessage): Promise<void> {
  if (!conn.registered) return;
  // Lazy import to avoid circular dependency at startup
  const { probeService } = await import('./probe.service');
  await probeService.recordUpdateAborted(conn.tenantId, conn.probeId, {
    reason: msg.reason,
    version: msg.version,
    targetVersion: msg.targetVersion,
    ip: conn.ip,
    via: 'ws',
  });
}

// ─── Ping keepalive (every 15s, like Obliance) ──────────────────────────────

setInterval(() => {
  for (const conn of allConns) {
    if (conn.ws.readyState === WS_OPEN) {
      try { conn.ws.ping(); } catch { /* ignore */ }
    }
  }
}, 15_000).unref(); // the HTTP server keeps the process alive; tests can exit
