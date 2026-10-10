import { randomUUID } from 'crypto';
import { db } from '../db';
import { logger } from '../utils/logger';
import { PROBE_WS_MESSAGES, SOCKET_EVENTS } from '@oblimap/shared';
import type { Tunnel, TunnelListEntry, TunnelListStatus, TunnelStatus, TunnelScheme } from '@oblimap/shared';
import { realtimeIO } from './realtime.service';
import { tenantAdminEventRooms } from './tenant.service';
import {
  isProbeConnected,
  sendToProbe,
  waitForTunnelResponse,
  cancelProbeReply,
  closeTunnelDataWs,
} from './probeHub.service';
import { AppError } from '../middleware/errorHandler';
import { isRfc1918 } from '../validators/tunnel.schema';
import {
  clearTunnelProxyState,
  deviceHostNames,
  resolveTunnelRelayMode,
  setTunnelHttpOptions,
} from './tunnelProxy.service';

// ─── Constants ──────────────────────────────────────────────────────────────

const TUNNEL_OPEN_TIMEOUT_MS = 15_000;
const TUNNEL_INACTIVITY_TTL_MS = 30 * 60 * 1000; // 30 min without traffic
/** An 'opening' row older than this was abandoned (the open waits TUNNEL_OPEN_TIMEOUT_MS at most). */
const TUNNEL_OPENING_STALE_MS = 60_000;
const MAX_TUNNELS_PER_USER = 5;
const MAX_TUNNELS_PER_TENANT = 20;

const OPEN_STATUSES = ['opening', 'active'];

const TUNNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tunnel ids are UUIDs (tunnels.id is a uuid column: anything else would make Postgres raise). */
export function isTunnelId(value: unknown): value is string {
  return typeof value === 'string' && TUNNEL_ID_RE.test(value);
}

// ─── Row Helper ─────────────────────────────────────────────────────────────

function rowToTunnel(row: Record<string, unknown>): Tunnel {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as number,
    probeId: row.probe_id as number,
    siteId: row.site_id as number,
    targetIp: row.target_ip as string,
    targetPort: row.target_port as number,
    status: row.status as TunnelStatus,
    requestedBy: (row.requested_by as number | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    closedAt: row.closed_at ? (row.closed_at as Date).toISOString() : null,
  };
}

// ─── Supervision list (GET /api/tunnel) ─────────────────────────────────────

/** Statuses of a finished tunnel (the 'closed' list). */
const ENDED_STATUSES = ['closed', 'error'];

export type { TunnelListEntry, TunnelListStatus };

export const TUNNEL_LIST_DEFAULT_CLOSED_LIMIT = 50;
export const TUNNEL_LIST_MAX_LIMIT = 200;

export interface TunnelListQuery {
  status: TunnelListStatus;
  /** Max rows; null = no limit (the active list is bounded by MAX_TUNNELS_PER_TENANT). */
  limit: number | null;
}

/** Who looks at the tunnels: full access (platform / tenant admin) sees all of the tenant. */
export interface TunnelViewer {
  userId: number;
  fullAccess: boolean;
}

/**
 * Visibility filter of the tunnel list: null = every tunnel of the tenant
 * (full access), else only the tunnels this user opened.
 */
export function tunnelRequesterFilter(viewer: TunnelViewer): number | null {
  return viewer.fullAccess ? null : viewer.userId;
}

/** Whether the viewer may see (and close) this tunnel: theirs, or full access. */
export function canViewTunnel(tunnel: Pick<Tunnel, 'requestedBy'>, viewer: TunnelViewer): boolean {
  return viewer.fullAccess || (tunnel.requestedBy !== null && tunnel.requestedBy === viewer.userId);
}

/**
 * Parses ?status=active|closed (default active) and &limit (closed: default
 * 50, max 200; active: none unless given). Null when a value is invalid.
 */
export function parseTunnelListQuery(query: Record<string, unknown>): TunnelListQuery | null {
  const rawStatus = query.status;
  let status: TunnelListStatus = 'active';
  if (rawStatus !== undefined && rawStatus !== '') {
    if (rawStatus !== 'active' && rawStatus !== 'closed') return null;
    status = rawStatus;
  }

  const rawLimit = query.limit;
  let limit: number | null = status === 'closed' ? TUNNEL_LIST_DEFAULT_CLOSED_LIMIT : null;
  if (rawLimit !== undefined && rawLimit !== '') {
    if (typeof rawLimit !== 'string' || !/^\d{1,6}$/.test(rawLimit)) return null;
    const n = Number(rawLimit);
    if (n < 1) return null;
    limit = Math.min(n, TUNNEL_LIST_MAX_LIMIT);
  }
  return { status, limit };
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  const ms = timeMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function rowToListEntry(row: Record<string, unknown>): TunnelListEntry {
  const probeName = (row.probe_name as string | null) || (row.probe_hostname as string | null) || null;
  return {
    ...rowToTunnel(row),
    lastActivityAt: isoOrNull(row.last_activity_at),
    requestedByUsername: (row.requested_by_username as string | null) ?? null,
    probeName,
    siteName: (row.site_name as string | null) ?? null,
  };
}

// ─── Live updates ───────────────────────────────────────────────────────────

/**
 * TUNNEL_CHANGED {tunnelId, status} to the tenant's admins, the probes.manage
 * holders and the tunnel's opener. Ids only: listeners refetch GET /tunnel,
 * which applies the visibility rules. Never throws.
 */
function emitTunnelChanged(tenantId: number, tunnelId: string, status: TunnelStatus, requestedBy: number | null): void {
  const io = realtimeIO();
  if (!io) return;
  try {
    // exact: tunnels need tunnels.use, not probes.read (no probes.read room).
    const rooms = new Set(tenantAdminEventRooms(tenantId, 'probes.manage', { exact: true }));
    rooms.add(`tenant:${tenantId}:admin`);
    if (requestedBy !== null && requestedBy !== undefined) rooms.add(`user:${requestedBy}`);
    io.to([...rooms]).emit(SOCKET_EVENTS.TUNNEL_CHANGED, { tunnelId, status });
  } catch (err) {
    logger.warn({ err, tunnelId }, 'TUNNEL_CHANGED emit failed');
  }
}

/**
 * Tells the probe to drop the tunnel, closes its data socket and revokes its
 * web proxy links.
 */
function tearDownRelay(tunnelId: string, probeId: number): void {
  if (isProbeConnected(probeId)) {
    sendToProbe(probeId, { type: PROBE_WS_MESSAGES.TUNNEL_CLOSE, tunnelId });
  }
  closeTunnelDataWs(tunnelId);
  clearTunnelProxyState(tunnelId);
}

function timeMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).getTime();
  return NaN;
}

// ─── Tunnel Service ─────────────────────────────────────────────────────────

export const tunnelService = {
  /**
   * Open a tunnel through a probe to a device of a site.
   * The site must belong to the tenant and the target must be one of its
   * known devices (private IPv4). An explicit probeId must be an approved
   * probe of that site; otherwise one is auto-selected. `scheme` is what a
   * probe with the HTTP relay speaks to the device (web proxy).
   */
  async openTunnel(
    tenantId: number,
    userId: number,
    siteId: number,
    targetIp: string,
    targetPort: number,
    probeId?: number | null,
    scheme: TunnelScheme = 'auto',
  ): Promise<Tunnel> {
    if (!isRfc1918(targetIp)) {
      throw new AppError(400, 'targetIp must be a private (RFC 1918) IPv4 address');
    }
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      throw new AppError(400, 'targetPort must be between 1 and 65535');
    }

    const site = await db('sites').where({ id: siteId, tenant_id: tenantId }).first('id');
    if (!site) throw new AppError(404, 'Site not found');

    const item = await db('site_items')
      .where({ site_id: siteId, tenant_id: tenantId, ip: targetIp })
      .first('id', 'hostname') as { id: number; hostname: string | null } | undefined;
    if (!item) {
      throw new AppError(400, 'The target is not a known device of this site');
    }

    // Rate limits
    const userCount = await db('tunnels')
      .where({ requested_by: userId, tenant_id: tenantId })
      .whereIn('status', OPEN_STATUSES)
      .count('* as cnt')
      .first();
    if (Number(userCount?.cnt ?? 0) >= MAX_TUNNELS_PER_USER) {
      throw new AppError(429, `Maximum ${MAX_TUNNELS_PER_USER} concurrent tunnels per user`);
    }

    const tenantCount = await db('tunnels')
      .where({ tenant_id: tenantId })
      .whereIn('status', OPEN_STATUSES)
      .count('* as cnt')
      .first();
    if (Number(tenantCount?.cnt ?? 0) >= MAX_TUNNELS_PER_TENANT) {
      throw new AppError(429, `Maximum ${MAX_TUNNELS_PER_TENANT} concurrent tunnels per tenant`);
    }

    if (probeId) {
      // Explicit probe: an approved probe of this site and tenant only.
      const probe = await db('probes')
        .where({ id: probeId, tenant_id: tenantId, site_id: siteId, status: 'approved' })
        .first('id');
      if (!probe) throw new AppError(404, 'Probe not found on this site');
    } else {
      // Auto-select probe if not specified
      probeId = await this.selectProbe(tenantId, siteId, targetIp);
    }

    if (!probeId) {
      throw new AppError(400, 'No available probe for this site. Ensure at least one probe is approved and assigned.');
    }

    if (!isProbeConnected(probeId)) {
      throw new AppError(503, 'Selected probe is not connected via WebSocket. Tunnels require probes running v2.0+ with WS support. Rebuild and redeploy the probe binary.');
    }

    // Create tunnel record
    const tunnelId = randomUUID();
    await db('tunnels').insert({
      id: tunnelId,
      tenant_id: tenantId,
      probe_id: probeId,
      site_id: siteId,
      target_ip: targetIp,
      target_port: targetPort,
      status: 'opening',
      requested_by: userId,
    });
    emitTunnelChanged(tenantId, tunnelId, 'opening', userId);

    // Options of the HTTP relay, sent to the probe when its data socket
    // announces the relay (tunnelProxy.service).
    setTunnelHttpOptions(tunnelId, { scheme, hostNames: deviceHostNames(item.hostname), targetPort });

    // Wait for tunnel_ready / tunnel_error from THIS probe (registered before
    // the request is sent so a fast answer cannot be missed).
    const reply = waitForTunnelResponse(tunnelId, probeId, TUNNEL_OPEN_TIMEOUT_MS);

    // Send tunnel_open command to probe via WS
    const sent = sendToProbe(probeId, {
      type: PROBE_WS_MESSAGES.TUNNEL_OPEN,
      tunnelId,
      targetIp,
      targetPort,
    });
    if (!sent) {
      cancelProbeReply('tunnel', tunnelId);
      clearTunnelProxyState(tunnelId);
      const failed = await db('tunnels').where({ id: tunnelId }).whereIn('status', OPEN_STATUSES).update({
        status: 'error',
        error_message: 'Probe not connected',
        closed_at: new Date(),
      });
      if (failed) emitTunnelChanged(tenantId, tunnelId, 'error', userId);
      throw new AppError(503, 'Selected probe is not connected via WebSocket.');
    }

    const result = await reply;

    if (result.error) {
      const failed = await db('tunnels').where({ id: tunnelId }).whereIn('status', OPEN_STATUSES).update({
        status: 'error',
        error_message: result.error,
        closed_at: new Date(),
      });
      if (failed) emitTunnelChanged(tenantId, tunnelId, 'error', userId);
      // A late success on the probe must not leave a relay behind.
      tearDownRelay(tunnelId, probeId);
      throw new AppError(502, `Tunnel failed: ${result.error}`);
    }

    // Mark as active — unless it was closed while opening (dialog closed).
    const activated = await db('tunnels')
      .where({ id: tunnelId, status: 'opening' })
      .update({ status: 'active', last_activity_at: new Date() });
    if (activated) {
      emitTunnelChanged(tenantId, tunnelId, 'active', userId);
      // The relay mode (HTTP relay or legacy stream) is known within a moment.
      await resolveTunnelRelayMode(tunnelId);
    } else {
      tearDownRelay(tunnelId, probeId);
    }

    const row = await db('tunnels').where({ id: tunnelId }).first();
    return rowToTunnel(row!);
  },

  /**
   * Auto-select the best probe for a tunnel among the approved,
   * WebSocket-connected probes of the site.
   * Priority: discoverer → primary → least loaded.
   */
  async selectProbe(tenantId: number, siteId: number, targetIp: string): Promise<number | null> {
    const siteProbes = await db('probes')
      .where({ site_id: siteId, tenant_id: tenantId, status: 'approved' })
      .select('id', 'is_primary');

    const candidates = siteProbes.filter((p) => isProbeConnected(p.id as number));
    if (candidates.length === 0) return null;
    const candidateIds = new Set(candidates.map((p) => p.id as number));

    // 1. Prefer probe that discovered the device
    const item = await db('site_items')
      .where({ site_id: siteId, tenant_id: tenantId, ip: targetIp })
      .first('discovered_by_probe_id');
    const discoverer = (item?.discovered_by_probe_id as number | null) ?? null;
    if (discoverer && candidateIds.has(discoverer)) return discoverer;

    // 2. Prefer primary probe
    const primary = candidates.find((p) => p.is_primary === true);
    if (primary) return primary.id as number;

    // 3. Pick least loaded WS-connected probe on this site
    const ids = [...candidateIds];
    const tunnelCounts = await db('tunnels')
      .whereIn('probe_id', ids)
      .whereIn('status', OPEN_STATUSES)
      .groupBy('probe_id')
      .select('probe_id')
      .count('* as cnt');

    const countMap = new Map(tunnelCounts.map((r) => [r.probe_id as number, Number(r.cnt)]));

    // Sort by least tunnels
    ids.sort((a, b) => (countMap.get(a) ?? 0) - (countMap.get(b) ?? 0));
    return ids[0];
  },

  /**
   * Closes a tunnel of the tenant (probe relay and data socket included).
   * Returns the tunnel as it was before closing (null when unknown in this
   * tenant) and whether this call closed it.
   */
  async closeTunnel(tunnelId: string, tenantId: number): Promise<{ tunnel: Tunnel; closed: boolean } | null> {
    if (!isTunnelId(tunnelId)) return null;
    const row = await db('tunnels').where({ id: tunnelId, tenant_id: tenantId }).first();
    if (!row) return null;
    const tunnel = rowToTunnel(row);
    if (!OPEN_STATUSES.includes(tunnel.status)) return { tunnel, closed: false };

    const closed = await db('tunnels')
      .where({ id: tunnelId, tenant_id: tenantId })
      .whereIn('status', OPEN_STATUSES)
      .update({ status: 'closed', closed_at: new Date() });

    // Send close command to probe (also stops an open still in progress)
    tearDownRelay(tunnelId, tunnel.probeId);
    cancelProbeReply('tunnel', tunnelId);

    if (Number(closed) > 0) emitTunnelChanged(tenantId, tunnelId, 'closed', tunnel.requestedBy);
    return { tunnel, closed: Number(closed) > 0 };
  },

  async getTunnel(tunnelId: string, tenantId: number): Promise<Tunnel | null> {
    if (!isTunnelId(tunnelId)) return null;
    const row = await db('tunnels').where({ id: tunnelId, tenant_id: tenantId }).first();
    return row ? rowToTunnel(row) : null;
  },

  /**
   * Supervision list of the tenant: the open tunnels (newest first) or the
   * finished ones (closed / error, newest closed_at first), restricted to
   * one opener when requestedBy is set (tunnelRequesterFilter). Enriched with
   * the opener's username, the probe and site names.
   */
  async listTunnelEntries(
    tenantId: number,
    query: TunnelListQuery,
    requestedBy: number | null,
  ): Promise<TunnelListEntry[]> {
    const q = db('tunnels as t')
      .leftJoin('users as u', 'u.id', 't.requested_by')
      .leftJoin('probes as p', function joinProbe() {
        this.on('p.id', '=', 't.probe_id').andOn('p.tenant_id', '=', 't.tenant_id');
      })
      .leftJoin('sites as s', function joinSite() {
        this.on('s.id', '=', 't.site_id').andOn('s.tenant_id', '=', 't.tenant_id');
      })
      .where('t.tenant_id', tenantId)
      .select(
        't.*',
        'u.username as requested_by_username',
        'p.name as probe_name',
        'p.hostname as probe_hostname',
        's.name as site_name',
      );
    if (requestedBy !== null) q.andWhere('t.requested_by', requestedBy);
    if (query.status === 'active') {
      q.whereIn('t.status', OPEN_STATUSES).orderBy('t.created_at', 'desc');
    } else {
      q.whereIn('t.status', ENDED_STATUSES)
        .orderByRaw('t.closed_at DESC NULLS LAST')
        .orderBy('t.created_at', 'desc');
    }
    if (query.limit !== null) q.limit(query.limit);
    const rows = await q;
    return (rows as Record<string, unknown>[]).map(rowToListEntry);
  },

  /**
   * Cleanup stale tunnels: probe disconnected, no traffic for
   * TUNNEL_INACTIVITY_TTL_MS (last_activity_at, else created_at), or stuck
   * in 'opening'. The probe is told to drop the relay and the data socket is
   * closed.
   */
  async cleanupStaleTunnels(): Promise<void> {
    const open = await db('tunnels')
      .whereIn('status', OPEN_STATUSES)
      .select('id', 'tenant_id', 'requested_by', 'probe_id', 'status', 'created_at', 'last_activity_at');

    const now = Date.now();
    let expired = 0;
    for (const tunnel of open) {
      const probeId = tunnel.probe_id as number;
      const createdAt = timeMs(tunnel.created_at);
      const lastActivity = tunnel.last_activity_at ? timeMs(tunnel.last_activity_at) : createdAt;

      let reason: string | null = null;
      if (!isProbeConnected(probeId)) reason = 'Probe disconnected';
      else if (Number.isFinite(lastActivity) && now - lastActivity > TUNNEL_INACTIVITY_TTL_MS) reason = 'Inactivity timeout';
      else if (tunnel.status === 'opening' && Number.isFinite(createdAt) && now - createdAt > TUNNEL_OPENING_STALE_MS) reason = 'Open timed out';
      if (!reason) continue;

      const updated = await db('tunnels')
        .where({ id: tunnel.id as string })
        .whereIn('status', OPEN_STATUSES)
        .update({ status: 'closed', error_message: reason, closed_at: new Date() });
      tearDownRelay(tunnel.id as string, probeId);
      if (updated) {
        expired += 1;
        emitTunnelChanged(
          tunnel.tenant_id as number,
          tunnel.id as string,
          'closed',
          (tunnel.requested_by as number | null) ?? null,
        );
        logger.info({ tunnelId: tunnel.id, reason }, 'Closed stale tunnel');
      }
    }

    if (expired > 0) {
      logger.info({ count: expired }, 'Closed expired tunnels');
    }
  },

  /** At startup: tunnels left open by the previous process cannot work any more. */
  async closeOrphanedTunnels(): Promise<void> {
    const closed = await db('tunnels')
      .whereIn('status', OPEN_STATUSES)
      .update({ status: 'closed', error_message: 'Server restarted', closed_at: new Date() });
    if (closed > 0) logger.info({ count: closed }, 'Closed tunnels left open before the restart');
  },
};
