import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { isIP } from 'net';
import { sha256Hex } from '../utils/timingSafe';
import { ipv6ToHextets } from '../utils/ssrfGuard';
import { obligateService } from '../services/obligate.service';

// Rate limiters. Every IP-based key uses req.ip ONLY — the address the client
// container's nginx saw (Express 'trust proxy' 1, nginx appends to
// X-Forwarded-For) — never a value parsed from X-Forwarded-For, which the
// client can pre-fill. Behind an edge proxy every user shares that address,
// which is why the brute-force limiters are also keyed on the account (for
// the password step, after the password check: noteLoginAccountFailure).
//
// All limiters answer 429 {success:false, error:'Too many requests'} with the
// draft-7 `RateLimit` / `RateLimit-Policy` headers (+ Retry-After).

const MINUTE = 60 * 1000;

const common = {
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
};

/**
 * req.ip as a bucket key. IPv4-mapped IPv6 is unwrapped; a real IPv6 address
 * is reduced to its /56 prefix, since one client typically owns a whole
 * /56–/64 and could otherwise rotate addresses to get fresh buckets.
 */
function ipKey(req: Request): string {
  const ip = (req.ip ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (isIP(ip) === 6) {
    const h = ipv6ToHextets(ip);
    if (h) return `${h[0].toString(16)}:${h[1].toString(16)}:${h[2].toString(16)}:${(h[3] & 0xff00).toString(16)}::/56`;
  }
  return ip || 'unknown';
}

function sessionUserId(req: Request): number | null {
  const id = Number(req.session?.userId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function pendingMfaUserId(req: Request): number | null {
  const id = Number(req.session?.pendingMfaUserId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Lower-cased username from the body, bounded (keys live in memory). */
function bodyUsername(req: Request): string | null {
  const u = (req.body as { username?: unknown } | undefined)?.username;
  if (typeof u !== 'string') return null;
  const v = u.trim().toLowerCase();
  return v ? v.slice(0, 128) : null;
}

function bodyEmail(req: Request): string | null {
  const e = (req.body as { email?: unknown } | undefined)?.email;
  if (typeof e !== 'string') return null;
  const v = e.trim().toLowerCase();
  return v ? v.slice(0, 254) : null;
}

// Machine-to-machine probe endpoints: authenticated by API key + UUID and
// limited per probe by probeLimiter on their routes. Counting them here would
// make every probe behind one NAT address share the anonymous budget.
const PROBE_EXACT = /^\/api\/probe\/(push|check-results|version|notifying-update|agent\/update-aborted)\/?$/;
const PROBE_PREFIX = /^\/api\/probe\/download\//;

// Global API limiter — mounted in app.ts after the session middleware (and
// sessionUserGuard), so req.session.userId is known here.
//  - Anonymous requests: 500 / 5 min per address (login page, public
//    endpoints, enumeration).
//  - Signed-in requests are keyed on the USER (`u:<id>`), not the address:
//    users behind one reverse proxy share an address and must not share a
//    bucket. 3000 / 5 min is far above dashboard usage, but no session can
//    hammer the API (password oracle, bcrypt exhaustion) without limit.
export const apiLimiter = rateLimit({
  ...common,
  windowMs: 5 * MINUTE,
  limit: (req: Request) => (sessionUserId(req) ? 3000 : 500),
  keyGenerator: (req: Request) => {
    const uid = sessionUserId(req);
    return uid ? `u:${uid}` : `ip:${ipKey(req)}`;
  },
  skip: (req: Request) =>
    // Health check is polled by the login page to show the server version.
    req.path === '/health' ||
    // Auth state probe — answers 401 to anonymous callers, no information.
    req.path === '/api/auth/me' ||
    PROBE_EXACT.test(req.path) ||
    PROBE_PREFIX.test(req.path) ||
    // Device web proxy: sub-resources of the sandboxed device page carry no
    // cookie; the proxy has its own per-tunnel cap (tunnelProxy.service.ts).
    req.path.startsWith('/api/tunnel/p/'),
});

// Login limiter — key = address + username, so users behind one proxy address
// do not lock each other out. Only failures count (skipSuccessfulRequests):
// a user who eventually types the right password is not penalised.
// Applied per route, after express.json(), so req.body is available.
export const authLimiter = rateLimit({
  ...common,
  windowMs: 5 * MINUTE,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => `${ipKey(req)}:${bodyUsername(req) ?? ''}`,
});

// Failed sign-ins per ACCOUNT, all addresses together (a password spray
// against one account from many addresses): 30 / 15 min. Deliberately NOT a
// limiter in front of the login route: keyed on a username anyone can send,
// it would let one address (authLimiter allows it 60 failures / 15 min) keep
// the owner locked out, right password included. authController.login
// consults it AFTER the password check (same bcrypt work either way): the
// right password always signs in and clears the count; past the limit a
// wrong one is answered 429, and the flood is logged and audited once per
// window. Fixed window, in memory (like the limiters above).
const LOGIN_ACCOUNT_WINDOW_MS = 15 * MINUTE;
const LOGIN_ACCOUNT_MAX_FAILURES = 30;
const MAX_LOGIN_ACCOUNTS = 10_000;
const loginAccountFailures = new Map<string, { windowStart: number; count: number }>();

/** Same normalisation as bodyUsername (trimmed, lower-cased, bounded). */
function loginAccountKey(username: string): string | null {
  const v = username.trim().toLowerCase();
  return v ? v.slice(0, 128) : null;
}

/**
 * Records a failed sign-in of `username`. `flooded`: the account is past the
 * limit (answer 429); `crossed`: this failure crossed it (log / audit once);
 * `retryAfterSec`: seconds until the window ends.
 */
export function noteLoginAccountFailure(
  username: string,
  now: number = Date.now(),
): { flooded: boolean; crossed: boolean; retryAfterSec: number } {
  const key = loginAccountKey(username);
  if (!key) return { flooded: false, crossed: false, retryAfterSec: 0 };
  let entry = loginAccountFailures.get(key);
  if (!entry || now - entry.windowStart >= LOGIN_ACCOUNT_WINDOW_MS) {
    if (!entry && loginAccountFailures.size >= MAX_LOGIN_ACCOUNTS) loginAccountFailures.clear();
    entry = { windowStart: now, count: 0 };
    loginAccountFailures.set(key, entry);
  }
  entry.count += 1;
  return {
    flooded: entry.count > LOGIN_ACCOUNT_MAX_FAILURES,
    crossed: entry.count === LOGIN_ACCOUNT_MAX_FAILURES + 1,
    retryAfterSec: Math.max(1, Math.ceil((entry.windowStart + LOGIN_ACCOUNT_WINDOW_MS - now) / 1000)),
  };
}

/** The right password was given for `username`: its failure count starts over. */
export function clearLoginAccountFailures(username: string): void {
  const key = loginAccountKey(username);
  if (key) loginAccountFailures.delete(key);
}

// 2FA code verification, per address: 50 wrong codes / 15 min, as in
// Obliance (deliberately above the 10 / 5 min first planned: behind an edge
// proxy every user shares req.ip, and 10 typos across the organisation would
// block 2FA sign-in for everyone). Only requests of a pending 2FA sign-in
// count: without one the controller refuses the code anyway, and counting
// them would let anyone — no cookie, no password — exhaust the bucket that
// every user behind a shared address depends on. Filling it needs many valid
// passwords; one account's codes are bounded by mfaAccountLimiter (10 / 15
// min). For the sign-in step only: 2FA factor management by a signed-in user
// (no pending sign-in) is skipped here — use passwordChangeLimiter there.
export const mfaLimiter = rateLimit({
  ...common,
  windowMs: 15 * MINUTE,
  limit: 50,
  skipSuccessfulRequests: true,
  skip: (req: Request) => pendingMfaUserId(req) === null,
  keyGenerator: (req: Request) => `mfa-ip:${ipKey(req)}`,
});

// 2FA code verification, per ACCOUNT (the pending 2FA user): the attacker
// already holds the password and can open new pending sessions from any
// number of addresses; 10 wrong codes / 15 min keeps a 6-digit code out of
// reach. Use together with mfaLimiter.
export const mfaAccountLimiter = rateLimit({
  ...common,
  windowMs: 15 * MINUTE,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => `mfa-user:${pendingMfaUserId(req) ?? sessionUserId(req) ?? 'none'}`,
});

// Endpoints that SEND an e-mail (forgot-password, 2FA code resend, 2FA e-mail
// setup): every request counts, successful ones included (they answer 200
// whether or not a mail went out). 3 / 15 min per key.
// Key: the session's user when there is one — so a signed-in or pending-2FA
// caller cannot get fresh buckets by varying body.email — otherwise the
// normalised body.email (forgot-password), otherwise the address.
export const emailSendLimiter = rateLimit({
  ...common,
  windowMs: 15 * MINUTE,
  limit: 3,
  keyGenerator: (req: Request) => {
    const uid = sessionUserId(req) ?? pendingMfaUserId(req);
    if (uid) return `mail-u:${uid}`;
    const email = bodyEmail(req);
    if (email) return `mail:${email}`;
    return `mail-ip:${ipKey(req)}`;
  },
});

// Password change / set and 2FA factor management, per signed-in user:
// 5 failures / 15 min — bounds a current-password oracle held by a stolen
// session, and bcrypt CPU use.
export const passwordChangeLimiter = rateLimit({
  ...common,
  windowMs: 15 * MINUTE,
  limit: 5,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => {
    const uid = sessionUserId(req);
    return uid ? `pwd:${uid}` : `pwd-ip:${ipKey(req)}`;
  },
});

// Probe HTTP endpoints (push, check-results). API keys are hashed so no
// secret is kept in the limiters' memory. Two buckets:
//  - per probe identity (API key + UUID): 120 / 5 min;
//  - per address, REJECTED credentials only (401: unknown API key, malformed
//    UUID): 60 / 5 min. apiLimiter skips these paths, so without it a caller
//    sending a random X-API-Key would get a fresh identity bucket, and a key
//    lookup, on every request. Pending / refused / unregistered probes (403,
//    404, 409) never count. An API key that authenticated a POST in the last
//    24 h skips this bucket, so bogus keys flooding in through a shared
//    address (edge proxy, NAT) cannot lock the real probes out.
const probeIdentityLimiter = rateLimit({
  ...common,
  windowMs: 5 * MINUTE,
  limit: 120,
  keyGenerator: (req: Request) => {
    const apiKey = req.headers['x-api-key'];
    const uuid = req.headers['x-probe-uuid'];
    if (typeof apiKey === 'string' && apiKey && typeof uuid === 'string' && uuid) {
      return `probe:${sha256Hex(apiKey).slice(0, 32)}:${uuid.slice(0, 64).toLowerCase()}`;
    }
    return `probe-ip:${ipKey(req)}`;
  },
});

const KNOWN_PROBE_KEY_TTL_MS = 24 * 60 * MINUTE;
const MAX_KNOWN_PROBE_KEYS = 10_000;
const knownProbeKeys = new Map<string, number>(); // sha256(API key) → expires at

function probeKeyDigest(req: Request): string | null {
  const apiKey = req.headers['x-api-key'];
  return typeof apiKey === 'string' && apiKey ? sha256Hex(apiKey) : null;
}

function isKnownProbeKey(req: Request): boolean {
  const digest = probeKeyDigest(req);
  if (!digest) return false;
  const expiresAt = knownProbeKeys.get(digest);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  knownProbeKeys.delete(digest);
  return false;
}

const probeAuthFailLimiter = rateLimit({
  ...common,
  windowMs: 5 * MINUTE,
  limit: 60,
  skipSuccessfulRequests: true,
  // Only an authentication refusal counts as a failure.
  requestWasSuccessful: (_req: Request, res: Response) => res.statusCode !== 401,
  skip: (req: Request) => isKnownProbeKey(req),
  keyGenerator: (req: Request) => `probe-fail:${ipKey(req)}`,
});

export function probeLimiter(req: Request, res: Response, next: NextFunction): void {
  probeIdentityLimiter(req, res, (err?: unknown) => {
    if (err) { next(err); return; }
    probeAuthFailLimiter(req, res, (err2?: unknown) => {
      if (err2) { next(err2); return; }
      const digest = probeKeyDigest(req);
      // The authenticated probe endpoints are all POSTs (GET /version and
      // /download answer 200 whatever the key).
      if (digest && req.method === 'POST') {
        res.once('finish', () => {
          if (res.statusCode >= 400) return;
          if (knownProbeKeys.size >= MAX_KNOWN_PROBE_KEYS) knownProbeKeys.clear();
          knownProbeKeys.set(digest, Date.now() + KNOWN_PROBE_KEY_TTL_MS);
        });
      }
      next();
    });
  });
}

// Device Checks rule / credential mutations, per user: 60 / 10 min.
export const deviceCheckMutationLimiter = rateLimit({
  ...common,
  windowMs: 10 * MINUTE,
  limit: 60,
  keyGenerator: (req: Request) => {
    const uid = sessionUserId(req);
    return uid ? `u:${uid}` : `ip:${ipKey(req)}`;
  },
});

// Device Checks "test now" (makes a probe contact a device), per user: 10 / 5 min.
export const deviceCheckTestLimiter = rateLimit({
  ...common,
  windowMs: 5 * MINUTE,
  limit: 10,
  keyGenerator: (req: Request) => {
    const uid = sessionUserId(req);
    return uid ? `u:${uid}` : `ip:${ipKey(req)}`;
  },
});

/**
 * The request presents the Bearer that verifyInboundBearer accepts (the
 * Obligate inbound secret, else the API key). While SSO is disabled nothing
 * is skipped. verifyInboundBearer reads the 10 s cached config, which every
 * config write clears.
 */
async function presentsObligateKey(req: Request): Promise<boolean> {
  try {
    return await obligateService.verifyInboundBearer(req.headers.authorization);
  } catch {
    return false; // config unreadable: count the request normally
  }
}

// Obligate reverse-auth endpoints (Bearer inbound secret, else the API key:
// app-info, dashboard-stats, sso-user-sync): 20 failed attempts / 15 min per
// address. A request that presents the right secret is skipped, so bad keys sent through a shared address
// (edge proxy) can never block Obligate's own calls — its user-sync calls
// (deactivate, role change) are security relevant.
export const bearerFailLimiter = rateLimit({
  ...common,
  windowMs: 15 * MINUTE,
  limit: 20,
  skipSuccessfulRequests: true,
  skip: presentsObligateKey,
  keyGenerator: (req: Request) => `bearer:${ipKey(req)}`,
});
