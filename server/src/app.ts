import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import type { SessionData } from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Read server version from package.json at startup.
// process.cwd() is the server directory in both dev (npx tsx) and Docker (WORKDIR /app/server).
let serverVersion = 'dev';
try {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
  serverVersion = pkg.version;
} catch { /* ignore */ }
import { config, assertProductionConfig } from './config';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiter';
import { sessionUserGuard } from './middleware/sessionUserGuard';
import { csrfOriginCheck } from './middleware/originCheck';
import { enforceAccountPolicy } from './middleware/accountPolicy';
import { routes } from './routes';
import { tunnelOriginGuard, skipForTunnelProxy } from './services/tunnelProxy.service';
import { logger } from './utils/logger';
import { toDbId } from './utils/dbId';
import { isIP } from 'net';
import { sha256Hex } from './utils/timingSafe';
import { ipv6ToHextets } from './utils/ssrfGuard';

const PgSession = connectPgSimple(session);

// ── Session transport ──────────────────────────────────────────────────────
// One session store and one session middleware, shared by the Express app and
// the Socket.io handshake (socket.ts: io.engine.use(getSessionMiddleware())),
// so sockets authenticate against exactly the same server-side sessions.
//
// ObliTools desktop shell: it embeds the app in a cross-site iframe where the
// browser blocks every cookie. After a password login the server returns the
// session id (sessionToken) in the response body; inside ObliTools only, the
// client keeps it in sessionStorage and sends it back as the X-Auth-Token
// header (and as handshake.auth.token for Socket.io). Hardened handling:
//   - only on /api requests that carry NO session cookie, and only for a
//     session id of the expected shape;
//   - resolved through the session store: the request is bound to THAT stored
//     session (same row), for this request only. No new session is created
//     from it, nothing is copied, no cookie is ever set: express-session does
//     not run for such a request. A change made during the request (tenant
//     switch, sessionUserGuard bookkeeping) is written back to the same row,
//     logout destroys that row, killSessionsForUser deletes it — the token is
//     revoked with the session it names;
//   - only a completed sign-in (userId) is honoured — a session still waiting
//     for its 2FA code, or an anonymous one, is ignored;
//   - lookups that miss are limited per address (lookupSessionToken);
//   - the token is never logged.
let sessionStore: session.Store | null = null;
let sessionMiddleware: RequestHandler | null = null;

/** The express-session middleware (null before createApp() has run). */
export function getSessionMiddleware(): RequestHandler | null {
  return sessionMiddleware;
}

/** express-session ids (uid-safe, base64url): what X-Auth-Token / handshake.auth.token may carry. */
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

export function isSessionTokenShape(value: unknown): value is string {
  return typeof value === 'string' && SESSION_TOKEN_RE.test(value);
}

/**
 * The stored session named by a session id (X-Auth-Token / Socket.io
 * handshake.auth.token), or null when the value is malformed, the session is
 * missing or expired, or the store fails. Never logs the token.
 */
export function getSessionByToken(token: unknown): Promise<SessionData | null> {
  const store = sessionStore;
  if (!store || !isSessionTokenShape(token)) return Promise.resolve(null);
  return new Promise((resolve) => {
    store.get(token, (err, data) => {
      resolve(!err && data && typeof data === 'object' ? data : null);
    });
  });
}

// ── Token lookups that miss, per address ──────────────────────────────────
// Unlike the cookie (signed: a forged value is refused before any query), a
// token is a bare session id, so every well-formed value costs a session-store
// query — before apiLimiter on HTTP, and on Socket.io handshakes, which no
// limiter covers. Lookups that find no signed-in session are counted per
// address (the rate limiters' key: req.ip, the address the client container's
// nginx saw). Past TOKEN_MISS_LIMIT in the window, further tokens from that
// address are not looked up (treated as absent) until the window ends. A
// token that resolved in the last 24 h is still looked up, so junk sent
// through a shared address (edge proxy, NAT) cannot sign ObliTools users out.
// Only token digests are kept in memory.
const TOKEN_MISS_WINDOW_MS = 5 * 60_000;
const TOKEN_MISS_LIMIT = 50;
const KNOWN_TOKEN_TTL_MS = 24 * 60 * 60_000;
const MAX_TRACKED = 10_000;
const tokenMisses = new Map<string, { windowStart: number; misses: number }>();
const knownTokens = new Map<string, number>(); // sha256(token) → expires at

/** Bucket of an address: IPv4-mapped IPv6 unwrapped, IPv6 reduced to its /56 (as middleware/rateLimiter.ts). */
function addressBucket(address: string | undefined): string {
  const ip = (address ?? '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (isIP(ip) === 6) {
    const h = ipv6ToHextets(ip);
    if (h) return `${h[0].toString(16)}:${h[1].toString(16)}:${h[2].toString(16)}:${(h[3] & 0xff00).toString(16)}::/56`;
  }
  return ip || 'unknown';
}

/**
 * The completed sign-in (userId set) named by a token sent from
 * `clientAddress` (req.ip, or its equivalent for a Socket.io handshake), under
 * the miss limiter above; null otherwise. Never logs the token.
 */
export async function lookupSessionToken(token: unknown, clientAddress: string | undefined): Promise<SessionData | null> {
  if (!isSessionTokenShape(token)) return null;
  const now = Date.now();
  const digest = sha256Hex(token);
  const knownUntil = knownTokens.get(digest);
  const known = knownUntil !== undefined && knownUntil > now;
  const bucket = addressBucket(clientAddress);
  const entry = tokenMisses.get(bucket);
  if (!known && entry && now - entry.windowStart < TOKEN_MISS_WINDOW_MS && entry.misses >= TOKEN_MISS_LIMIT) {
    return null;
  }

  const data = await getSessionByToken(token);
  if (data && toDbId(data.userId) !== null) {
    if (!known && knownTokens.size >= MAX_TRACKED) knownTokens.clear();
    knownTokens.set(digest, now + KNOWN_TOKEN_TTL_MS);
    return data;
  }

  knownTokens.delete(digest);
  const current = tokenMisses.get(bucket); // re-read: other lookups ran meanwhile
  if (current && now - current.windowStart < TOKEN_MISS_WINDOW_MS) {
    current.misses++;
  } else {
    if (tokenMisses.size >= MAX_TRACKED) tokenMisses.clear();
    tokenMisses.set(bucket, { windowStart: now, misses: 1 });
  }
  return null;
}

function hasCookie(header: string | undefined, name: string): boolean {
  if (!header) return false;
  return header.split(';').some((part) => part.trim().startsWith(`${name}=`));
}

/** The X-Auth-Token of a request that may use it, else null. */
function xAuthTokenOf(req: Request): string | null {
  const raw = req.headers['x-auth-token'];
  if (!isSessionTokenShape(raw)) return null;
  if (!/^\/api(\/|$)/.test(req.path)) return null;
  // A request with the session cookie is authenticated by the cookie only.
  if (hasCookie(req.headers.cookie, config.sessionCookieName)) return null;
  return raw;
}

/** Session content as express-session compares it (the cookie excluded). */
function sessionSnapshot(sess: object): string {
  return JSON.stringify(sess, function (this: unknown, key, value) {
    return this === sess && key === 'cookie' ? undefined : value;
  });
}

/**
 * Binds the request to the stored session `token` (see above). Writes a
 * modified session back to the same row when the response ends; a session
 * regenerated during the request (sign-in again, sessionUserGuard dropping it)
 * is saved only when it holds something (never an empty one). No cookie.
 */
function bindTokenSession(req: Request, res: Response, token: string, data: SessionData): void {
  const store = sessionStore as Express.SessionStore;
  req.sessionStore = store;
  req.sessionID = token;
  store.createSession(req, data); // sets req.session, bound to the token's row
  const loaded = sessionSnapshot(req.session);

  const end = res.end as (...args: unknown[]) => Response;
  let ending = false;
  res.end = function endWithTokenSession(this: Response, ...args: unknown[]): Response {
    if (ending) return this;
    ending = true;
    const sess = req.session as (session.Session & Partial<SessionData>) | undefined;
    const persist = !!sess && (sess.id === token
      ? sessionSnapshot(sess) !== loaded
      : Object.keys(sess).some((k) => k !== 'cookie'));
    if (!persist || !sess) return end.apply(this, args);
    sess.save((err?: unknown) => {
      if (err) logger.error({ err, userId: sess.userId }, 'Could not save the session of an X-Auth-Token request');
      end.apply(res, args);
    });
    return this;
  } as Response['end'];
}

/**
 * Session middleware of the app: the X-Auth-Token session when the request
 * may use one and it names a signed-in session, otherwise the cookie session.
 */
async function sessionTransport(req: Request, res: Response, next: NextFunction): Promise<void> {
  const cookieSession = sessionMiddleware as RequestHandler;
  const token = xAuthTokenOf(req);
  if (token !== null) {
    const data = await lookupSessionToken(token, req.ip);
    if (data && data.cookie) {
      let bound = false;
      try {
        bindTokenSession(req, res, token, data);
        bound = true;
      } catch (err) {
        logger.warn({ err: (err as Error)?.message }, 'X-Auth-Token session could not be loaded; request continues without it');
        const r = req as unknown as Record<string, unknown>;
        delete r.session;
        delete r.sessionID;
      }
      if (bound) {
        next();
        return;
      }
    }
  }
  cookieSession(req, res, next);
}

/**
 * Session cookie `Secure` flag. FORCE_HTTPS=true: always. Production
 * otherwise: 'auto' — Secure whenever the request reached us over HTTPS
 * (directly or through the trusted proxy's X-Forwarded-Proto), while a
 * deployment still served over plain HTTP keeps working (a Secure cookie
 * would never come back over HTTP and would lock every user out).
 * Development: FORCE_HTTPS only.
 */
function cookieSecureOption(): boolean | 'auto' {
  if (config.forceHttps) return true;
  return config.nodeEnv === 'production' ? 'auto' : false;
}

export function createApp() {
  // Insecure-but-working configuration is reported loudly, never fatal:
  // existing deployments must keep starting (see config.ts).
  try {
    for (const warning of assertProductionConfig()) logger.warn(`[config] ${warning}`);
  } catch (err) {
    logger.error(err, 'Configuration check failed');
  }

  const app = express();

  // Trust the first reverse proxy hop (the client container's nginx, which
  // appends to X-Forwarded-For) so req.ip is the address nginx saw — the
  // rate-limit key, which a client cannot forge. The real client address for
  // audit / display comes from utils/clientIp.ts (TRUSTED_PROXIES); do not
  // raise this to TRUSTED_PROXY_HOPS.
  app.set('trust proxy', 1);

  // Security headers.
  // Framing stays allowed: the ObliTools desktop shell embeds this app in a
  // cross-site iframe (no X-Frame-Options, no frame-ancestors — helmet's
  // default frame-ancestors 'self' is removed explicitly).
  app.use(
    helmet({
      frameguard: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'", "wss:", "ws:"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: null,
        },
      },
      hsts: { maxAge: 31536000, includeSubDomains: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    }),
  );
  // TUNNEL_ORIGIN host isolation: on the dedicated tunnel host only the
  // device web proxy (/api/tunnel/p/) answers.
  app.use(tunnelOriginGuard);
  // The device web proxy answers its own CORS / preflights and needs the raw
  // request body (services/tunnelProxy.service.ts): cors() and express.json()
  // skip /api/tunnel/p/.
  app.use(
    skipForTunnelProxy(cors({
      // CLIENT_ORIGIN may list several origins (comma-separated).
      origin: config.clientOrigins,
      credentials: true,
    })),
  );

  // Parsing — cookieParser must come before session (session reads the cookie).
  // Probe pushes of large sites exceed 1 MB: same ceiling as the probe
  // WebSocket maxPayload (4 MiB). The global parser skips an already-parsed body.
  app.use('/api/probe/push', express.json({ limit: '4mb' }));
  app.use('/api/probe/check-results', express.json({ limit: '4mb' }));
  // JSON imports carry the devices / reservations of large tenants.
  app.use('/api/admin/import', express.json({ limit: '16mb' }));
  app.use(skipForTunnelProxy(express.json({ limit: '1mb' })));
  app.use(cookieParser());

  // Sessions — stored in PostgreSQL via connect-pg-simple.
  // Log errors so we can diagnose DB connection drops that would otherwise
  // silently cause "Invalid username or password" on the login page.
  const store = new PgSession({
    conString: config.databaseUrl,
    tableName: 'session',
    createTableIfMissing: false,
  });
  store.on('error', (err: Error) => {
    logger.error(err, 'Session store error — sessions may fail until DB connection recovers');
  });
  sessionStore = store;
  sessionMiddleware = session({
    // Own cookie name: Obli* apps sharing a host name no longer overwrite
    // each other's connect.sid (logout also clears the legacy name).
    name: config.sessionCookieName,
    store,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecureOption(),
      maxAge: config.sessionMaxAge,
    },
  });

  // MUST run before everything that reads req.session: sessionUserGuard,
  // the CSRF check, the rate limiter (keys signed-in users on their id) and
  // the routes. X-Auth-Token requests (ObliTools) are bound here too.
  app.use((req, res, next) => { sessionTransport(req, res, next).catch(next); });

  // The session's user is re-read (is_active, role — cached a few seconds):
  // a session of a disabled / deleted user ends, a demoted admin loses the
  // role, idle and absolute session lifetimes are enforced.
  app.use(sessionUserGuard);

  // CSRF defence in depth for cookie-authenticated state-changing requests.
  app.use(csrfOriginCheck);

  // Rate limiting — runs after the session so signed-in users get their own bucket.
  app.use(apiLimiter);

  // Obligate SSO browser redirects (must be before /api so the browser can reach /auth/callback)
  const obligateCallback = require('./routes/obligateCallback.routes').default;
  app.use('/auth', obligateCallback);

  // Forced password change / 2FA setup: everything else answers 403 until done.
  app.use('/api', enforceAccountPolicy);

  // API routes
  app.use('/api', routes);

  // Health check (public — also used by login page to display server version)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: serverVersion, timestamp: new Date().toISOString() });
  });

  // Obli.tools unified desktop app downloads — serves pre-built binaries from obli.tools/dist/.
  // Whitelist prevents directory traversal; graceful 404 if a file isn't built yet.
  const DESKTOP_FILES: Record<string, string> = {
    'ObliTools.exe':          'ObliTools.exe',          // Windows binary (portable)
    'ObliToolsSetup.msi':     'ObliToolsSetup.msi',     // Windows installer (Start Menu shortcut)
    'ObliTools-arm64.zip':    'ObliTools-arm64.zip',    // macOS Apple Silicon — .app zipped
    'ObliTools-amd64.zip':    'ObliTools-amd64.zip',    // macOS Intel — .app zipped
    'ObliTools-arm64.dmg':    'ObliTools-arm64.dmg',    // macOS Apple Silicon — drag-to-Applications DMG
    'ObliTools-amd64.dmg':    'ObliTools-amd64.dmg',    // macOS Intel — drag-to-Applications DMG
  };
  // process.cwd() = server/ directory (both in dev with npx tsx and in production).
  // Go one level up to reach the project root, then into obli.tools/dist.
  const desktopDistDir = path.resolve(process.cwd(), '..', 'obli.tools', 'dist');

  app.get('/downloads/:filename', (req, res) => {
    const mapped = DESKTOP_FILES[req.params.filename];
    if (!mapped) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const filePath = path.join(desktopDistDir, mapped);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'File not yet available' });
      return;
    }
    res.download(filePath, mapped);
  });

  // Serve static client build in production
  if (!config.isDev) {
    const clientDist = path.join(__dirname, '../../client/dist');
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // Error handling
  app.use(errorHandler);

  return app;
}
