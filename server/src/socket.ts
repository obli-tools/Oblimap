import { Server as SocketIOServer } from 'socket.io';
import type { Socket } from 'socket.io';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'http';
import type { Request, Response, NextFunction } from 'express';
import type { SessionData } from 'express-session';
import { config } from './config';
import { logger } from './utils/logger';
import { db } from './db';
import { toDbId, validDbIds } from './utils/dbId';
import { userHasTenantAccess } from './utils/sessionTenant';
import { setUserSessionsIO, isSessionRevoked } from './services/userSessions.service';
import { permissionService } from './services/permission.service';
import {
  SOCKET_ROOM_CAPABILITIES,
  tenantCapabilityRoom,
  type SocketRoomCapability,
} from './services/tenant.service';
import { getSessionMiddleware, lookupSessionToken } from './app';

// Socket.io authentication (port of Obliance socket.ts). The identity comes
// from the SERVER-SIDE SESSION only:
//   1. the session cookie, loaded on the handshake request by the same
//      express-session middleware as the HTTP API (io.engine.use);
//   2. inside the ObliTools desktop shell, where the browser blocks cookies,
//      handshake.auth.token = the session id, resolved through the session
//      store (same rules as X-Auth-Token in app.ts).
// Client-supplied user or tenant ids are never read. Every failure answers
// the same connect_error 'unauthorized' (no user enumeration).
//
// There are no client → server events. If any are added, take the caller's
// identity and tenant from socket.data only, never from the payload.

type HandshakeRequest = IncomingMessage & {
  _query?: Record<string, string | undefined>;
  session?: Partial<SessionData>;
  sessionID?: string;
};

interface SocketUser {
  id: number;
  username: string;
  role: string;
}

interface SocketAuthData {
  user: SocketUser;
  tenantId: number | null;
  /**
   * Joins tenant:<tenantId>:admin: a platform admin, or an admin of that
   * tenant (user_tenants.role = 'admin'). Nobody else.
   */
  tenantAdmin: boolean;
  /**
   * Not a tenant admin: the SOCKET_ROOM_CAPABILITIES the user holds in the
   * current tenant — joins tenant:<tenantId>:cap:<capability> for each.
   */
  capabilityRooms: SocketRoomCapability[];
  /** Session behind the socket (read by userSessions.service to spare the caller's own session). */
  sessionId: string;
  /** Tenants whose live alerts this socket receives. */
  notificationTenantIds: number[];
}

let ioRef: SocketIOServer | null = null;

// ── Origin check (Cross-Site WebSocket Hijacking) ─────────────────────────
// Neither CORS nor SameSite stops a WebSocket upgrade from another origin
// (e.g. an app on a sibling sub-domain, same site): the handshake must come
// from the app itself.

function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** CLIENT_ORIGIN's origins and APP_URL's origin. */
const CONFIGURED_ORIGINS = new Set(
  [...config.clientOrigins, config.appUrl]
    .map(originOf)
    .filter((o): o is string => o !== null),
);

/**
 * Same rule as matchesHost in middleware/originCheck.ts: a Host value that
 * carries a port must equal the Origin's host:port (cookies are not isolated
 * by port: another port of the same host name is another origin). Only a
 * Host without a port (nginx $host drops it, the public port is unknown here)
 * falls back to comparing host names.
 */
function matchesHostHeader(source: URL, value: string | string[] | undefined): boolean {
  const host = (Array.isArray(value) ? value[0] : value)?.split(',')[0].trim().toLowerCase();
  if (!host) return false;
  if (source.host.toLowerCase() === host) return true;
  const hasPort = /:\d+$/.test(host) && !/^\[[^\]]*\]$/.test(host);
  return !hasPort && source.hostname.toLowerCase() === host;
}

/**
 * The handshake may go on when:
 *  - it has no Origin: a same-origin polling request (browsers omit Origin on
 *    same-origin GETs) or a non-browser client, which has no ambient cookie;
 *  - its Origin is CLIENT_ORIGIN / APP_URL;
 *  - the browser says Sec-Fetch-Site: same-origin (the ObliTools iframe runs
 *    on the app origin too);
 *  - for browsers without Fetch Metadata only, its Origin matches the Host
 *    the request was sent to (matchesHostHeader).
 * A browser that sends Sec-Fetch-Site and does not say same-origin is, by
 * its own account, on another origin: refused.
 */
function isAllowedHandshakeOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const parsed = originOf(origin); // the opaque "null" origin → refused
  if (!parsed) return false;
  if (CONFIGURED_ORIGINS.has(parsed)) return true;
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'same-origin') return true;
  if (fetchSite !== undefined) return false;
  const source = new URL(parsed);
  return matchesHostHeader(source, req.headers.host)
    || matchesHostHeader(source, req.headers['x-forwarded-host']);
}

/**
 * The address the rate limiters key on, computed as Express computes req.ip
 * with 'trust proxy' 1 (app.ts): the last X-Forwarded-For entry (appended by
 * the client container's nginx), else the socket peer.
 */
function handshakeAddress(req: IncomingMessage): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(xff) ? xff.join(',') : xff ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return hops.length > 0 ? hops[hops.length - 1] : req.socket?.remoteAddress;
}

// ── Session lifetime (same rules as middleware/sessionUserGuard.ts) ───────

function isPositiveTimestamp(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function sessionLifetimeExceeded(sess: Partial<SessionData>, now: number): boolean {
  const { lastSeenAt, loginAt } = sess;
  if (isPositiveTimestamp(lastSeenAt) && now - lastSeenAt > config.sessionIdleTimeoutMs) return true;
  if (isPositiveTimestamp(loginAt) && now - loginAt > config.sessionAbsoluteMaxMs) return true;
  return false;
}

/**
 * express-session on the engine.io HANDSHAKE request only (later polling /
 * upgrade requests carry the engine sid and reuse the handshake's identity),
 * and only for an acceptable Origin — a refused one is rejected by
 * allowRequest without a session lookup.
 */
function handshakeSessionMiddleware() {
  return (req: HandshakeRequest, res: ServerResponse, next: (err?: unknown) => void): void => {
    const sessionMw = getSessionMiddleware();
    if (!sessionMw || req._query?.sid !== undefined || !isAllowedHandshakeOrigin(req)) {
      next();
      return;
    }
    sessionMw(req as unknown as Request, res as unknown as Response, next as NextFunction);
  };
}

async function authenticate(socket: Socket): Promise<SocketAuthData | null> {
  const req = socket.request as HandshakeRequest;

  // 1. Cookie session.
  let sess: Partial<SessionData> | null = req.session ?? null;
  let sessionId: string | null = typeof req.sessionID === 'string' && req.sessionID ? req.sessionID : null;

  // 2. ObliTools: the session id as handshake.auth.token (lookups that miss
  //    are limited per address, see lookupSessionToken).
  if (toDbId(sess?.userId) === null) {
    sess = null;
    sessionId = null;
    const token = (socket.handshake.auth as Record<string, unknown> | undefined)?.token;
    const data = await lookupSessionToken(token, handshakeAddress(req));
    if (data && typeof token === 'string') {
      sess = data;
      sessionId = token;
    }
  }

  // Like requireAuth, only a completed sign-in counts: a session waiting for
  // its 2FA code holds pendingMfaUserId, never userId.
  const userId = toDbId(sess?.userId);
  if (!sess || userId === null || !sessionId) return null;
  if (isSessionRevoked(userId, sessionId)) return null;
  if (sessionLifetimeExceeded(sess, Date.now())) return null;

  const row = await db('users')
    .where({ id: userId, is_active: true })
    .first('id', 'username', 'role') as { id: number; username: string; role: string } | undefined;
  if (!row) return null;
  const user: SocketUser = { id: userId, username: String(row.username), role: String(row.role) };
  const isPlatformAdmin = user.role === 'admin';

  // The session's current tenant (what the REST API works in). Platform
  // admins may be in any existing tenant, everyone else only in a tenant
  // they are a member of. A tenant the user can no longer use (membership
  // removed, tenant deleted) counts as no tenant, as in requireTenant: the
  // socket still connects, without that tenant's rooms (socket.io-client does
  // not retry after a middleware refusal, so refusing would leave the live
  // connection dead). The session itself is corrected by the REST API
  // (requireTenant clears the tenant, /auth/me picks a valid one); a later
  // reconnect (tenant switch → reconnectSocket) joins the new tenant's rooms.
  // No tenant: only the user's own room and member notification rooms.
  let tenantId: number | null = null;
  if (sess.currentTenantId !== undefined && sess.currentTenantId !== null) {
    const tid = toDbId(sess.currentTenantId);
    if (tid !== null && await userHasTenantAccess(userId, tid, isPlatformAdmin)) tenantId = tid;
  }

  // Tenant admin room (admin-scope events: probes, groups, settings, device
  // check rules): platform admins, and the admins of the current tenant —
  // who hold every tenant capability there (permission.service).
  let tenantAdmin = false;
  if (tenantId !== null) {
    tenantAdmin = isPlatformAdmin || !!(await db('user_tenants')
      .where({ user_id: userId, tenant_id: tenantId, role: 'admin' })
      .first('user_id'));
  }

  // Capability rooms (tenant.service SOCKET_ROOM_CAPABILITIES): the members
  // of the current tenant who are not its admins but hold probes.manage /
  // deviceChecks.manage get that area's admin-scope events too, like the REST
  // routes the capability opens.
  const capabilityRooms = tenantId !== null && !tenantAdmin
    ? await socketRoomCapabilities(userId, tenantId)
    : [];

  // Live alerts: every tenant the user is a member of, plus the current one.
  const memberOf = await db('user_tenants').where({ user_id: userId }).pluck('tenant_id') as unknown[];
  const notificationTenantIds = [...new Set([...validDbIds(memberOf), ...(tenantId !== null ? [tenantId] : [])])];

  return { user, tenantId, tenantAdmin, capabilityRooms, sessionId, notificationTenantIds };
}

/** SOCKET_ROOM_CAPABILITIES the user holds in the tenant (permissionService, cached 10 s). */
async function socketRoomCapabilities(userId: number, tenantId: number): Promise<SocketRoomCapability[]> {
  const held = new Set<string>(await permissionService.listUserTenantCapabilities(userId, tenantId));
  return SOCKET_ROOM_CAPABILITIES.filter((c) => held.has(c));
}

// ── Sessions that end while their socket stays connected ─────────────────
// A kill (deactivation, deletion, demotion, password reset…) disconnects the
// user's sockets at once (userSessions.service). This sweep catches the rest:
// logout, idle / absolute expiry, a session dropped by sessionUserGuard.
const SWEEP_INTERVAL_MS = 5 * 60_000;
const SWEEP_CHUNK = 500;
let sweeping = false;

function parseSess(value: unknown): Partial<SessionData> | null {
  if (value && typeof value === 'object') return value as Partial<SessionData>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Partial<SessionData> : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function sweepSocketSessions(io: SocketIOServer): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const bySid = new Map<string, Socket[]>();
    for (const socket of io.of('/').sockets.values()) {
      const sid = (socket.data as Partial<SocketAuthData> | undefined)?.sessionId;
      if (typeof sid !== 'string' || !sid) { socket.disconnect(true); continue; }
      const list = bySid.get(sid);
      if (list) list.push(socket);
      else bySid.set(sid, [socket]);
    }
    if (bySid.size === 0) return;

    const alive = new Map<string, Partial<SessionData>>();
    const sids = [...bySid.keys()];
    for (let i = 0; i < sids.length; i += SWEEP_CHUNK) {
      const rows = await db('session')
        .whereIn('sid', sids.slice(i, i + SWEEP_CHUNK))
        .andWhere('expire', '>', db.fn.now())
        .select('sid', 'sess') as Array<{ sid: string; sess: unknown }>;
      for (const r of rows) {
        const sess = parseSess(r.sess);
        if (sess) alive.set(r.sid, sess);
      }
    }

    const now = Date.now();
    let ended = 0;
    for (const [sid, sockets] of bySid) {
      const sess = alive.get(sid);
      for (const socket of sockets) {
        const userId = (socket.data as Partial<SocketAuthData>).user?.id;
        if (!sess || toDbId(sess.userId) !== userId || sessionLifetimeExceeded(sess, now)) {
          socket.disconnect(true);
          ended++;
        }
      }
    }
    if (ended > 0) logger.info({ sockets: ended }, 'Sockets of ended sessions disconnected');
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'Socket session sweep failed');
  } finally {
    sweeping = false;
  }
}

// ── Tenant admins demoted while their socket stays connected ─────────────
// tenant:<id>:admin is joined at handshake only. A tenant admin whose role in
// that tenant changes (tenant membership / user tenants admin UI, SSO login
// role sync) keeps the room until reconnect unless something detaches it:
// this sweep re-reads user_tenants for the sockets of non-platform admins in
// an admin room and makes those no longer admin of that tenant leave it.
// Platform admins are left alone (a platform-role change kills their sessions
// and sockets). A promotion takes effect at the next reconnect.
const ADMIN_ROOM_SWEEP_INTERVAL_MS = 30_000;
let sweepingAdminRooms = false;

async function sweepTenantAdminRooms(io: SocketIOServer): Promise<void> {
  if (sweepingAdminRooms) return;
  sweepingAdminRooms = true;
  try {
    const inRoom: Array<{ socket: Socket; userId: number; tenantId: number }> = [];
    for (const socket of io.of('/').sockets.values()) {
      const data = socket.data as Partial<SocketAuthData> | undefined;
      const user = data?.user;
      const tenantId = data?.tenantId;
      if (!user || user.role === 'admin' || typeof tenantId !== 'number') continue;
      if (!socket.rooms.has(`tenant:${tenantId}:admin`)) continue;
      inRoom.push({ socket, userId: user.id, tenantId });
    }
    if (inRoom.length === 0) return;

    const stillAdmin = new Set<string>();
    const userIds = [...new Set(inRoom.map((s) => s.userId))];
    for (let i = 0; i < userIds.length; i += SWEEP_CHUNK) {
      const rows = await db('user_tenants')
        .whereIn('user_id', userIds.slice(i, i + SWEEP_CHUNK))
        .andWhere('role', 'admin')
        .select('user_id', 'tenant_id') as Array<{ user_id: unknown; tenant_id: unknown }>;
      for (const r of rows) stillAdmin.add(`${toDbId(r.user_id)}:${toDbId(r.tenant_id)}`);
    }

    let detached = 0;
    for (const { socket, userId, tenantId } of inRoom) {
      if (stillAdmin.has(`${userId}:${tenantId}`)) continue;
      void socket.leave(`tenant:${tenantId}:admin`);
      (socket.data as SocketAuthData).tenantAdmin = false;
      detached++;
    }
    if (detached > 0) logger.info({ sockets: detached }, 'Sockets of demoted tenant admins left the tenant admin room');
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'Tenant admin room sweep failed');
  } finally {
    sweepingAdminRooms = false;
  }
}

// ── Capabilities revoked while their socket stays connected ──────────────
// Same for the capability rooms (joined at handshake only): the sockets
// holding one re-resolve the user's capabilities in the socket's tenant
// (tenant role changed, permission set edited, membership removed) and leave
// the rooms of those no longer held. A grant takes effect at the next
// reconnect. Runs with the admin room sweep.
let sweepingCapabilityRooms = false;

async function sweepCapabilityRooms(io: SocketIOServer): Promise<void> {
  if (sweepingCapabilityRooms) return;
  sweepingCapabilityRooms = true;
  try {
    const held = new Map<string, Promise<SocketRoomCapability[]>>();
    let detached = 0;
    for (const socket of [...io.of('/').sockets.values()]) {
      const data = socket.data as Partial<SocketAuthData> | undefined;
      const user = data?.user;
      const tenantId = data?.tenantId;
      const rooms = data?.capabilityRooms;
      if (!user || user.role === 'admin' || typeof tenantId !== 'number' || !rooms || rooms.length === 0) continue;
      const key = `${user.id}:${tenantId}`;
      let pending = held.get(key);
      if (!pending) {
        pending = socketRoomCapabilities(user.id, tenantId);
        held.set(key, pending);
      }
      const still = new Set(await pending);
      const kept: SocketRoomCapability[] = [];
      for (const capability of rooms) {
        if (still.has(capability)) {
          kept.push(capability);
          continue;
        }
        void socket.leave(tenantCapabilityRoom(tenantId, capability));
        detached++;
      }
      (socket.data as SocketAuthData).capabilityRooms = kept;
    }
    if (detached > 0) logger.info({ rooms: detached }, 'Sockets left the rooms of revoked tenant capabilities');
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'Capability room sweep failed');
  } finally {
    sweepingCapabilityRooms = false;
  }
}

/**
 * Disconnects the live sockets bound to one session (e.g. on logout).
 * Returns the number of sockets disconnected. Never throws.
 */
export function disconnectSessionSockets(sessionId: string): number {
  if (!ioRef || typeof sessionId !== 'string' || !sessionId) return 0;
  let n = 0;
  try {
    for (const socket of ioRef.of('/').sockets.values()) {
      if ((socket.data as Partial<SocketAuthData> | undefined)?.sessionId !== sessionId) continue;
      socket.disconnect(true);
      n++;
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'Socket disconnect for a session failed');
  }
  return n;
}

export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      // Cross-origin browser requests: only the configured origins. Same-origin
      // requests need no CORS headers; the handshake itself is checked by
      // allowRequest below.
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        const parsed = origin ? originOf(origin) : null;
        callback(null, !origin || (parsed !== null && CONFIGURED_ORIGINS.has(parsed)));
      },
      credentials: true,
    },
    transports: ['polling', 'websocket'],
    // Every engine.io handshake (polling or direct WebSocket).
    allowRequest: (req, callback) => {
      if (isAllowedHandshakeOrigin(req)) {
        callback(null, true);
        return;
      }
      logger.warn('Socket.io handshake refused: cross-origin request');
      callback('unauthorized', false);
    },
  });
  ioRef = io;

  // Session kills (userSessions.service) disconnect the user's sockets.
  setUserSessionsIO(io);

  io.engine.use(handshakeSessionMiddleware());

  io.use(async (socket, next) => {
    try {
      const auth = await authenticate(socket);
      if (!auth) {
        next(new Error('unauthorized'));
        return;
      }
      Object.assign(socket.data as object, auth);
      next();
    } catch (err) {
      logger.error({ err: (err as Error)?.message }, 'Socket authentication error');
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { user, tenantId, tenantAdmin, capabilityRooms, notificationTenantIds } = socket.data as SocketAuthData;

    socket.join(`user:${user.id}`);
    if (tenantId !== null) {
      socket.join(`tenant:${tenantId}`);
      if (tenantAdmin) {
        socket.join(`tenant:${tenantId}:admin`);
      }
      for (const capability of capabilityRooms) socket.join(tenantCapabilityRoom(tenantId, capability));
    }
    for (const tid of notificationTenantIds) socket.join(`tenant:${tid}:notifications`);

    // All authenticated users join the general room
    socket.join('general');

    logger.info({ userId: user.id, tenantId }, 'Socket connected');

    socket.on('disconnect', () => {
      logger.debug({ userId: user.id }, 'Socket disconnected');
    });
  });

  const sweepTimer = setInterval(() => { void sweepSocketSessions(io); }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  const adminRoomTimer = setInterval(() => {
    void sweepTenantAdminRooms(io).then(() => sweepCapabilityRooms(io));
  }, ADMIN_ROOM_SWEEP_INTERVAL_MS);
  adminRoomTimer.unref();

  return io;
}
