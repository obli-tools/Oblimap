import crypto from 'crypto';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import nodemailer from 'nodemailer';
import { db } from '../db';
import { smtpServerService } from './smtpServer.service';
import { appConfigService } from './appConfig.service';
import { config } from '../config';
import { logger } from '../utils/logger';
import { safeEqual, sha256Hex } from '../utils/timingSafe';
import { escapeHtml } from '../utils/html';

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** TOTP period (s) and accepted clock drift in steps: ±1 step = ±30 s. */
export const TOTP_PERIOD_S = 30;
export const TOTP_WINDOW = 1;

/** E-mail codes: lifetime, wrong attempts allowed per code, resend cooldown. */
export const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
export const EMAIL_OTP_MAX_ATTEMPTS = 5;
export const EMAIL_OTP_RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * A mailed code as kept in the session: only its SHA-256 (a dump of the
 * session store does not reveal it), bound to the account and the address it
 * was sent to, with its own wrong-attempt counter.
 */
export interface PendingEmailOtp {
  codeHash: string;
  userId: number;
  email: string;
  expires: number;
  attempts: number;
}

export type EmailOtpCheck =
  | 'ok'
  | 'none'       // no code pending (or a pre-upgrade plaintext one)
  | 'mismatch'   // issued for another account or another address
  | 'expired'
  | 'exhausted'  // EMAIL_OTP_MAX_ATTEMPTS wrong codes already
  | 'invalid';   // wrong code

/** Six digits from the CSPRNG, 000000–999999. */
export function generateEmailOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** SHA-256 (hex) of a code as typed, surrounding spaces ignored. */
export function hashEmailOtp(code: string): string {
  return sha256Hex(String(code ?? '').trim());
}

export function createPendingEmailOtp(code: string, userId: number, email: string, now: number = Date.now()): PendingEmailOtp {
  return { codeHash: hashEmailOtp(code), userId, email, expires: now + EMAIL_OTP_TTL_MS, attempts: 0 };
}

/**
 * Checks a typed code against the pending one. The caller counts an
 * 'invalid' answer in pending.attempts and drops the pending code on any
 * other refusal. Comparison is constant-time.
 */
export function checkEmailOtp(
  pending: PendingEmailOtp | null | undefined,
  code: unknown,
  expected: { userId: number; email: string | null | undefined },
  now: number = Date.now(),
): EmailOtpCheck {
  if (!pending || typeof pending.codeHash !== 'string' || pending.codeHash === '') return 'none';
  if (pending.userId !== expected.userId) return 'mismatch';
  const pendingEmail = String(pending.email ?? '').trim().toLowerCase();
  const currentEmail = String(expected.email ?? '').trim().toLowerCase();
  if (!currentEmail || pendingEmail !== currentEmail) return 'mismatch';
  if (!(typeof pending.expires === 'number' && now <= pending.expires)) return 'expired';
  if ((Number(pending.attempts) || 0) >= EMAIL_OTP_MAX_ATTEMPTS) return 'exhausted';
  const token = typeof code === 'string' || typeof code === 'number' ? String(code).trim() : '';
  if (!/^\d{6}$/.test(token)) return 'invalid';
  return safeEqual(hashEmailOtp(token), pending.codeHash) ? 'ok' : 'invalid';
}

/** Absolute TOTP time step of an instant: floor(unix seconds / 30). */
export function totpStepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_S);
}

/**
 * TOTP anti-replay rule: a step is accepted only when it is strictly newer
 * than the last accepted step of the account (users.totp_last_step; NULL =
 * nothing accepted yet). Same condition as the conditional UPDATE of
 * twoFactorService.acceptTotpStep — a code, even a valid one, is used once.
 */
export function isTotpStepFresh(step: number, lastStep: number | string | null | undefined): boolean {
  if (!Number.isSafeInteger(step) || step <= 0) return false;
  if (lastStep === null || lastStep === undefined) return true;
  const last = Number(lastStep); // bigint columns come back as strings
  return !Number.isFinite(last) || step > last;
}

/** "john.doe@example.com" → "j***@example.com" (log lines, UI hints). */
export function maskEmail(email: string | null | undefined): string {
  const s = String(email ?? '').trim();
  const at = s.lastIndexOf('@');
  if (at <= 0) return s ? '***' : '';
  return `${s[0]}***${s.slice(at)}`;
}

function buildTotp(secret: OTPAuth.Secret, label?: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: config.appName,
    ...(label !== undefined ? { label } : {}),
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD_S,
    secret,
  });
}

async function createTransport(smtpServerId: number) {
  const server = await smtpServerService.getById(smtpServerId);
  if (!server) throw new Error('SMTP server not configured for OTP');
  return {
    from: server.from_address,
    transport: nodemailer.createTransport({
      host: server.host,
      port: server.port,
      secure: server.secure,
      auth: { user: server.username, pass: server.password },
    }),
  };
}

export const twoFactorService = {
  // ── TOTP ──────────────────────────────────────────────────────────────────

  generateTotpSecret(username: string): { secret: string; uri: string } {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = buildTotp(secret, username);
    return {
      secret: secret.base32,
      uri: totp.toString(),
    };
  },

  async generateTotpQr(uri: string): Promise<string> {
    return QRCode.toDataURL(uri);
  },

  /**
   * Verifies a TOTP code (window ±1 step) and returns the ABSOLUTE time step
   * it matched, or null. The step feeds the anti-replay guard
   * (acceptTotpStep): checking only `!== null` would accept a replayed code.
   */
  verifyTotpStep(secret: string, code: string, nowMs: number = Date.now(), window: number = TOTP_WINDOW): number | null {
    const token = String(code ?? '').trim();
    if (!/^\d{6}$/.test(token)) return null;
    try {
      const totp = buildTotp(OTPAuth.Secret.fromBase32(String(secret).trim()));
      const delta = totp.validate({ token, timestamp: nowMs, window });
      if (delta === null) return null;
      return totpStepAt(nowMs) + delta;
    } catch (err) {
      logger.warn({ err }, 'TOTP verification threw an exception (secret may be malformed)');
      return null;
    }
  },

  /**
   * Records `step` as the last accepted TOTP step of the user — only if it is
   * newer than the recorded one (isTotpStepFresh), in one conditional UPDATE
   * so two requests racing with the same code cannot both pass. False = the
   * code (or an older one) was already used.
   */
  async acceptTotpStep(userId: number, step: number): Promise<boolean> {
    if (!Number.isSafeInteger(step) || step <= 0) return false;
    const r = await db.raw(
      `UPDATE users SET totp_last_step = ?
        WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)
        RETURNING id`,
      [step, userId, step],
    ) as { rows?: unknown[] };
    return (r.rows ?? []).length > 0;
  },

  /** Current code of the user's authenticator app, used once (sign-in or step-up proof). */
  async verifyCurrentTotp(userId: number, secret: string, code: string): Promise<'ok' | 'invalid' | 'replayed'> {
    const step = twoFactorService.verifyTotpStep(secret, code);
    if (step === null) return 'invalid';
    return (await twoFactorService.acceptTotpStep(userId, step)) ? 'ok' : 'replayed';
  },

  // ── Email OTP ──────────────────────────────────────────────────────────────

  generateEmailOtp(): string {
    return generateEmailOtpCode();
  },

  async sendEmailOtp(smtpServerId: number, toEmail: string, code: string): Promise<void> {
    const { from, transport } = await createTransport(smtpServerId);

    await transport.sendMail({
      from,
      to: toEmail,
      subject: `${config.appName} — Your login code`,
      text: `Your login verification code is: ${code}\n\nThis code expires in 10 minutes.`,
      html: `
        <h2>${escapeHtml(config.appName)} — Login verification</h2>
        <p>Your verification code is:</p>
        <h1 style="letter-spacing:8px;font-family:monospace">${code}</h1>
        <p style="color:#888;font-size:12px">This code expires in 10 minutes. If you did not request this, ignore this email.</p>
      `,
    });

    logger.info({ to: maskEmail(toEmail) }, 'Email OTP sent');
  },

  /**
   * Security notice (second factor added / removed, e-mail address changed).
   * English, like the OTP mails; static text only (no code or secret).
   */
  async sendSecurityNotice(smtpServerId: number, toEmail: string, subject: string, lines: string[]): Promise<void> {
    const { from, transport } = await createTransport(smtpServerId);
    await transport.sendMail({
      from,
      to: toEmail,
      subject: `${config.appName} — ${subject}`,
      text: lines.join('\n\n'),
      html: `<h2>${escapeHtml(config.appName)} — ${escapeHtml(subject)}</h2>${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}`,
    });
    logger.info({ subject, to: maskEmail(toEmail) }, 'Security notice sent');
  },

  /**
   * sendSecurityNotice in the background, through the OTP SMTP server when
   * one is configured. Best effort: never throws, never delays the request.
   */
  notifyInBackground(toEmail: string | null | undefined, subject: string, lines: string[]): void {
    const to = String(toEmail ?? '').trim();
    if (!to) return;
    void (async () => {
      try {
        const cfg = await appConfigService.getAll();
        if (!cfg.otp_smtp_server_id) return;
        await twoFactorService.sendSecurityNotice(Number(cfg.otp_smtp_server_id), to, subject, lines);
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, subject }, 'Security notice could not be sent');
      }
    })();
  },
};
