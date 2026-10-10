import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { config } from '../config';
import { appConfigService } from '../services/appConfig.service';
import { logger } from '../utils/logger';

// Server-side account policy for signed-in sessions (mounted on /api after
// the rate limiter). Until the user complies, every API call outside a small
// allowlist answers 403 with a machine-readable error the client routes on:
//   - 'password_change_required' — users.must_change_password is set
//     (bootstrapped default admin, password reset by an admin);
//   - '2fa_setup_required' — app_config force_2fa is on (and DISABLE_2FA_FORCE
//     is not set) and the user has neither TOTP nor e-mail OTP enabled.
//     Accounts provisioned by Obligate SSO (users.foreign_source set) are not
//     subject to it: they sign in through the identity provider, which owns
//     their second factor.
// The allowlist keeps what the user needs to comply (profile, password, 2FA
// setup), sign out, and load / switch tenants.

type Rule = { path: string; prefix?: boolean; methods?: string[] };

const ALLOWLIST: Rule[] = [
  { path: '/api/auth/me' },
  // Loaded by the client at start-up next to /auth/me (same information).
  { path: '/api/auth/permissions', methods: ['GET'] },
  { path: '/api/auth/logout' },
  { path: '/api/auth/enrollment' },
  { path: '/api/auth/set-password' },
  // Read-only helpers of the sign-in / sign-out flow (Obligate logout URL).
  { path: '/api/auth/sso-config', methods: ['GET'] },
  { path: '/api/auth/sso-logout-url', methods: ['GET'] },
  { path: '/api/profile' },
  { path: '/api/profile/password' },
  { path: '/api/profile/2fa', prefix: true },
  // "Sign out my other sessions" stays available to a user forced to act.
  { path: '/api/profile/sessions', prefix: true },
  { path: '/api/tenants', methods: ['GET'] },
  { path: '/api/tenant', methods: ['GET'] },
  { path: '/api/tenants/switch', methods: ['POST'] },
  { path: '/api/tenant/switch', methods: ['POST'] },
  // The profile page reads allow_2fa / force_2fa from here (non-secret flags).
  { path: '/api/admin/config', methods: ['GET'] },
  { path: '/api/admin/config/public', methods: ['GET'] },
  // ObliTools desktop shell manifest (app name, linked Obli* apps): the shell
  // loads it to render its frame around the page where the user complies.
  { path: '/api/oblitools/manifest', methods: ['GET'] },
];

/** Normalised request path, or null when it looks crafted (never allowlisted). */
function requestPath(req: Request): string | null {
  const raw = (req.originalUrl || req.url || '').split('?')[0];
  if (/\.\.|%2e|%2f|%5c|\\|\/\//i.test(raw)) return null;
  // Express routing is case-insensitive and ignores a trailing slash.
  return raw.toLowerCase().replace(/\/+$/, '') || '/';
}

function isAllowlisted(req: Request): boolean {
  const path = requestPath(req);
  if (path === null) return false;
  const method = req.method.toUpperCase();
  return ALLOWLIST.some((r) =>
    (path === r.path || (r.prefix === true && path.startsWith(`${r.path}/`)))
    && (!r.methods || r.methods.includes(method) || (method === 'HEAD' && r.methods.includes('GET'))));
}

// ── Cached lookups ────────────────────────────────────────────────────────
// Compliant users are cached 5 s. Restricted users are re-read on every
// request, so the block lifts the moment they change the password / enable
// a factor (their traffic is mostly allowlisted anyway).

const USER_TTL_MS = 5_000;
const FORCE_2FA_TTL_MS = 10_000;
const MAX_ENTRIES = 10_000;

type PolicyState = { mustChangePassword: boolean; missing2fa: boolean };
const compliantUsers = new Map<number, number>(); // userId → cached at
let force2fa: { at: number; on: boolean } | null = null;

// must_change_password is added by migration 036; select it only once it exists.
let hasMustChangeColumn: Promise<boolean> | null = null;
function mustChangeColumnExists(): Promise<boolean> {
  if (!hasMustChangeColumn) {
    hasMustChangeColumn = db.schema.hasColumn('users', 'must_change_password').catch((err) => {
      hasMustChangeColumn = null;
      throw err;
    });
  }
  return hasMustChangeColumn;
}

/** Drops cached state of one user (or everyone): call after a password change or 2FA change. */
export function invalidateAccountPolicyCache(userId?: number): void {
  if (userId === undefined) compliantUsers.clear();
  else compliantUsers.delete(userId);
}

async function stateOf(userId: number): Promise<PolicyState | null> {
  const columns = ['totp_enabled', 'email_otp_enabled', 'foreign_source'];
  if (await mustChangeColumnExists()) columns.push('must_change_password');
  const row = await db('users').where({ id: userId }).first(columns) as {
    totp_enabled: boolean | null;
    email_otp_enabled: boolean | null;
    foreign_source: string | null;
    must_change_password?: boolean | null;
  } | undefined;
  if (!row) return null;
  return {
    mustChangePassword: row.must_change_password === true,
    missing2fa: !row.totp_enabled && !row.email_otp_enabled && !row.foreign_source,
  };
}

async function isForce2faOn(): Promise<boolean> {
  if (config.disable2faForce) return false;
  const now = Date.now();
  if (force2fa && now - force2fa.at < FORCE_2FA_TTL_MS) return force2fa.on;
  const on = (await appConfigService.get('force_2fa')) === 'true';
  force2fa = { at: now, on };
  return on;
}

export async function enforceAccountPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = Number(req.session?.userId);
  if (!Number.isInteger(userId) || userId <= 0) { next(); return; }

  const now = Date.now();
  const cachedAt = compliantUsers.get(userId);
  if (cachedAt !== undefined && now - cachedAt < USER_TTL_MS) { next(); return; }
  if (isAllowlisted(req)) { next(); return; }

  try {
    const state = await stateOf(userId);
    // Unknown user: sessionUserGuard / requireAuth deal with it.
    if (!state) { next(); return; }
    if (state.mustChangePassword) {
      res.status(403).json({ success: false, error: 'password_change_required' });
      return;
    }
    if (state.missing2fa && await isForce2faOn()) {
      res.status(403).json({ success: false, error: '2fa_setup_required' });
      return;
    }
    if (compliantUsers.size >= MAX_ENTRIES) compliantUsers.clear();
    compliantUsers.set(userId, now);
    next();
  } catch (err) {
    logger.error({ err, userId }, 'enforceAccountPolicy: lookup failed');
    res.status(503).json({ success: false, error: 'Service unavailable' });
  }
}
