import type { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';
import { appConfigService } from '../services/appConfig.service';
import { twoFactorService, createPendingEmailOtp } from '../services/twoFactor.service';
import { permissionService } from '../services/permission.service';
import { auditService } from '../services/audit.service';
import { killSessionsForUser } from '../services/userSessions.service';
import { AppError } from '../middleware/errorHandler';
import { invalidateAccountPolicyCache } from '../middleware/accountPolicy';
import { noteLoginAccountFailure, clearLoginAccountFailures } from '../middleware/rateLimiter';
import { config } from '../config';
import { obligateService } from '../services/obligate.service';
import { db } from '../db';
import { regenerateSession } from '../utils/session';
import { pickInitialTenantId, userHasTenantAccess } from '../utils/sessionTenant';
import { clientIp } from '../utils/clientIp';
import { toDbId } from '../utils/dbId';
import { hashPassword } from '../utils/crypto';
import { logger } from '../utils/logger';
import { assertPasswordNotUsername } from '../validators/password';
import { REQUIRED_ENROLLMENT_VERSION } from './enrollment.controller';
import type { LoginInput, SetPasswordInput } from '../validators/auth.schema';

/** Ends the session (sign-in refused, account gone). Never throws. */
export function destroySession(req: Request): Promise<void> {
  return new Promise((resolve) => {
    if (!req.session) { resolve(); return; }
    req.session.destroy((err) => {
      if (err) logger.warn({ err }, 'Session destroy failed');
      resolve();
    });
  });
}

function auditLoginFailed(req: Request, username: string, reason: string, userId: number | null = null): Promise<void> {
  return auditService.logReq(req, {
    tenantId: null,
    userId,
    action: 'auth.login_failed',
    resourceType: 'user',
    resourceId: userId,
    details: { username, reason },
  });
}

/** A non-admin without any tenant membership: no session (never fall back to tenant 1). */
async function refuseNoTenant(req: Request, res: Response, user: { id: number; username: string }): Promise<void> {
  logger.warn({ userId: user.id }, 'Sign-in refused: the account is a member of no tenant (assign one in Admin > Users)');
  await auditLoginFailed(req, user.username, 'no_tenant_access', user.id);
  await destroySession(req);
  res.status(403).json({ success: false, error: 'no_tenant_access' });
}

/**
 * Last step of every local sign-in (password alone, or password + 2FA code):
 * picks the tenant, then moves the user into a NEW session so an id planted
 * before sign-in never becomes authenticated (session fixation).
 * regenerateSession stamps loginAt = lastSeenAt = now (sessionUserGuard's
 * absolute lifetime and idle timeout). When a non-admin has no tenant it
 * answers 403 no_tenant_access itself and returns false.
 */
export async function completeSignIn(
  req: Request,
  res: Response,
  user: { id: number; username: string; role: string },
  via: string,
): Promise<boolean> {
  const isPlatformAdmin = user.role === 'admin';
  const tenantId = await pickInitialTenantId(user.id, {
    isPlatformAdmin,
    preferredSlug: req.session.requestedTenantSlug,
  });
  if (tenantId === null && !isPlatformAdmin) {
    await refuseNoTenant(req, res, user);
    return false;
  }

  // The requested tenant slug was consumed above: not carried over.
  await regenerateSession(req);
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  if (tenantId !== null) req.session.currentTenantId = tenantId;

  await auditService.logReq(req, {
    tenantId,
    userId: user.id,
    action: 'auth.login',
    resourceType: 'user',
    resourceId: user.id,
    details: { username: user.username, via },
  });
  return true;
}

// Sign-in codes mailed per account (password step + resends): at most
// SIGNIN_MAIL_MAX per window, so re-posting a known password cannot flood the
// owner's mailbox. resend-email also has its own limiter and cooldown.
const SIGNIN_MAIL_WINDOW_MS = 15 * 60 * 1000;
const SIGNIN_MAIL_MAX = 5;
const MAX_TRACKED_ACCOUNTS = 10_000;
const signInMails = new Map<number, number[]>();

function takeSignInMailSlot(userId: number, now: number = Date.now()): boolean {
  const recent = (signInMails.get(userId) ?? []).filter((t) => now - t < SIGNIN_MAIL_WINDOW_MS);
  if (recent.length >= SIGNIN_MAIL_MAX) {
    signInMails.set(userId, recent);
    return false;
  }
  if (!signInMails.has(userId) && signInMails.size >= MAX_TRACKED_ACCOUNTS) signInMails.clear();
  recent.push(now);
  signInMails.set(userId, recent);
  return true;
}

/**
 * Mails a sign-in code to the pending 2FA user. Only the code's hash is kept
 * in the session, bound to that user and address (twoFactor.service
 * checkEmailOtp).
 */
export async function mailSignInCode(
  req: Request,
  userId: number,
  email: string,
): Promise<'sent' | 'no_smtp' | 'capped' | 'failed'> {
  const cfg = await appConfigService.getAll();
  if (!cfg.otp_smtp_server_id) return 'no_smtp';
  if (!takeSignInMailSlot(userId)) {
    logger.warn({ userId }, 'Sign-in code not mailed: per-account limit reached');
    return 'capped';
  }
  const code = twoFactorService.generateEmailOtp();
  req.session.pendingEmailOtp = createPendingEmailOtp(code, userId, email);
  req.session.emailOtpSentAt = Date.now();
  try {
    await twoFactorService.sendEmailOtp(Number(cfg.otp_smtp_server_id), email, code);
    return 'sent';
  } catch (err) {
    delete req.session.pendingEmailOtp;
    delete req.session.emailOtpSentAt;
    logger.warn({ err: (err as Error)?.message, userId }, 'Sign-in code could not be mailed');
    return 'failed';
  }
}

export const authController = {
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username, password } = req.body as LoginInput;
      const user = await authService.authenticate(username, password);

      if (!user) {
        // Per-account bound, counted only now: a flood of wrong passwords can
        // never refuse the right one (see noteLoginAccountFailure).
        const flood = noteLoginAccountFailure(username);
        if (flood.flooded) {
          // Past the limit: one warning and audit row for the flood, not one
          // per wrong guess.
          if (flood.crossed) {
            logger.warn({ username, ip: clientIp(req) || null },
              'Sign-in: too many failed passwords for one account in 15 min — possible password spray');
            await auditService.logReq(req, {
              tenantId: null,
              userId: null,
              action: 'auth.login_flood',
              resourceType: 'user',
              details: { username, windowMinutes: 15 },
            });
          }
          res.setHeader('Retry-After', String(flood.retryAfterSec));
          res.status(429).json({ success: false, error: 'Too many requests' });
          return;
        }
        await auditLoginFailed(req, username, 'invalid_credentials');
        throw new AppError(401, 'Invalid username or password');
      }
      clearLoginAccountFailures(username);

      let methods = { totp: user.totpEnabled ?? false, email: user.emailOtpEnabled ?? false };

      // SSO account (Obligate, og_): it signs in through Obligate. A local
      // password alone must never open a session — it would bypass the
      // Obligate password / MFA and survive their change. Accepted only with
      // a LOCAL TOTP, which is then required (e-mail codes are not enough).
      // Evaluated once the password is proven: a wrong password answers like
      // any other account (no enumeration). (Obliance auth.controller.ts.)
      if (user.foreignSource === 'obligate') {
        const f = await db('users').where({ id: user.id }).first('totp_enabled', 'totp_secret') as
          { totp_enabled: boolean | null; totp_secret: string | null } | undefined;
        if (!(f?.totp_enabled && f?.totp_secret)) {
          await auditLoginFailed(req, user.username, 'use_sso', user.id);
          res.status(403).json({ success: false, error: 'use_sso' });
          return;
        }
        methods = { totp: true, email: false };
      }

      // A code mailed to an earlier sign-in in this browser never carries over.
      delete req.session.pendingEmailOtp;

      if (methods.totp || methods.email) {
        // No tenant to land in: refuse now rather than after mailing a code.
        if (user.role !== 'admin') {
          const tenantId = await pickInitialTenantId(user.id, {
            isPlatformAdmin: false,
            preferredSlug: req.session.requestedTenantSlug,
          });
          if (tenantId === null) {
            await refuseNoTenant(req, res, user);
            return;
          }
        }

        // Step 1 of 2: a NEW session id holding only the pending sign-in
        // (10 minutes, 5 wrong codes — see twoFactorController.verify).
        await regenerateSession(req, ['requestedTenantSlug'], { signIn: false });
        req.session.pendingMfaUserId = user.id;
        req.session.pendingMfaAt = Date.now();
        req.session.mfaFailures = 0;

        // If email OTP is enabled, auto-send a code (a failure is logged; the
        // user can still use the authenticator app or ask for a new code).
        if (methods.email && user.email) {
          await mailSignInCode(req, user.id, user.email);
        }

        res.json({
          success: true,
          data: {
            requires2fa: true,
            methods,
          },
        });
        return;
      }

      // No 2FA — complete session immediately
      if (!(await completeSignIn(req, res, user, 'password'))) return;

      // Return sessionToken for ObliTools iframe context where cookies are blocked.
      // The client stores this and sends it back as X-Auth-Token on every request.
      res.json({ success: true, data: { user, sessionToken: req.sessionID } });
    } catch (err) {
      next(err);
    }
  },

  // No requireAuth: a half-open sign-in (waiting for its 2FA code) can sign out too.
  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.session) {
        res.json({ success: true, message: 'Logged out' });
        return;
      }
      const userId = toDbId(req.session.userId);
      const tenantId = toDbId(req.session.currentTenantId);
      const ipAddress = clientIp(req) || null;
      const sid = req.sessionID;
      req.session.destroy((err) => {
        if (err) {
          next(new AppError(500, 'Failed to logout'));
          return;
        }
        res.clearCookie(config.sessionCookieName, { path: '/' });
        if (config.sessionCookieName !== 'connect.sid') res.clearCookie('connect.sid', { path: '/' });
        // End the live socket of this session now (the periodic sweep is only
        // the backstop). Lazy import: socket.ts imports app.ts, which loads
        // the routes and this controller.
        if (sid) {
          void import('../socket')
            .then(({ disconnectSessionSockets }) => { disconnectSessionSockets(sid); })
            .catch(() => { /* best effort */ });
        }
        if (userId !== null) {
          void auditService.log({
            tenantId, userId, action: 'auth.logout', resourceType: 'user', resourceId: userId, ipAddress,
          });
        }
        res.json({ success: true, message: 'Logged out' });
      });
    } catch (err) {
      next(err);
    }
  },

  async me(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;

      // Sync preferences from Obligate for SSO users (throttled, non-blocking)
      const fRow = await db('users').where({ id: userId }).select('foreign_source', 'foreign_id').first() as
        { foreign_source: string | null; foreign_id: number | null } | undefined;
      if (fRow?.foreign_source === 'obligate' && fRow.foreign_id) {
        await obligateService.syncUserPreferences(userId, fRow.foreign_id).catch(() => {});
      }

      const user = await authService.getUserById(userId);
      if (!user || !user.isActive) {
        await destroySession(req);
        throw new AppError(401, 'Authentication required');
      }

      // Tenant: repair a missing one (e.g. sessions from older releases) and
      // drop one the user no longer has access to. Never fall back to tenant 1.
      const isAdmin = user.role === 'admin';
      let tenantId = toDbId(req.session.currentTenantId);
      if (tenantId !== null && !(await userHasTenantAccess(user.id, tenantId, isAdmin))) tenantId = null;
      if (tenantId === null) {
        tenantId = await pickInitialTenantId(user.id, { isPlatformAdmin: isAdmin });
        if (tenantId === null && !isAdmin) {
          logger.warn({ userId: user.id }, 'Session ended: the account is a member of no tenant (assign one in Admin > Users)');
          await destroySession(req);
          res.status(403).json({ success: false, error: 'no_tenant_access' });
          return;
        }
        if (tenantId !== null) req.session.currentTenantId = tenantId;
        else delete req.session.currentTenantId;
      }

      const permissions = await permissionService.getUserPermissions(user.id, isAdmin, tenantId);

      // Check if force 2FA applies to this user. Like enforceAccountPolicy:
      // local accounts only — an SSO account's second factor is owned by the
      // identity provider.
      let requires2faSetup = false;
      if (!config.disable2faForce && !user.foreignSource) {
        const cfg = await appConfigService.getAll();
        if (cfg.force_2fa && !user.totpEnabled && !user.emailOtpEnabled) {
          requires2faSetup = true;
        }
      }

      res.json({
        success: true,
        data: {
          user,
          permissions,
          requires2faSetup,
          mustChangePassword: user.mustChangePassword === true,
          currentTenantId: req.session.currentTenantId,
        },
      });
    } catch (err) {
      next(err);
    }
  },

  async permissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = req.session.role === 'admin';
      const permissions = await permissionService.getUserPermissions(
        req.session.userId!, isAdmin, toDbId(req.session.currentTenantId),
      );
      res.json({ success: true, data: permissions });
    } catch (err) {
      next(err);
    }
  },

  // First local password of a LOCAL account that has none, during enrollment
  // only. Any other password change goes through PUT /api/profile/password,
  // which requires the current password.
  // Never for an Obligate SSO account (og_): its enrollment never completes
  // (ProtectedRoute skips it), so this route would stay open for good, with
  // no proof, and a local password + local TOTP would sign in around
  // Obligate. Obliance removed the route for that reason.
  async setPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      const { password } = req.body as SetPasswordInput;

      const row = await db('users').where({ id: userId })
        .first('username', 'email', 'password_hash', 'enrollment_version', 'foreign_source') as
        {
          username: string; email: string | null; password_hash: string | null;
          enrollment_version: number | null; foreign_source: string | null;
        } | undefined;
      if (!row) throw new AppError(401, 'User not found');
      if (row.foreign_source === 'obligate') {
        res.status(403).json({ success: false, error: 'use_sso' });
        return;
      }
      if (row.password_hash || (row.enrollment_version ?? 0) >= REQUIRED_ENROLLMENT_VERSION) {
        res.status(403).json({ success: false, error: 'use_profile_password' });
        return;
      }
      assertPasswordNotUsername(password, row.username);

      const hash = await hashPassword(password);
      const now = new Date();
      // Conditional: two concurrent requests cannot both set a password, and
      // an account linked to Obligate in the meantime is left alone.
      const updated = await db('users')
        .where({ id: userId })
        .where((q) => q.whereNull('password_hash').orWhere('password_hash', ''))
        .where((q) => q.whereNull('enrollment_version').orWhere('enrollment_version', '<', REQUIRED_ENROLLMENT_VERSION))
        .where((q) => q.whereNull('foreign_source').orWhereNot('foreign_source', 'obligate'))
        .update({ password_hash: hash, password_changed_at: now, must_change_password: false, updated_at: now });
      if (!updated) {
        res.status(403).json({ success: false, error: 'use_profile_password' });
        return;
      }

      invalidateAccountPolicyCache(userId);
      await killSessionsForUser(userId, 'password_set', { exceptSid: req.sessionID });
      await auditService.logReq(req, { action: 'user.password_set', resourceType: 'user', resourceId: userId });
      twoFactorService.notifyInBackground(row.email, 'Password set', [
        'A password was set for your account.',
        'If this was not you, contact an administrator.',
      ]);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
};
