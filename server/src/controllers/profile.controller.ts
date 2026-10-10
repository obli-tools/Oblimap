import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { comparePassword, hashPassword } from '../utils/crypto';
import { AppError } from '../middleware/errorHandler';
import { invalidateAccountPolicyCache } from '../middleware/accountPolicy';
import { authService, normalizeEmail, isUniqueViolation, mergedPreferencesSql } from '../services/auth.service';
import { auditService } from '../services/audit.service';
import { twoFactorService } from '../services/twoFactor.service';
import { killSessionsForUser } from '../services/userSessions.service';
import { assertPasswordNotUsername } from '../validators/password';
import type { UpdateProfileInput, ChangePasswordInput } from '../validators/profile.schema';

// Same message whatever the reason (taken by a local or an SSO account, race
// on the unique index): the answer must not tell which addresses exist.
const EMAIL_UNAVAILABLE = 'Email unavailable';

function buildUserResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preferences: row.preferences ?? null,
    email: row.email ?? null,
    preferredLanguage: row.preferred_language ?? 'en',
    enrollmentVersion: row.enrollment_version ?? 0,
    hasPassword: !!row.password_hash,
    mustChangePassword: row.must_change_password === true,
  };
}

type ProofRow = {
  password_hash: string | null;
  totp_enabled: boolean | null;
  totp_secret: string | null;
};

/**
 * Proof for an e-mail change (the address is the password-reset channel): the
 * current password; for an account without a local password (SSO), a current
 * code of its authenticator app. Throws AppError otherwise.
 */
async function requireEmailChangeProof(userId: number, row: ProofRow, data: UpdateProfileInput): Promise<void> {
  if (row.password_hash) {
    if (!data.currentPassword) throw new AppError(400, 'Enter your current password to change your e-mail address');
    if (!(await comparePassword(data.currentPassword, row.password_hash))) {
      throw new AppError(400, 'Current password is incorrect');
    }
    return;
  }
  if (row.totp_enabled && row.totp_secret) {
    const code = String(data.currentCode ?? '').trim();
    if (!code) throw new AppError(400, 'Enter a current code from your authenticator app to change your e-mail address');
    const result = await twoFactorService.verifyCurrentTotp(userId, row.totp_secret, code);
    if (result === 'replayed') throw new AppError(400, 'This code was already used. Wait for the next code.');
    if (result !== 'ok') throw new AppError(400, 'Invalid authenticator code');
    return;
  }
  throw new AppError(403, 'The e-mail address of this account is managed by its identity provider');
}

export const profileController = {
  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const row = await db('users')
        .select('id', 'username', 'display_name', 'role', 'is_active', 'created_at', 'updated_at', 'preferences', 'email', 'preferred_language', 'enrollment_version', 'password_hash', 'must_change_password')
        .where({ id: req.session.userId })
        .first();

      if (!row) throw new AppError(404, 'User not found');

      res.json({ success: true, data: buildUserResponse(row) });
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      const data = req.body as UpdateProfileInput;

      const updatePayload: Record<string, unknown> = { updated_at: new Date() };

      if ('displayName' in data) updatePayload.display_name = data.displayName;
      if ('preferences' in data) {
        // Merged into the stored preferences: a save of some keys (e.g. the
        // toast settings) never erases the others (the theme, Obligate keys).
        updatePayload.preferences = data.preferences ? mergedPreferencesSql(data.preferences) : null;
      }
      if ('preferredLanguage' in data) updatePayload.preferred_language = data.preferredLanguage;

      // E-mail change (including removal): proof required, address unique,
      // and e-mail codes — bound to the old address — are disabled.
      let emailChange: { from: string | null; to: string | null } | null = null;
      if (data.email !== undefined) {
        const current = await db('users')
          .where({ id: userId })
          .first('email', 'password_hash', 'totp_enabled', 'totp_secret') as
          (ProofRow & { email: string | null }) | undefined;
        if (!current) throw new AppError(404, 'User not found');
        const nextEmail = normalizeEmail(data.email);
        const previousEmail = current.email ? String(current.email) : null;
        if (normalizeEmail(previousEmail) !== nextEmail) {
          await requireEmailChangeProof(userId, current, data);
          if (nextEmail && await authService.isEmailTaken(nextEmail, userId)) {
            throw new AppError(409, EMAIL_UNAVAILABLE);
          }
          updatePayload.email = nextEmail;
          updatePayload.email_otp_enabled = false;
          emailChange = { from: previousEmail, to: nextEmail };
        }
      }

      let row: Record<string, unknown> | undefined;
      try {
        [row] = await db('users')
          .where({ id: userId })
          .update(updatePayload)
          .returning(['id', 'username', 'display_name', 'role', 'is_active', 'created_at', 'updated_at', 'preferences', 'email', 'preferred_language', 'enrollment_version', 'password_hash', 'must_change_password']);
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, EMAIL_UNAVAILABLE);
        throw err;
      }

      if (!row) throw new AppError(404, 'User not found');

      if (emailChange) {
        delete req.session.pendingEmailOtpSetup;
        invalidateAccountPolicyCache(userId);
        await auditService.logReq(req, {
          action: 'user.email_changed',
          resourceType: 'user',
          resourceId: userId,
          details: { from: emailChange.from, to: emailChange.to },
        });
        // Tell the OLD address (best effort, in the background).
        twoFactorService.notifyInBackground(emailChange.from, 'E-mail address changed', [
          emailChange.to
            ? `The e-mail address of your account was changed to ${emailChange.to}.`
            : 'The e-mail address of your account was removed.',
          'Sign-in codes by e-mail were turned off. If this was not you, change your password now and contact an administrator.',
        ]);
      }

      res.json({ success: true, data: buildUserResponse(row) });
    } catch (err) {
      next(err);
    }
  },

  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      const { currentPassword, newPassword } = req.body as ChangePasswordInput;

      const user = await db('users').select('username', 'password_hash', 'foreign_source').where({ id: userId }).first() as
        { username: string; password_hash: string | null; foreign_source: string | null } | undefined;
      if (!user) throw new AppError(404, 'User not found');

      if (!user.password_hash) {
        // An SSO account without a local password: its password lives in the identity provider.
        if (user.foreign_source) throw new AppError(403, 'The password of this account is managed by its identity provider');
        throw new AppError(400, 'Current password is incorrect');
      }

      const valid = await comparePassword(currentPassword, user.password_hash);
      if (!valid) throw new AppError(400, 'Current password is incorrect');

      assertPasswordNotUsername(newPassword, user.username);
      if (newPassword === currentPassword) {
        throw new AppError(400, 'The new password must be different from the current one');
      }

      const newHash = await hashPassword(newPassword);
      const now = new Date();
      await db('users').where({ id: userId }).update({
        password_hash: newHash,
        password_changed_at: now,
        must_change_password: false,
        updated_at: now,
      });

      invalidateAccountPolicyCache(userId);
      // Every other session of the account ends (a thief of an older session loses it).
      await killSessionsForUser(userId, 'password_changed', { exceptSid: req.sessionID });
      await auditService.logReq(req, { action: 'user.password_changed', resourceType: 'user', resourceId: userId });

      res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
      next(err);
    }
  },

  // "Sign out my other sessions": every session of the account but this one.
  async revokeOtherSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      const revoked = await killSessionsForUser(userId, 'revoke_others', { exceptSid: req.sessionID });
      await auditService.logReq(req, {
        action: 'user.sessions_revoked',
        resourceType: 'user',
        resourceId: userId,
        details: { count: revoked },
      });
      res.json({ success: true, data: { revoked } });
    } catch (err) {
      next(err);
    }
  },
};
