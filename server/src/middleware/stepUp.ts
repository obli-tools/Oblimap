import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { AppError } from './errorHandler';
import { toDbId } from '../utils/dbId';
import { appConfigService } from '../services/appConfig.service';
import { auditService } from '../services/audit.service';
import {
  twoFactorService,
  createPendingEmailOtp,
  checkEmailOtp,
  maskEmail,
  EMAIL_OTP_MAX_ATTEMPTS,
  EMAIL_OTP_RESEND_COOLDOWN_MS,
  type PendingEmailOtp,
} from '../services/twoFactor.service';
import { restrictionService, type ActionKey, type RestrictionLevel } from '../services/restriction.service';
import { logger } from '../utils/logger';
import { config } from '../config';
import { tagGate } from './rbac';

// ── 2FA step-up for sensitive actions ─────────────────────
//
// A tenant marks actions 'sensitive' (restriction.service). requireAction(key)
// runs AFTER the route's existing capability / permission gates: when the
// action is sensitive in the current tenant and the session has not proven a
// second factor in the last 5 minutes (session.stepUpAt), the request is
// refused with 403 and a machine code the web client acts on in-page (never a
// redirect, so it works inside the ObliTools iframe with X-Auth-Token):
//
//   { error: 'step_up_required', action, methods: ['totp' | 'email', ...] }
//       → the client opens its step-up dialog, proves a factor through
//         POST /api/auth/step-up, then replays the request once;
//   { error: 'step_up_unavailable_sso', action }
//       → an SSO account without a local factor (Obligate re-authentication
//         is not available yet): the action is refused;
//   { error: 'step_up_setup_required', action, twoFactorAllowed }
//       → a local account without any second factor: set one up in /profile
//         (twoFactorAllowed=false: the platform policy forbids enrolling one,
//         the client then says to ask an administrator instead).
//
// Platform admins and tenant admins are subject to it like everyone else.
// An action at 'none' (the default for every tenant) passes untouched.

declare module 'express-session' {
  interface SessionData {
    /** Epoch ms of the last second factor proven through POST /api/auth/step-up. */
    stepUpAt?: number;
    /** E-mail code mailed for a step-up (hash only, see twoFactor.service PendingEmailOtp). */
    stepUpEmailOtp?: PendingEmailOtp;
    /** Epoch ms of the last step-up code mailed (resend cooldown). */
    stepUpEmailSentAt?: number;
  }
}

/** A proven step-up stays valid for 5 minutes. */
export const STEP_UP_TTL_MS = 5 * 60 * 1000;

export type StepUpMethod = 'totp' | 'email';
export const STEP_UP_METHODS: readonly StepUpMethod[] = ['totp', 'email'];

/** The second factors an account can use for a step-up. */
export interface StepUpFactors {
  /** Provisioned by an identity provider (users.foreign_source set). */
  sso: boolean;
  /** Usable methods, in preference order. Empty = none. */
  methods: StepUpMethod[];
  /**
   * The platform 2FA policy lets the account enrol a factor (allow_2fa, or
   * force_2fa while not disabled by DISABLE_2FA_FORCE). Absent = unknown/true.
   */
  twoFactorAllowed?: boolean;
}

export type StepUpRefusalCode = 'step_up_required' | 'step_up_unavailable_sso' | 'step_up_setup_required';

/**
 * The action named in a refusal: a restricted action, or the relaxing of the
 * restrictions themselves (PUT /api/tenant/restrictions).
 */
export type StepUpRefusalAction = ActionKey | 'tenant.restrictions_loosen';

export interface StepUpRefusal {
  success: false;
  error: StepUpRefusalCode;
  action: StepUpRefusalAction;
  methods?: StepUpMethod[];
  /** step_up_setup_required only: false when the platform policy forbids enrolling a factor. */
  twoFactorAllowed?: boolean;
}

// Proofs are also kept in memory per session id: sessions are saved
// last-write-wins, so a concurrent request that loaded the session before the
// proof and saves it afterwards (sessionUserGuard's lastSeenAt…) would erase
// session.stepUpAt and fail the replay. The entry is bound to the user id and
// expires with the TTL; a destroyed / revoked session no longer resolves to
// its id, so a stale entry can never be reached.
const STEP_UP_PROOFS_MAX = 10_000;
const stepUpProofs = new Map<string, { userId: number; at: number }>();

function pruneStepUpProofs(now: number): void {
  for (const [sid, p] of stepUpProofs) {
    if (!isStepUpFresh(p.at, now)) stepUpProofs.delete(sid);
  }
  // Still full: drop the oldest entries (insertion order).
  while (stepUpProofs.size >= STEP_UP_PROOFS_MAX) {
    const first = stepUpProofs.keys().next();
    if (first.done) break;
    stepUpProofs.delete(first.value);
  }
}

/** Records a proven step-up for this session (in the session row and in memory). */
export function recordStepUpProof(req: Request, userId: number, now: number = Date.now()): void {
  req.session.stepUpAt = now;
  const sid = typeof req.sessionID === 'string' ? req.sessionID : '';
  if (!sid) return;
  pruneStepUpProofs(now);
  stepUpProofs.delete(sid);
  stepUpProofs.set(sid, { userId, at: now });
}

/** The request's session proved a factor recently (session row or in-memory record). */
export function hasFreshStepUp(req: Request, userId: number, now: number = Date.now()): boolean {
  if (isStepUpFresh(req.session?.stepUpAt, now)) return true;
  const sid = typeof req.sessionID === 'string' ? req.sessionID : '';
  if (!sid) return false;
  const p = stepUpProofs.get(sid);
  if (!p) return false;
  if (p.userId === userId && isStepUpFresh(p.at, now)) return true;
  if (!isStepUpFresh(p.at, now)) stepUpProofs.delete(sid);
  return false;
}

/** Test helper: forget every in-memory proof. */
export function clearStepUpProofs(): void {
  stepUpProofs.clear();
}

/** The session proved a factor less than STEP_UP_TTL_MS ago (and not in the future). */
export function isStepUpFresh(stepUpAt: unknown, now: number = Date.now()): boolean {
  if (typeof stepUpAt !== 'number' || !Number.isFinite(stepUpAt)) return false;
  const age = now - stepUpAt;
  return age >= 0 && age <= STEP_UP_TTL_MS;
}

/**
 * The refusal for a sensitive action without a fresh step-up, from the
 * account's factors: a usable factor → step_up_required; none and SSO →
 * step_up_unavailable_sso; none (local) → step_up_setup_required.
 */
export function stepUpRefusal(action: StepUpRefusalAction, factors: StepUpFactors): StepUpRefusal {
  if (factors.methods.length > 0) {
    return { success: false, error: 'step_up_required', action, methods: [...factors.methods] };
  }
  if (factors.sso) return { success: false, error: 'step_up_unavailable_sso', action };
  return { success: false, error: 'step_up_setup_required', action, twoFactorAllowed: factors.twoFactorAllowed !== false };
}

type FactorRow = {
  id: number;
  username: string;
  totp_enabled: boolean | null;
  totp_secret: string | null;
  email_otp_enabled: boolean | null;
  email: string | null;
  foreign_source: string | null;
};

async function loadFactorRow(userId: number): Promise<FactorRow | undefined> {
  return await db('users')
    .where({ id: userId, is_active: true })
    .first('id', 'username', 'totp_enabled', 'totp_secret', 'email_otp_enabled', 'email', 'foreign_source') as
    FactorRow | undefined;
}

/**
 * Factors of a row: a live TOTP for everyone; e-mail codes for local accounts
 * only (an SSO account signs in locally with its TOTP only, as at sign-in),
 * when enabled, with an address and an OTP SMTP server configured.
 */
async function factorsOf(row: FactorRow | undefined): Promise<StepUpFactors> {
  if (!row) return { sso: false, methods: [] };
  const sso = !!row.foreign_source;
  const methods: StepUpMethod[] = [];
  if (row.totp_enabled && row.totp_secret) methods.push('totp');
  let cfg: Awaited<ReturnType<typeof appConfigService.getAll>> | null = null;
  if (!sso && row.email_otp_enabled && String(row.email ?? '').trim()) {
    cfg = await appConfigService.getAll();
    if (cfg.otp_smtp_server_id) methods.push('email');
  }
  if (methods.length > 0) return { sso, methods };
  // No factor: say whether the platform policy lets the account enrol one
  // (same rule as twoFactor.controller assert2faAllowed).
  cfg = cfg ?? await appConfigService.getAll();
  const twoFactorAllowed = !!cfg.allow_2fa || (!!cfg.force_2fa && !config.disable2faForce);
  return { sso, methods, twoFactorAllowed };
}

export async function loadStepUpFactors(userId: number): Promise<StepUpFactors> {
  return factorsOf(await loadFactorRow(userId));
}

// ── The gate ────────────────────────────────────────────────────────────────

export interface StepUpGateDeps {
  levelFor(tenantId: number, key: ActionKey): Promise<RestrictionLevel>;
  loadFactors(userId: number): Promise<StepUpFactors>;
  now(): number;
}

/** Gate factory (dependencies injectable for the unit tests). */
export function createStepUpGate(deps: StepUpGateDeps) {
  /**
   * The action is resolved per request (null = this request is not a
   * restricted action, e.g. a probe command other than 'uninstall'). Place it
   * after the validation of the body it reads.
   */
  function requireActionFrom(resolve: (req: Request) => ActionKey | null, action?: ActionKey) {
    return tagGate(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const action = resolve(req);
        if (action === null) return next();
        const userId = toDbId(req.session?.userId);
        if (userId === null) return next(new AppError(401, 'Authentication required'));
        const tenantId = toDbId(req.tenantId);
        if (tenantId === null) return next(new AppError(403, 'no_tenant_access'));

        if ((await deps.levelFor(tenantId, action)) !== 'sensitive') return next();
        if (hasFreshStepUp(req, userId, deps.now())) return next();

        res.status(403).json(stepUpRefusal(action, await deps.loadFactors(userId)));
      } catch (err) {
        next(err);
      }
    }, action === undefined ? { kind: 'stepUp' } : { kind: 'stepUp', action });
  }

  return {
    requireActionFrom: (resolve: (req: Request) => ActionKey | null) => requireActionFrom(resolve),
    requireAction: (key: ActionKey) => requireActionFrom(() => key, key),
  };
}

const gate = createStepUpGate({
  levelFor: (tenantId, key) => restrictionService.levelFor(tenantId, key),
  loadFactors: loadStepUpFactors,
  now: () => Date.now(),
});

/** Require a fresh step-up when `key` is sensitive in the current tenant. */
export const requireAction = gate.requireAction;
/** requireAction for an action that depends on the request (null = not restricted). */
export const requireActionFrom = gate.requireActionFrom;

// ── Proof endpoints (POST /api/auth/step-up, /api/auth/step-up/email) ───────

function codeFrom(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
}

async function auditStepUp(req: Request, action: 'auth.step_up_ok' | 'auth.step_up_failed', userId: number, details: Record<string, unknown>): Promise<void> {
  await auditService.logReq(req, {
    action,
    resourceType: 'user',
    resourceId: userId,
    details,
  });
}

/**
 * Refusal of a proof: 400 with a machine code (never 401, which the web
 * client reads as "signed out" and which clears the ObliTools token).
 */
function proofRefused(res: Response, code: string, message: string): void {
  res.status(400).json({ success: false, error: code, message });
}

export const stepUpController = {
  /** POST /api/auth/step-up { method, code } — proves a second factor for 5 minutes. */
  async verify(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = toDbId(req.session.userId);
      if (userId === null) throw new AppError(401, 'Authentication required');
      const body = (req.body ?? {}) as { method?: unknown; code?: unknown };
      const method = body.method === 'totp' || body.method === 'email' ? body.method : null;
      const code = codeFrom(body.code);

      const row = await loadFactorRow(userId);
      if (!row) throw new AppError(401, 'Authentication required');
      const factors = await factorsOf(row);
      if (!method || !factors.methods.includes(method)) {
        proofRefused(res, 'method_unavailable', 'This verification method is not available for your account');
        return;
      }

      let failure: { code: string; message: string } | null = null;
      if (method === 'totp') {
        const result = await twoFactorService.verifyCurrentTotp(userId, row.totp_secret ?? '', code);
        if (result === 'replayed') failure = { code: 'code_replayed', message: 'This code was already used. Wait for the next code.' };
        else if (result !== 'ok') failure = { code: 'invalid_code', message: 'Invalid code' };
      } else {
        const pending = req.session.stepUpEmailOtp;
        const check = checkEmailOtp(pending, code, { userId, email: row.email });
        if (check === 'invalid' && pending) {
          pending.attempts = (Number(pending.attempts) || 0) + 1;
          if (pending.attempts >= EMAIL_OTP_MAX_ATTEMPTS) delete req.session.stepUpEmailOtp;
          failure = { code: 'invalid_code', message: 'Invalid code' };
        } else if (check === 'none') {
          failure = { code: 'no_code_pending', message: 'Request a code first' };
        } else if (check !== 'ok') {
          delete req.session.stepUpEmailOtp;
          failure = check === 'expired' || check === 'exhausted'
            ? { code: 'code_expired', message: 'This code expired. Request a new code.' }
            : { code: 'no_code_pending', message: 'Request a code first' };
        }
      }

      if (failure) {
        await auditStepUp(req, 'auth.step_up_failed', userId, { method, reason: failure.code });
        proofRefused(res, failure.code, failure.message);
        return;
      }

      const now = Date.now();
      recordStepUpProof(req, userId, now);
      delete req.session.stepUpEmailOtp;
      delete req.session.stepUpEmailSentAt;
      await auditStepUp(req, 'auth.step_up_ok', userId, { method });
      res.json({ success: true, data: { expiresAt: new Date(now + STEP_UP_TTL_MS).toISOString() } });
    } catch (err) {
      next(err);
    }
  },

  /** POST /api/auth/step-up/email — mails a step-up code to the account's address. */
  async sendEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = toDbId(req.session.userId);
      if (userId === null) throw new AppError(401, 'Authentication required');
      const row = await loadFactorRow(userId);
      if (!row) throw new AppError(401, 'Authentication required');
      const factors = await factorsOf(row);
      const email = String(row.email ?? '').trim();
      if (!factors.methods.includes('email') || !email) {
        proofRefused(res, 'method_unavailable', 'E-mail codes are not available for your account');
        return;
      }

      const last = req.session.stepUpEmailSentAt;
      const elapsed = typeof last === 'number' ? Date.now() - last : Infinity;
      if (elapsed >= 0 && elapsed < EMAIL_OTP_RESEND_COOLDOWN_MS) {
        res.setHeader('Retry-After', String(Math.ceil((EMAIL_OTP_RESEND_COOLDOWN_MS - elapsed) / 1000)));
        res.status(429).json({ success: false, error: 'resend_cooldown', message: 'Please wait a minute before requesting a new code' });
        return;
      }

      const cfg = await appConfigService.getAll();
      const code = twoFactorService.generateEmailOtp();
      req.session.stepUpEmailOtp = createPendingEmailOtp(code, userId, email);
      req.session.stepUpEmailSentAt = Date.now();
      try {
        await twoFactorService.sendEmailOtp(Number(cfg.otp_smtp_server_id), email, code);
      } catch (err) {
        delete req.session.stepUpEmailOtp;
        delete req.session.stepUpEmailSentAt;
        logger.warn({ err: (err as Error)?.message, userId }, 'Step-up code could not be mailed');
        res.status(502).json({ success: false, error: 'send_failed', message: 'The code could not be sent. Try again later.' });
        return;
      }
      res.json({ success: true, data: { sentTo: maskEmail(email) } });
    } catch (err) {
      next(err);
    }
  },
};
