import crypto from 'crypto';
import nodemailer from 'nodemailer';
import type { Knex } from 'knex';
import { db } from '../db';
import { hashPassword } from '../utils/crypto';
import { sha256Hex } from '../utils/timingSafe';
import { escapeHtml } from '../utils/html';
import { appConfigService } from './appConfig.service';
import { smtpServerService } from './smtpServer.service';
import { maskEmail } from './twoFactor.service';
import { assertPasswordNotUsername } from '../validators/password';
import { config } from '../config';
import { logger } from '../utils/logger';

const TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// Column names of password_reset_tokens. Migration 010 created `token` +
// `used` (boolean), while databases created from the Obliview schema have
// `token_hash` + `used_at`. Detected once; both hold the SHA-256 of the token.
type ResetColumns = { token: 'token_hash' | 'token'; usedAt: boolean };
let resetColumnsPromise: Promise<ResetColumns> | null = null;

function resetColumns(): Promise<ResetColumns> {
  if (!resetColumnsPromise) {
    resetColumnsPromise = (async (): Promise<ResetColumns> => {
      const hasTokenHash = await db.schema.hasColumn('password_reset_tokens', 'token_hash');
      const hasUsedAt = await db.schema.hasColumn('password_reset_tokens', 'used_at');
      return { token: hasTokenHash ? 'token_hash' : 'token', usedAt: hasUsedAt };
    })().catch((err) => {
      resetColumnsPromise = null;
      throw err;
    });
  }
  return resetColumnsPromise;
}

/** WHERE clause: token not used yet. */
function unused(cols: ResetColumns, alias = '') {
  const p = alias ? `${alias}.` : '';
  return (q: Knex.QueryBuilder) => {
    if (cols.usedAt) q.whereNull(`${p}used_at`);
    else q.where(`${p}used`, false);
  };
}

/**
 * WHERE clause on users: an account whose password may be reset (active, not
 * provisioned by Obligate SSO — its password lives in the identity provider).
 */
function resettableAccount(alias = '') {
  const p = alias ? `${alias}.` : '';
  return (q: Knex.QueryBuilder) => {
    q.where(`${p}is_active`, true)
      .where((w) => w.whereNull(`${p}foreign_source`).orWhereNot(`${p}foreign_source`, 'obligate'));
  };
}

function tokenHashOf(rawToken: string): string {
  return sha256Hex(rawToken);
}

export const passwordResetService = {
  /**
   * Generate a reset token, store its hash, send the email. Called in the
   * background by the controller (which always answers 200 at once), so
   * neither the answer nor its timing tells whether the address exists.
   * Accounts provisioned by Obligate SSO are excluded: their password lives
   * in the identity provider.
   */
  async requestReset(email: string): Promise<void> {
    const normalized = String(email ?? '').trim().toLowerCase();
    if (!normalized) return;

    const users = await db('users')
      .whereRaw('lower(trim(email)) = ?', [normalized])
      .where(resettableAccount())
      .limit(2)
      .select('id', 'email') as Array<{ id: number; email: string }>;
    if (users.length !== 1) {
      // No account, or an ambiguous address (several accounts share it):
      // no link is sent.
      if (users.length > 1) logger.warn({ email: maskEmail(normalized) }, 'Password reset: several accounts share this address, no link sent');
      return;
    }
    const user = users[0];
    const cols = await resetColumns();

    // Invalidate any existing unused tokens for this user
    await db('password_reset_tokens')
      .where({ user_id: user.id })
      .where(unused(cols))
      .delete();

    // Generate a secure random token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);

    await db('password_reset_tokens').insert({
      user_id: user.id,
      [cols.token]: tokenHashOf(rawToken),
      expires_at: expiresAt,
    });

    // Send the reset email if SMTP is configured
    const cfg = await appConfigService.getAll();
    if (!cfg.otp_smtp_server_id) {
      logger.warn('Password reset requested but no SMTP server configured');
      return;
    }

    const smtp = await smtpServerService.getTransportConfig(cfg.otp_smtp_server_id);
    if (!smtp) return;

    const resetUrl = `${config.appUrl}/reset-password?token=${rawToken}`;

    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.username, pass: smtp.password },
    });

    await transport.sendMail({
      from: smtp.fromAddress,
      to: user.email,
      subject: `${config.appName} — Reset your password`,
      text: `You requested a password reset for your ${config.appName} account.\n\nClick this link to reset your password (valid for 1 hour):\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
      html: `
        <h2>${escapeHtml(config.appName)} — Password reset</h2>
        <p>You requested a password reset for your account.</p>
        <p style="margin:24px 0">
          <a href="${escapeHtml(resetUrl)}" style="background:#3b82f6;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
            Reset password
          </a>
        </p>
        <p style="color:#888;font-size:12px">This link expires in 1 hour. If you did not request this, ignore this email.</p>
      `,
    });

    logger.info({ to: maskEmail(user.email) }, 'Password reset email sent');
  },

  /**
   * Validate a raw token. Returns the user_id if valid (and its account can
   * still take a local password: active, not Obligate SSO), null otherwise.
   */
  async validateToken(rawToken: string): Promise<number | null> {
    const cols = await resetColumns();
    const row = await db('password_reset_tokens as t')
      .join('users as u', 'u.id', 't.user_id')
      .where(`t.${cols.token}`, tokenHashOf(rawToken))
      .where(unused(cols, 't'))
      .where('t.expires_at', '>', new Date())
      .where(resettableAccount('u'))
      .first('t.user_id') as { user_id: number } | undefined;

    return row ? row.user_id : null;
  },

  /**
   * Consume a raw token and set the user's new password. Returns the user id,
   * or null when the token is unknown, used or expired. The token is consumed
   * by ONE conditional UPDATE (… AND not used AND not expired RETURNING
   * user_id), in the same transaction as the password change: two concurrent
   * requests cannot both use it. Throws AppError(400) when the new password
   * equals the username (the token is then left unused).
   * The account must still be active and not Obligate SSO — checked again in
   * the transaction (deactivated or linked to Obligate after the token was
   * issued): the token is then used up and nothing else changes.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<number | null> {
    const cols = await resetColumns();
    const tokenHash = tokenHashOf(rawToken);

    const pending = await db('password_reset_tokens as t')
      .join('users as u', 'u.id', 't.user_id')
      .where(`t.${cols.token}`, tokenHash)
      .where(unused(cols, 't'))
      .where('t.expires_at', '>', new Date())
      .where(resettableAccount('u'))
      .first('t.user_id', 'u.username') as
      { user_id: number; username: string } | undefined;
    // Unknown / used / expired token, or an account that cannot take a local
    // password (deactivated, or SSO: token issued before the upgrade).
    if (!pending) return null;
    assertPasswordNotUsername(newPassword, pending.username);

    const newHash = await hashPassword(newPassword);

    return db.transaction(async (trx) => {
      const consumed = await trx('password_reset_tokens')
        .where(cols.token, tokenHash)
        .where(unused(cols))
        .where('expires_at', '>', trx.fn.now())
        .update(cols.usedAt ? { used_at: trx.fn.now() } : { used: true })
        .returning('user_id') as Array<{ user_id: number }>;
      const userId = consumed[0]?.user_id;
      if (!userId) return null;

      const now = new Date();
      const updated = await trx('users')
        .where({ id: userId })
        .where(resettableAccount())
        .update({
          password_hash: newHash,
          password_changed_at: now,
          must_change_password: false,
          updated_at: now,
        });
      // Deactivated or linked to Obligate since the pre-check: no password is
      // set. The token stays used up (committed): it must not come back to
      // life if the account is reactivated within the hour.
      if (!updated) return null;
      return Number(userId);
    });
  },
};
