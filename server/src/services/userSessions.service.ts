import type { Server as SocketIOServer, Socket } from 'socket.io';
import { db } from '../db';
import { logger } from '../utils/logger';

// Session kill-switch (port of Obliance services/userSessions.service.ts).
//
// requireAuth only checks that req.session.userId is set, and requireRole /
// the admin bypasses read req.session.role: a session outlives a
// deactivation, a deletion, a demotion or a password change/reset of its user
// until it expires (7 days). Every path that takes access away calls
// killSessionsForUser to delete the user's rows from the connect-pg-simple
// `session` table (sess is JSON) — including half-open sign-ins
// (pendingMfaUserId) — and to drop the user's live Socket.io connections
// (room `user:<id>`, joined at handshake).
//
// Deleting rows alone is not airtight: a request of that user already in
// flight loaded its session before the delete and, if it modifies the
// session, saves it back when it ends (connect-pg-simple `set` is an upsert).
// Two hooks let the request pipeline close that window:
//   - onUserSessionsKilled(fn): e.g. drop the session-user guard's cache;
//   - isSessionRevoked(userId, sid): true for a session id deleted by a kill
//     a moment ago (it came back only through such a save) — regenerate it.
// Revocation is tracked by session id, the ids the DELETE returned: a session
// created after the kill (a new sign-in) always has a new id and is never
// caught, whether or not it records its login time.

let _io: SocketIOServer | null = null;

/** Called once Socket.io exists (socket.ts / index.ts). */
export function setUserSessionsIO(io: SocketIOServer): void {
  _io = io;
}

type KillListener = (userId: number) => void;
const listeners = new Set<KillListener>();

/** Registers a callback run for every user whose sessions were killed. Returns an unsubscribe function. */
export function onUserSessionsKilled(fn: KillListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function notifyListeners(userId: number): void {
  for (const fn of listeners) {
    try { fn(userId); } catch (err) { logger.warn({ err, userId }, 'Session-kill listener failed'); }
  }
}

// Session ids deleted by a recent kill, to recognise a session resurrected by
// an in-flight request (same id saved back). In memory only: a restart ends
// every in-flight request anyway. Map order = revocation order (an id revoked
// again is re-inserted), so expiry and the size cap drop the oldest first.
const REVOCATION_TTL_MS = 10 * 60 * 1000;
const MAX_REVOKED_SIDS = 100_000;
const revokedSids = new Map<string, number>();

function pruneRevokedSids(now: number): void {
  for (const [sid, at] of revokedSids) {
    if (now - at <= REVOCATION_TTL_MS) break;
    revokedSids.delete(sid);
  }
}

function rememberRevokedSids(sids: Iterable<string>): void {
  const now = Date.now();
  pruneRevokedSids(now);
  for (const sid of sids) {
    revokedSids.delete(sid);
    revokedSids.set(sid, now);
  }
  // Over the cap: forget the oldest (their in-flight requests are long over).
  if (revokedSids.size > MAX_REVOKED_SIDS) {
    let excess = revokedSids.size - MAX_REVOKED_SIDS;
    for (const sid of revokedSids.keys()) {
      if (excess-- <= 0) break;
      revokedSids.delete(sid);
    }
  }
}

/** Session ids from a `DELETE … RETURNING sid` result. */
function returnedSids(rows: Array<{ sid?: unknown }> | undefined): string[] {
  const out: string[] = [];
  for (const r of rows ?? []) if (typeof r.sid === 'string' && r.sid) out.push(r.sid);
  return out;
}

/**
 * True when session `sid` was deleted by a kill a moment ago and came back
 * (in-flight request that saved it again): drop it. A session created after
 * the kill has a new id and is never reported. The session id alone
 * identifies the revocation: `_userId` and `_loginAt` are accepted for the
 * existing callers but not used. Cheap: in-memory lookup.
 */
export function isSessionRevoked(_userId: number, sid: string | undefined, _loginAt?: number): boolean {
  if (typeof sid !== 'string' || sid === '') return false;
  const at = revokedSids.get(sid);
  if (at === undefined) return false;
  if (Date.now() - at > REVOCATION_TTL_MS) {
    revokedSids.delete(sid);
    return false;
  }
  return true;
}

/** Session id behind a socket (set at handshake), when known. */
function socketSessionId(socket: Socket): string | null {
  const fromData = (socket.data as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof fromData === 'string' && fromData) return fromData;
  const fromReq = (socket.request as { sessionID?: unknown }).sessionID;
  return typeof fromReq === 'string' && fromReq ? fromReq : null;
}

/**
 * Disconnects the local sockets matching `select`. A socket whose session is
 * unknown is disconnected too (fail closed). Never throws.
 */
function disconnectLocalSockets(select: (socket: Socket) => boolean): number {
  if (!_io) return 0;
  let n = 0;
  try {
    for (const socket of _io.of('/').sockets.values()) {
      if (!select(socket)) continue;
      socket.disconnect(true);
      n++;
    }
  } catch (err) {
    logger.warn({ err }, 'Socket disconnect after session kill failed');
  }
  return n;
}

/**
 * Deletes every stored session of `userId` (signed-in or waiting for 2FA),
 * except `opts.exceptSid` (the caller's own session, e.g. "sign out my other
 * sessions" / own password change), and disconnects the user's sockets
 * (except those of the kept session). Returns the number of sessions deleted.
 * Throws on a database error: a failed revocation must not look successful.
 */
export async function killSessionsForUser(
  userId: number,
  reason: string,
  opts: { exceptSid?: string } = {},
): Promise<number> {
  if (!Number.isInteger(userId) || userId <= 0) return 0;
  const uid = String(userId);
  const exceptSid = typeof opts.exceptSid === 'string' && opts.exceptSid !== '' ? opts.exceptSid : null;

  // Text comparison (not ::int) so one malformed row can never make the whole
  // DELETE fail. Same expressions as the indexes of migration 036.
  const res = await db.raw(
    `DELETE FROM session
      WHERE ((sess->>'userId') = ? OR (sess->>'pendingMfaUserId') = ?)
        ${exceptSid ? 'AND sid <> ?' : ''}
      RETURNING sid`,
    exceptSid ? [uid, uid, exceptSid] : [uid, uid],
  ) as { rows?: Array<{ sid?: unknown }>; rowCount?: number } | undefined;
  const sids = returnedSids(res?.rows);
  const count = Number(res?.rowCount ?? sids.length);

  rememberRevokedSids(sids);
  notifyListeners(userId);

  let sockets = 0;
  if (_io) {
    if (!exceptSid) {
      try {
        sockets = _io.of('/').adapter.rooms.get(`user:${userId}`)?.size ?? 0;
        _io.in(`user:${userId}`).disconnectSockets(true);
      } catch (err) {
        logger.warn({ err, userId }, 'Socket disconnect after session kill failed');
      }
    } else {
      sockets = disconnectLocalSockets(
        (s) => s.rooms.has(`user:${userId}`) && socketSessionId(s) !== exceptSid,
      );
    }
  }

  logger.info({ userId, reason, count, sockets, keptCurrent: exceptSid !== null }, 'User sessions killed');
  return count;
}

/**
 * Deletes every stored session of every user except `exceptSid` (null = all),
 * and disconnects every socket not bound to the kept session. For platform
 * wide revocation (suspected session theft, secret rotation). Returns the
 * number of sessions deleted. Throws on a database error.
 */
export async function killAllSessionsExcept(exceptSid: string | null, reason = 'all_sessions_revoked'): Promise<number> {
  const keep = typeof exceptSid === 'string' && exceptSid !== '' ? exceptSid : null;
  const res = await db.raw(
    `DELETE FROM session ${keep ? 'WHERE sid <> ?' : ''}
     RETURNING sid, (sess->>'userId') AS user_id, (sess->>'pendingMfaUserId') AS pending_user_id`,
    keep ? [keep] : [],
  ) as { rows?: Array<{ sid?: unknown; user_id: string | null; pending_user_id: string | null }>; rowCount?: number } | undefined;
  const count = Number(res?.rowCount ?? res?.rows?.length ?? 0);

  rememberRevokedSids(returnedSids(res?.rows));
  const userIds = new Set<number>();
  for (const r of res?.rows ?? []) {
    for (const v of [r.user_id, r.pending_user_id]) {
      const id = Number(v);
      if (Number.isInteger(id) && id > 0) userIds.add(id);
    }
  }
  for (const id of userIds) notifyListeners(id);

  const sockets = disconnectLocalSockets((s) => !keep || socketSessionId(s) !== keep);
  logger.info({ reason, count, users: userIds.size, sockets, keptCurrent: keep !== null }, 'All sessions killed');
  return count;
}
