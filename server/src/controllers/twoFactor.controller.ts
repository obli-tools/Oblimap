import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import {
  twoFactorService,
  createPendingEmailOtp,
  checkEmailOtp,
  maskEmail,
  EMAIL_OTP_MAX_ATTEMPTS,
  EMAIL_OTP_RESEND_COOLDOWN_MS,
  type PendingEmailOtp,
} from '../services/twoFactor.service';
import { appConfigService } from '../services/appConfig.service';
import { authService } from '../services/auth.service';
import { auditService } from '../services/audit.service';
import { AppError } from '../middleware/errorHandler';
import { invalidateAccountPolicyCache } from '../middleware/accountPolicy';
import { comparePassword } from '../utils/crypto';
import { toDbId } from '../utils/dbId';
import { config } from '../config';
import { logger } from '../utils/logger';
import { completeSignIn, mailSignInCode } from './auth.controller';

// Extend session type for 2FA state (pendingMfaAt, mfaFailures and
// pendingTotpSecretAt are declared in utils/session.ts)
declare module 'express-session' {
  interface SessionData {
    pendingMfaUserId?: number;
    pendingMfaLinkToken?: string;
    pendingTotpSecret?: string;
    /** The pending TOTP setup replaces a live TOTP (a current code of it was given at /totp/setup). */
    pendingTotpReplaces?: boolean;
    pendingEmailOtp?: PendingEmailOtp;
    pendingEmailOtpSetup?: PendingEmailOtp;
    /** Epoch ms of the last sign-in code mailed in this session (resend cooldown). */
    emailOtpSentAt?: number;
  }
}

/** A pending sign-in has 10 minutes and 5 wrong codes, then the password is asked again. */
const PENDING_MFA_TTL_MS = 10 * 60 * 1000;
const MAX_MFA_FAILURES = 5;
/** A TOTP secret shown by /totp/setup must be confirmed within 10 minutes. */
const PENDING_TOTP_TTL_MS = 10 * 60 * 1000;

const NOT_YOU = 'If this was not you, change your password now and ask an administrator to reset your two-factor authentication.';

type FactorRow = {
  username: string;
  password_hash: string | null;
  totp_enabled: boolean | null;
  totp_secret: string | null;
  email_otp_enabled: boolean | null;
  email: string | null;
  foreign_source: string | null;
};

function clearPendingMfa(req: Request): void {
  delete req.session.pendingMfaUserId;
  delete req.session.pendingMfaAt;
  delete req.session.mfaFailures;
  delete req.session.pendingEmailOtp;
  delete req.session.emailOtpSentAt;
}

function clearPendingTotp(req: Request): void {
  delete req.session.pendingTotpSecret;
  delete req.session.pendingTotpSecretAt;
  delete req.session.pendingTotpReplaces;
}

/** The pending sign-in is older than 10 minutes (or predates pendingMfaAt). */
function pendingMfaExpired(req: Request): boolean {
  const at = req.session.pendingMfaAt;
  return typeof at !== 'number' || !Number.isFinite(at) || Date.now() - at > PENDING_MFA_TTL_MS;
}

function codeFrom(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
}

function bodyOf(req: Request): Record<string, unknown> {
  return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
}

async function loadFactorRow(userId: number): Promise<FactorRow> {
  const row = await db('users')
    .where({ id: userId })
    .first('username', 'password_hash', 'totp_enabled', 'totp_secret', 'email_otp_enabled', 'email', 'foreign_source') as
    FactorRow | undefined;
  if (!row) throw new AppError(401, 'User not found');
  return row;
}

function liveTotpSecret(row: FactorRow): string | null {
  return row.totp_enabled && row.totp_secret ? row.totp_secret : null;
}

/** Setting up a factor needs 2FA to be allowed (force_2fa implies it: users must be able to comply). */
async function assert2faAllowed(): Promise<void> {
  const cfg = await appConfigService.getAll();
  const forced = cfg.force_2fa && !config.disable2faForce;
  if (!cfg.allow_2fa && !forced) {
    throw new AppError(403, 'Two-factor authentication is disabled by the administrator');
  }
}

/** force_2fa applies to this account (local accounts only, as in enforceAccountPolicy). */
async function isFactorRequired(foreignSource: string | null): Promise<boolean> {
  if (config.disable2faForce || foreignSource) return false;
  const cfg = await appConfigService.getAll();
  return cfg.force_2fa === true;
}

/** A current code of the live authenticator app, used once (anti-replay). */
async function requireCurrentTotp(userId: number, secret: string, code: unknown): Promise<void> {
  const token = codeFrom(code);
  if (!token) throw new AppError(400, 'Enter a current code from your authenticator app');
  const result = await twoFactorService.verifyCurrentTotp(userId, secret, token);
  if (result === 'replayed') throw new AppError(400, 'This code was already used. Wait for the next code.');
  if (result !== 'ok') throw new AppError(400, 'Invalid authenticator code');
}

/**
 * The current password. An account without a local password (Obligate SSO:
 * its second factor belongs to the identity provider) cannot give one: 403.
 */
async function requireCurrentPassword(row: FactorRow, password: unknown): Promise<void> {
  if (!row.password_hash) {
    throw new AppError(403, 'This account has no local password to confirm the change');
  }
  if (typeof password !== 'string' || password === '') throw new AppError(400, 'Enter your current password');
  if (password.length > 1024 || !(await comparePassword(password, row.password_hash))) {
    throw new AppError(400, 'Current password is incorrect');
  }
}

/**
 * Proof for enabling or disabling e-mail codes (port of Obliance
 * checkFactorManagement): a current code of the authenticator app when one is
 * live, or the current password. A stolen session cookie alone can neither
 * plant a factor nor remove the user's.
 */
async function requireFactorProof(userId: number, row: FactorRow, body: Record<string, unknown>): Promise<void> {
  const secret = liveTotpSecret(row);
  const code = codeFrom(body.currentCode);
  const password = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  if (code && secret) {
    await requireCurrentTotp(userId, secret, code);
    return;
  }
  if (password && row.password_hash) {
    if (!(await comparePassword(password, row.password_hash))) {
      throw new AppError(400, 'Current password is incorrect');
    }
    return;
  }
  if (!secret && !row.password_hash) {
    throw new AppError(403, 'This account has no password or authenticator app to confirm the change');
  }
  throw new AppError(400, secret
    ? 'Enter a current code from your authenticator app or your current password'
    : 'Enter your current password');
}

async function auditSelf(req: Request, action: string, details?: Record<string, unknown>): Promise<void> {
  await auditService.logReq(req, {
    action,
    resourceType: 'user',
    resourceId: req.session.userId ?? null,
    details: details ?? null,
  });
}

/** Notice to the account's address when a second factor is added or removed (best effort). */
function notifyFactorChange(email: string | null, subject: string, line: string): void {
  twoFactorService.notifyInBackground(email, subject, [line, NOT_YOU]);
}

export const twoFactorController = {
  // ── Profile endpoints (authenticated) ─────────────────────────────────────

  async status(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await authService.getUserById(req.session.userId!);
      if (!user) throw new AppError(401, 'User not found');
      res.json({ success: true, data: {
        totpEnabled: user.totpEnabled ?? false,
        emailOtpEnabled: user.emailOtpEnabled ?? false,
        email: user.email ?? null,
      }});
    } catch (err) { next(err); }
  },

  // TOTP setup step 1: generate secret + QR (stored in session).
  // Replacing a live TOTP needs a current code of it (body.currentCode); a
  // first TOTP needs the current password (body.currentPassword), as in
  // Obliance checkFactorManagement: a stolen session cookie alone cannot
  // plant an authenticator app on the account.
  async totpSetup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      await assert2faAllowed();
      const row = await loadFactorRow(userId);
      const liveSecret = liveTotpSecret(row);
      if (liveSecret) await requireCurrentTotp(userId, liveSecret, bodyOf(req).currentCode);
      else await requireCurrentPassword(row, bodyOf(req).currentPassword);

      const { secret, uri } = twoFactorService.generateTotpSecret(row.username);
      const qrDataUrl = await twoFactorService.generateTotpQr(uri);
      req.session.pendingTotpSecret = secret;
      req.session.pendingTotpSecretAt = Date.now();
      req.session.pendingTotpReplaces = liveSecret !== null;
      res.json({ success: true, data: { secret, qrDataUrl } });
    } catch (err) { next(err); }
  },

  // TOTP setup step 2: verify a code of the new secret, save it and enable
  async totpEnable(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      const secret = req.session.pendingTotpSecret;
      if (!secret) throw new AppError(400, 'No pending TOTP setup. Call /setup first.');
      const at = req.session.pendingTotpSecretAt;
      if (typeof at !== 'number' || Date.now() - at > PENDING_TOTP_TTL_MS) {
        clearPendingTotp(req);
        throw new AppError(400, 'TOTP setup expired. Start again.');
      }
      const step = twoFactorService.verifyTotpStep(secret, codeFrom(bodyOf(req).code));
      if (step === null) throw new AppError(400, 'Invalid code');

      // A setup started while no TOTP was live proved nothing about a TOTP:
      // it must not overwrite one enabled in the meantime (other session).
      // The condition is IN the update, so two racing enables cannot both win.
      // totp_last_step records the enabling code: it cannot serve as a proof later.
      const replaces = req.session.pendingTotpReplaces === true;
      const q = db('users').where({ id: userId });
      if (!replaces) {
        q.where((w) => w.where('totp_enabled', false).orWhereNull('totp_enabled').orWhereNull('totp_secret'));
      }
      const updated = await q.update({
        totp_secret: secret,
        totp_enabled: true,
        totp_last_step: db.raw('GREATEST(COALESCE(totp_last_step, ?), ?)', [step, step]),
        updated_at: new Date(),
      });
      clearPendingTotp(req);
      if (!updated) {
        throw new AppError(409, 'Two-factor authentication was enabled in the meantime. Start the setup again.');
      }

      invalidateAccountPolicyCache(userId);
      await auditSelf(req, 'user.totp_enabled', { replaced: replaces });
      const row = await db('users').where({ id: userId }).first('email') as { email: string | null } | undefined;
      notifyFactorChange(row?.email ?? null, replaces ? 'Authenticator app replaced' : 'Authenticator app added', replaces
        ? 'The authenticator app (TOTP) used for two-factor authentication on your account was replaced.'
        : 'An authenticator app (TOTP) was added for two-factor authentication on your account.');
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // Removing a live TOTP needs a current code of it (body.currentCode), and is
  // refused while force_2fa is on and it is the account's last factor.
  async totpDisable(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      const row = await loadFactorRow(userId);
      const liveSecret = liveTotpSecret(row);
      if (liveSecret) {
        if (!row.email_otp_enabled && await isFactorRequired(row.foreign_source)) {
          throw new AppError(409, 'factor_required');
        }
        await requireCurrentTotp(userId, liveSecret, bodyOf(req).currentCode);
      }
      await db('users').where({ id: userId }).update({
        totp_secret: null,
        totp_enabled: false,
      });
      clearPendingTotp(req);
      if (liveSecret) {
        invalidateAccountPolicyCache(userId);
        await auditSelf(req, 'user.totp_disabled');
        notifyFactorChange(row.email, 'Authenticator app removed',
          'The authenticator app (TOTP) was removed from your account: two-factor authentication by authenticator app is off.');
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // Email OTP setup step 1: send a code to the account's PROFILE address.
  // body.email is ignored and users.email is never written here, so this route
  // cannot move the password-reset channel. Needs a proof (current code or
  // password) before any mail is sent.
  async emailSetup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      await assert2faAllowed();
      const row = await loadFactorRow(userId);
      const profileEmail = String(row.email ?? '').trim();
      if (!profileEmail) throw new AppError(400, 'Set an e-mail address in your profile first.');
      const cfg = await appConfigService.getAll();
      if (!cfg.otp_smtp_server_id) throw new AppError(400, 'No SMTP server configured for OTP. Ask your administrator.');
      await requireFactorProof(userId, row, bodyOf(req));

      const code = twoFactorService.generateEmailOtp();
      req.session.pendingEmailOtpSetup = createPendingEmailOtp(code, userId, profileEmail);
      await twoFactorService.sendEmailOtp(Number(cfg.otp_smtp_server_id), profileEmail, code);
      res.json({ success: true, message: `Code sent to ${profileEmail}` });
    } catch (err) { next(err); }
  },

  // Email OTP setup step 2: verify the mailed code and enable e-mail codes
  // (on the profile address, which is NOT written here)
  async emailEnable(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      const pending = req.session.pendingEmailOtpSetup;
      const current = await db('users').where({ id: userId }).first('email') as { email: string | null } | undefined;
      const check = checkEmailOtp(pending, bodyOf(req).code, { userId, email: current?.email ?? null });
      if (check === 'none' || !pending) throw new AppError(400, 'No pending email OTP setup. Call /setup first.');
      if (check === 'invalid') {
        pending.attempts = (Number(pending.attempts) || 0) + 1;
        if (pending.attempts >= EMAIL_OTP_MAX_ATTEMPTS) delete req.session.pendingEmailOtpSetup;
        throw new AppError(400, 'Invalid code');
      }
      if (check !== 'ok') {
        delete req.session.pendingEmailOtpSetup;
        if (check === 'expired') throw new AppError(400, 'Code expired');
        if (check === 'exhausted') throw new AppError(400, 'Too many wrong codes. Request a new code.');
        throw new AppError(409, 'Your e-mail address changed during the setup. Start again.');
      }

      // Only if the profile address is still the one the code went to.
      const updated = await db('users')
        .where({ id: userId })
        .whereRaw('lower(trim(email)) = ?', [pending.email.trim().toLowerCase()])
        .update({ email_otp_enabled: true });
      delete req.session.pendingEmailOtpSetup;
      if (!updated) throw new AppError(409, 'Your e-mail address changed during the setup. Start again.');

      invalidateAccountPolicyCache(userId);
      await auditSelf(req, 'user.email_otp_enabled');
      notifyFactorChange(pending.email, 'E-mail codes enabled',
        'Sign-in codes by e-mail were enabled on your account, sent to this address.');
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // Disabling e-mail codes needs the same proof as enabling them, and is
  // refused while force_2fa is on and they are the account's last factor.
  async emailDisable(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      const row = await loadFactorRow(userId);
      const wasEnabled = row.email_otp_enabled === true;
      if (wasEnabled) {
        if (!liveTotpSecret(row) && await isFactorRequired(row.foreign_source)) {
          throw new AppError(409, 'factor_required');
        }
        await requireFactorProof(userId, row, bodyOf(req));
      }
      await db('users').where({ id: userId }).update({ email_otp_enabled: false });
      delete req.session.pendingEmailOtpSetup;
      if (wasEnabled) {
        invalidateAccountPolicyCache(userId);
        await auditSelf(req, 'user.email_otp_disabled');
        notifyFactorChange(row.email, 'E-mail codes disabled', 'Sign-in codes by e-mail were disabled on your account.');
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Auth endpoints (after step-1 login, session has pendingMfaUserId) ─────

  async verify(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code, method } = bodyOf(req);
      const userId = toDbId(req.session.pendingMfaUserId);
      if (!userId) throw new AppError(400, 'No pending 2FA session');

      if (pendingMfaExpired(req)) {
        clearPendingMfa(req);
        throw new AppError(401, 'restart_login');
      }

      // is_active: a deactivation between the password and the code step
      // must not complete the sign-in.
      const row = await db('users')
        .where({ id: userId, is_active: true })
        .first('id', 'username', 'role', 'totp_secret', 'totp_enabled', 'email_otp_enabled', 'email', 'foreign_source') as {
          id: number; username: string; role: string; totp_secret: string | null; totp_enabled: boolean | null;
          email_otp_enabled: boolean | null; email: string | null; foreign_source: string | null;
        } | undefined;
      if (!row) {
        clearPendingMfa(req);
        throw new AppError(401, 'restart_login');
      }

      // SSO account (og_) signing in with a local password: only its LOCAL
      // TOTP completes the sign-in, never an e-mail code (see authController.login).
      const ssoAccount = row.foreign_source === 'obligate';
      let via: string | null = null;

      if (method === 'totp' && row.totp_enabled && row.totp_secret) {
        // Window ±1 step, and each code is accepted once (users.totp_last_step).
        if (await twoFactorService.verifyCurrentTotp(row.id, row.totp_secret, codeFrom(code)) === 'ok') {
          via = 'password+totp';
        }
      } else if (method === 'totp') {
        logger.warn({ userId, totpEnabled: row.totp_enabled, hasSecret: !!row.totp_secret },
          'TOTP verify: totp_enabled or totp_secret missing in DB');
      } else if (method === 'email' && row.email_otp_enabled && !ssoAccount) {
        const pending = req.session.pendingEmailOtp;
        const check = checkEmailOtp(pending, code, { userId: row.id, email: row.email });
        if (check === 'ok') {
          via = 'password+email';
        } else if (check === 'invalid' && pending) {
          pending.attempts = (Number(pending.attempts) || 0) + 1;
          if (pending.attempts >= EMAIL_OTP_MAX_ATTEMPTS) delete req.session.pendingEmailOtp;
        } else if (check !== 'none') {
          delete req.session.pendingEmailOtp;
        }
      }

      if (!via) {
        const failures = (Number(req.session.mfaFailures) || 0) + 1;
        await auditService.logReq(req, {
          tenantId: null,
          userId: row.id,
          action: 'auth.2fa_failed',
          resourceType: 'user',
          resourceId: row.id,
          details: { username: row.username, method: typeof method === 'string' ? method.slice(0, 16) : null, failures },
        });
        if (failures >= MAX_MFA_FAILURES) {
          // Too many wrong codes: the password must be proven again.
          clearPendingMfa(req);
          throw new AppError(401, 'restart_login');
        }
        req.session.mfaFailures = failures;
        throw new AppError(401, 'Invalid code');
      }

      // Complete the sign-in under a NEW session id (session fixation): the
      // pending state is dropped with the old one.
      if (!(await completeSignIn(req, res, row, via))) return;

      const user = await authService.getUserById(row.id);
      res.json({ success: true, data: { user } });
    } catch (err) { next(err); }
  },

  async resendEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = toDbId(req.session.pendingMfaUserId);
      if (!userId) throw new AppError(400, 'No pending 2FA session');
      if (pendingMfaExpired(req)) {
        clearPendingMfa(req);
        throw new AppError(401, 'restart_login');
      }

      const row = await db('users')
        .where({ id: userId, is_active: true })
        .first('email', 'email_otp_enabled', 'foreign_source') as
        { email: string | null; email_otp_enabled: boolean | null; foreign_source: string | null } | undefined;
      // An SSO account signs in locally with its TOTP only: no e-mail code.
      if (!row || !row.email_otp_enabled || !row.email || row.foreign_source === 'obligate') {
        throw new AppError(400, 'Email OTP not configured for this user');
      }

      const last = req.session.emailOtpSentAt;
      const elapsed = typeof last === 'number' ? Date.now() - last : Infinity;
      if (elapsed < EMAIL_OTP_RESEND_COOLDOWN_MS) {
        res.setHeader('Retry-After', String(Math.ceil((EMAIL_OTP_RESEND_COOLDOWN_MS - elapsed) / 1000)));
        throw new AppError(429, 'Please wait a minute before requesting a new code');
      }

      const result = await mailSignInCode(req, userId, row.email);
      if (result === 'no_smtp') throw new AppError(400, 'No SMTP server configured for OTP');
      if (result === 'capped') throw new AppError(429, 'Too many codes requested. Try again later.');
      if (result === 'failed') throw new AppError(502, 'The code could not be sent. Try again later.');
      res.json({ success: true, message: `Code sent to ${maskEmail(row.email)}` });
    } catch (err) { next(err); }
  },
};
