import type { Request } from 'express';

// Session fields added by the security hardening. userId / username / role /
// currentTenantId / oauthState / requestedTenantSlug are declared in
// middleware/auth.ts and the pending MFA fields in
// controllers/twoFactor.controller.ts — do not redeclare them here.
declare module 'express-session' {
  interface SessionData {
    /** Epoch ms of the sign-in (absolute session lifetime, sessionUserGuard). */
    loginAt?: number;
    /** Epoch ms of the last request, written at most once a minute (idle timeout). */
    lastSeenAt?: number;
    /** Epoch ms at which the password step succeeded for pendingMfaUserId (10 min TTL). */
    pendingMfaAt?: number;
    /** Wrong 2FA codes entered for the current pending sign-in. */
    mfaFailures?: number;
    /** Epoch ms at which pendingTotpSecret was generated (10 min TTL). */
    pendingTotpSecretAt?: number;
  }
}

/**
 * Issues a NEW session id before a session gains privileges (login, 2FA
 * completion, SSO callback), so an id planted in the victim's browser before
 * sign-in (session fixation) never becomes authenticated. The old session row
 * is destroyed. [keep] lists the pre-login fields to carry over (e.g. a
 * pending MFA user, a requested tenant slug).
 *
 * The new session is stamped loginAt = lastSeenAt = now (sign-in time, read
 * by sessionUserGuard's absolute lifetime and idle timeout), so a sign-in
 * path cannot forget it. Pass { signIn: false } when the new session stays
 * anonymous (sign-out, sessionUserGuard dropping a session): an unstamped
 * empty session is not saved (saveUninitialized: false) and carries no stale
 * sign-in time.
 */
export function regenerateSession(
  req: Request,
  keep: string[] = [],
  opts: { signIn?: boolean } = {},
): Promise<void> {
  const session = req.session as unknown as Record<string, unknown>;
  const carried: Record<string, unknown> = {};
  for (const key of keep) {
    if (session[key] !== undefined) carried[key] = session[key];
  }
  const signIn = opts.signIn !== false;
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) { reject(err); return; }
      Object.assign(req.session as unknown as Record<string, unknown>, carried);
      if (signIn) {
        const now = Date.now();
        req.session.loginAt = now;
        req.session.lastSeenAt = now;
      }
      resolve();
    });
  });
}

/**
 * Persists the session now (before a redirect or a response the browser acts
 * on immediately, so the next request already sees the new state).
 */
export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) { reject(err); return; }
      resolve();
    });
  });
}
