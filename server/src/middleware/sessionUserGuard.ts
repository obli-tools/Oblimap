import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { regenerateSession } from '../utils/session';
import { isSessionRevoked, onUserSessionsKilled } from '../services/userSessions.service';

// The session's user is re-read on every request (port of Obliance
// middleware/sessionUserGuard.ts). Mounted in app.ts after the session
// middleware, before the rate limiter and every router.
//
// killSessionsForUser deletes the session rows of a disabled / deleted /
// demoted user, but a request of that user already in flight loaded its
// session BEFORE the delete and express-session saves it back when it ends
// (connect-pg-simple `set` is an upsert). Deleting rows is therefore not
// enough on its own. For a signed-in session this guard:
//   - drops the session (regenerate: old row deleted, the request continues
//     anonymous and requireAuth answers 401) when the user is missing or
//     inactive, when it has been idle longer than config.sessionIdleTimeoutMs,
//     when it is older than config.sessionAbsoluteMaxMs (loginAt), or when
//     killSessionsForUser revoked it a moment ago and an in-flight request
//     saved it back (isSessionRevoked — covers kills that leave the user
//     active, e.g. "password changed, sign out my other sessions");
//   - makes session.role / session.username follow the database (a demoted
//     admin loses the admin bypasses on the next request);
//   - records lastSeenAt at most once a minute (and loginAt for sessions
//     without one — from before the upgrade, or signed in without
//     regenerateSession — starting their absolute lifetime now).
// For every session it also expires a pending 2FA sign-in after 10 minutes
// (pendingMfaAt; recorded here on first sight when the sign-in did not).
//
// The user state is cached a few seconds; invalidateSessionUserCache(userId)
// drops it (call it after deactivating, deleting or changing the role of a
// user — killSessionsForUser already does, through onUserSessionsKilled).
// A database error answers 503: never let a possibly disabled user through.

const TTL_MS = 5_000;
const MAX_ENTRIES = 10_000;
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
const PENDING_MFA_TTL_MS = 10 * 60_000;

type UserState = { active: boolean; role: string; username: string } | null;
const cache = new Map<number, { at: number; state: UserState }>();

/** Drops the cached state of one user, or of everyone when userId is omitted. */
export function invalidateSessionUserCache(userId?: number): void {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

onUserSessionsKilled((userId) => invalidateSessionUserCache(userId));

async function stateOf(userId: number): Promise<UserState> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && now - hit.at < TTL_MS) return hit.state;
  const row = await db('users')
    .where({ id: userId })
    .first('id', 'is_active', 'role', 'username') as { is_active: boolean; role: string; username: string } | undefined;
  const state: UserState = row
    ? { active: row.is_active !== false, role: String(row.role), username: String(row.username) }
    : null;
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(userId, { at: now, state });
  return state;
}

function isPositiveTimestamp(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function unavailable(res: Response): void {
  res.status(503).json({ success: false, error: 'Service unavailable' });
}

/** Replaces the session with an empty one; the request continues anonymous. */
async function dropSession(req: Request, res: Response, next: NextFunction, userId: number, reason: string): Promise<void> {
  try {
    await regenerateSession(req, [], { signIn: false });
  } catch (err) {
    logger.error({ err, userId, reason }, 'sessionUserGuard: could not drop the session');
    unavailable(res);
    return;
  }
  logger.info({ userId, reason }, 'Session ended by sessionUserGuard');
  next();
}

export async function sessionUserGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = req.session;
  if (!session) { next(); return; }
  const now = Date.now();

  // ── Pending 2FA sign-in: 10 minutes to enter the code ─────────────────────
  // A pending sign-in without pendingMfaAt (set by a sign-in path that does
  // not record it yet, or from before the upgrade) gets its 10 minutes from
  // the first request that sees it, rather than being dropped at once — which
  // would make every 2FA sign-in through such a path fail.
  if (session.pendingMfaUserId !== undefined && session.pendingMfaUserId !== null) {
    const at = session.pendingMfaAt;
    if (!isPositiveTimestamp(at)) {
      session.pendingMfaAt = now;
    } else if (now - at > PENDING_MFA_TTL_MS) {
      const s = session as unknown as Record<string, unknown>;
      delete s.pendingMfaUserId;
      delete s.pendingMfaAt;
      delete s.pendingEmailOtp;
      delete s.mfaFailures;
    }
  }

  if (session.userId === undefined || session.userId === null) { next(); return; }
  const userId = Number(session.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    await dropSession(req, res, next, 0, 'invalid_user_id');
    return;
  }

  // ── Idle timeout / absolute lifetime ──────────────────────────────────────
  const { lastSeenAt, loginAt } = session;
  if (isPositiveTimestamp(lastSeenAt) && now - lastSeenAt > config.sessionIdleTimeoutMs) {
    await dropSession(req, res, next, userId, 'idle_timeout');
    return;
  }
  if (isPositiveTimestamp(loginAt) && now - loginAt > config.sessionAbsoluteMaxMs) {
    await dropSession(req, res, next, userId, 'absolute_timeout');
    return;
  }
  // A session killed a moment ago and saved back by an in-flight request.
  // Revocation is tracked by session id (the ids the kill deleted): a sign-in
  // after the kill has a new id and is never caught, whether or not its
  // sign-in path recorded loginAt.
  if (isSessionRevoked(userId, req.sessionID)) {
    await dropSession(req, res, next, userId, 'revoked');
    return;
  }

  // ── The user must still exist and be active ───────────────────────────────
  let state: UserState;
  try {
    state = await stateOf(userId);
  } catch (err) {
    logger.error({ err, userId }, 'sessionUserGuard: user lookup failed');
    unavailable(res);
    return;
  }
  if (!state || !state.active) {
    await dropSession(req, res, next, userId, state ? 'user_inactive' : 'user_missing');
    return;
  }

  if (session.role !== state.role) session.role = state.role;
  if (state.username && session.username !== state.username) session.username = state.username;

  if (!isPositiveTimestamp(loginAt)) session.loginAt = now;
  if (!isPositiveTimestamp(lastSeenAt) || now - lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
    session.lastSeenAt = now;
  }
  next();
}
