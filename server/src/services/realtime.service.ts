import type { Server as SocketIOServer } from 'socket.io';
import { SOCKET_EVENTS } from '@oblimap/shared';
import { logger } from '../utils/logger';
import { permissionService } from './permission.service';
import { clearReadableSitesCache } from './liveAlert.service';

// Real-time fan-out of site-scoped IPAM events.
//
// Admin rooms: `tenant:<id>:admin` (platform admins and tenant admins) gets
// the detailed events as before. Members of the tenant who read a site
// through a team permission get the site's events through emitToSiteReaders:
// the sockets of `tenant:<id>` whose user may read that site —
// permissionService.getVisibleSiteIds, what the REST reads of the same data
// enforce — never the whole tenant room. Each user's readable sites are
// cached 30 s per tenant (a revoked permission stops the events within
// 30 s). A tenant's deliveries go out in order (one queue per tenant).
//
// Group names never go to `tenant:<id>`: tree changes are announced with the
// payload-free TREE_CHANGED and clients refetch /groups/tree, which the
// server filters.

let _io: SocketIOServer | null = null;

/** Called by probe.service's io setter (setProbeServiceIO). */
export function setRealtimeIO(io: SocketIOServer | null): void {
  _io = io;
}

export function realtimeIO(): SocketIOServer | null {
  return _io;
}

// ── Readable sites cache ─────────────────────────────────────────────────────

const READ_CACHE_TTL_MS = 30_000;
const MAX_READ_CACHE = 10_000;
/** `${tenantId}:${userId}` → the sites the user reads in the tenant. */
const readableSitesCache = new Map<string, { at: number; sites: 'all' | ReadonlySet<number> }>();

/** Drops the cached readable sites (all users, or one user). */
export function clearRealtimeReadCache(userId?: number): void {
  if (userId === undefined) {
    readableSitesCache.clear();
    return;
  }
  for (const key of readableSitesCache.keys()) {
    if (key.endsWith(`:${userId}`)) readableSitesCache.delete(key);
  }
}

/**
 * Drops the cached readable sites of every user of one tenant: call it before
 * emitting after a change that moves sites between readers (a site moved to
 * another group, a group subtree moved), so the readers are computed after
 * the change.
 */
export function clearRealtimeReadCacheForTenant(tenantId: number): void {
  const prefix = `${tenantId}:`;
  for (const key of readableSitesCache.keys()) {
    if (key.startsWith(prefix)) readableSitesCache.delete(key);
  }
}

/** May this socket's user read the site? Cached 30 s per (tenant, user); fails closed. */
export async function socketUserCanReadSite(
  userId: number,
  isPlatformAdmin: boolean,
  tenantId: number,
  siteId: number,
): Promise<boolean> {
  // Platform admins read every site of the tenant (the site id comes from the tenant's own rows).
  if (isPlatformAdmin) return true;
  const key = `${tenantId}:${userId}`;
  const now = Date.now();
  let entry = readableSitesCache.get(key);
  if (!entry || now - entry.at >= READ_CACHE_TTL_MS) {
    try {
      const visible = await permissionService.getVisibleSiteIds(userId, tenantId, false);
      entry = { at: now, sites: visible === 'all' ? 'all' : new Set(visible) };
    } catch (err) {
      // Fail closed, not cached.
      logger.warn({ err: (err as Error)?.message, tenantId }, 'Realtime: site permission lookup failed');
      return false;
    }
    if (readableSitesCache.size >= MAX_READ_CACHE) readableSitesCache.clear();
    readableSitesCache.set(key, entry);
  }
  return entry.sites === 'all' || entry.sites.has(siteId);
}

// ── Site-reader fan-out ──────────────────────────────────────────────────────

interface SocketUserData {
  user?: { id?: unknown; role?: unknown };
  tenantId?: unknown;
}

export interface SiteReaderOptions {
  /**
   * Also deliver to the sockets of `tenant:<id>:admin`. Off by default: the
   * IPAM events are emitted to the admin room separately, and an admin
   * socket must not get them twice. Callers whose event does not go to the
   * admin room (e.g. device-check events) pass true.
   */
  includeAdminRoom?: boolean;
}

/** Sends `event` to the tenant's sockets whose user may read `siteId`. */
export async function deliverToSiteReaders(
  tenantId: number,
  siteId: number,
  event: string,
  payload: unknown,
  options: SiteReaderOptions = {},
): Promise<void> {
  const io = _io;
  if (!io) return;
  const adminRoom = `tenant:${tenantId}:admin`;
  const sockets = await io.in(`tenant:${tenantId}`).fetchSockets();
  const ids: string[] = [];
  for (const s of sockets) {
    if (!options.includeAdminRoom && s.rooms?.has(adminRoom)) continue;
    const data = (s.data ?? {}) as SocketUserData;
    const userId = Number(data.user?.id);
    if (!Number.isInteger(userId) || userId <= 0 || data.tenantId !== tenantId) continue;
    if (await socketUserCanReadSite(userId, data.user?.role === 'admin', tenantId, siteId)) ids.push(s.id);
  }
  if (ids.length > 0) io.to(ids).emit(event, payload);
}

const deliveryQueues = new Map<number, Promise<void>>();

/** Queues `event` for the tenant's sockets that may read `siteId` (never throws). */
export function emitToSiteReaders(
  tenantId: number,
  siteId: number,
  event: string,
  payload: unknown,
  options: SiteReaderOptions = {},
): void {
  if (!_io) return;
  const prev = deliveryQueues.get(tenantId) ?? Promise.resolve();
  const next = prev
    .then(() => deliverToSiteReaders(tenantId, siteId, event, payload, options))
    .catch((err: unknown) => logger.warn({ err: (err as Error)?.message, tenantId, siteId, event }, 'Realtime site event not delivered'));
  deliveryQueues.set(tenantId, next);
  void next.then(() => {
    if (deliveryQueues.get(tenantId) === next) deliveryQueues.delete(tenantId);
  });
}

/** Resolves once every queued site-reader delivery of the tenant went out (tests). */
export async function flushSiteReaderQueue(tenantId: number): Promise<void> {
  for (;;) {
    const pending = deliveryQueues.get(tenantId);
    if (!pending) return;
    await pending;
  }
}

// ── Other emits ──────────────────────────────────────────────────────────────

/** Payload-free: the tenant's group tree changed, clients refetch /groups/tree (filtered by the server). */
export function emitTreeChanged(tenantId: number): void {
  try {
    _io?.to(`tenant:${tenantId}`).emit(SOCKET_EVENTS.TREE_CHANGED);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, tenantId }, 'Realtime tree event not delivered');
  }
}

/** Emits to every socket of one user (room `user:<id>`). */
export function emitToUser(userId: number, event: string, payload: unknown): void {
  try {
    _io?.to(`user:${userId}`).emit(event, payload);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, event }, 'Realtime user event not delivered');
  }
}

/**
 * Payload-free PERMISSIONS_CHANGED to each user's own room (`user:<id>`):
 * their team grants, tenant role or permission set changed, the open clients
 * refetch their permissions and the group tree. Also drops the users' cached
 * readable sites, so site events follow the new grants at once.
 */
export function emitPermissionsChanged(userIds: Iterable<number>): void {
  const unique = new Set<number>();
  for (const id of userIds) {
    if (Number.isSafeInteger(id) && id > 0) unique.add(id);
  }
  for (const id of unique) {
    clearRealtimeReadCache(id);
    clearReadableSitesCache(id);
    try {
      _io?.to(`user:${id}`).emit(SOCKET_EVENTS.PERMISSIONS_CHANGED);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'Realtime permissions event not delivered');
    }
  }
}

/**
 * SITE_UPDATED {siteId} for the tenant's admins and the site's readers (each
 * socket once).
 */
export function emitSiteUpdated(tenantId: number, siteId: number): void {
  const payload = { siteId };
  try {
    _io?.to(`tenant:${tenantId}:admin`).emit(SOCKET_EVENTS.SITE_UPDATED, payload);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, tenantId, siteId }, 'Realtime site event not delivered');
  }
  emitToSiteReaders(tenantId, siteId, SOCKET_EVENTS.SITE_UPDATED, payload);
}

// ── Per-push coalescing ──────────────────────────────────────────────────────

/**
 * Events of one probe push on one site. The detailed per-device events
 * (ITEM_STATUS_CHANGED, NEW_DEVICE_DISCOVERED, DEVICE_IP_CHANGED,
 * IP_CONFLICT_DETECTED) go to the admin room right away; the site's readers
 * get one coalesced SITE_UPDATED at flush(), whatever the number of devices
 * — never a fetchSockets per device.
 */
export interface SiteEventBatch {
  readonly tenantId: number;
  readonly siteId: number;
  /** Detailed events sent to the admin room so far. */
  readonly changes: number;
  /** A detailed event for the tenant's admin room (sent now). */
  toAdmins(event: string, payload: unknown): void;
  /** One SITE_UPDATED {siteId} for the admins and the site's readers; later calls do nothing. */
  flush(): void;
}

export function createSiteEventBatch(tenantId: number, siteId: number): SiteEventBatch {
  let changes = 0;
  let flushed = false;
  return {
    tenantId,
    siteId,
    get changes() { return changes; },
    toAdmins(event: string, payload: unknown): void {
      changes += 1;
      try {
        _io?.to(`tenant:${tenantId}:admin`).emit(event, payload);
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, tenantId, siteId, event }, 'Realtime admin event not delivered');
      }
    },
    flush(): void {
      if (flushed) return;
      flushed = true;
      emitSiteUpdated(tenantId, siteId);
    },
  };
}
