import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';

// CSRF defence in depth on top of the SameSite=Lax session cookie. SameSite
// does not separate sibling sub-domains (same site), so a script running on
// another *.example.com app could still send credentialed, body-less POSTs.
//
// For state-changing requests (anything but GET / HEAD / OPTIONS) on /api and
// /auth that carry the session cookie, the request must show it is ours:
//   1. Sec-Fetch-Site is 'same-origin' or 'none' (typed URL, bookmark) — sent
//      by every current browser; otherwise
//   2. the Origin (or, failing that, Referer) is one of CLIENT_ORIGIN's
//      origins or APP_URL's origin; or — only for browsers that do not send
//      Sec-Fetch-Site at all (Chrome < 76, Firefox < 90, Safari < 16.4) — the
//      Host this request was sent to. A browser that sends Sec-Fetch-Site and
//      did not say 'same-origin' is, by its own account, on another origin:
//      matching its Origin against our Host could only wrongly accept, e.g. a
//      page on another port of the same host name (cookies are not isolated
//      by port, and nginx's $host drops the port);
//   3. with no Origin, Referer nor Sec-Fetch-Site at all (not a browser:
//      scripts, CLI tools), a header an HTML form cannot send cross-site
//      without a CORS preflight: Content-Type application/json or
//      X-Requested-With.
// Everything else answers 403.
//
// Not checked: machine-to-machine endpoints (probes, Obligate reverse-auth
// Bearer calls), and any request with an Authorization: Bearer header but no
// session cookie — without the cookie there is no ambient credential to abuse.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const EXEMPT_PATHS = new Set([
  '/api/probe/push',
  '/api/probe/check-results',
  '/api/probe/notifying-update',
  '/api/auth/app-info',
  '/api/auth/dashboard-stats',
  '/api/auth/sso-user-sync',
]);

function hasCookie(header: string | undefined, name: string): boolean {
  if (!header) return false;
  return header.split(';').some((part) => part.trim().startsWith(`${name}=`));
}

function carriesSessionCookie(req: Request): boolean {
  const header = req.headers.cookie;
  return hasCookie(header, config.sessionCookieName) || hasCookie(header, 'connect.sid');
}

function originOf(value: string): URL | null {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function allowedOrigins(): Set<string> {
  const set = new Set<string>();
  for (const o of [...config.clientOrigins, config.appUrl]) {
    const u = originOf(o);
    if (u) set.add(u.origin);
  }
  return set;
}

/**
 * The Host header as sent by the client container's nginx ($host drops the
 * port). Used only for browsers without Sec-Fetch-Site (see above).
 */
function matchesHost(source: URL, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  if (source.host.toLowerCase() === host) return true;
  // Host without a port (nginx $host): compare host names only — the public
  // port is unknown here (e.g. the default compose publishes :3002).
  const hasPort = /:\d+$/.test(host) && !/^\[[^\]]*\]$/.test(host);
  return !hasPort && source.hostname.toLowerCase() === host;
}

/** A header a cross-site HTML form (or a CORS-simple request) cannot carry. */
function hasNonFormSignal(req: Request): boolean {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' || req.headers['x-requested-with'] !== undefined;
}

export function csrfOriginCheck(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) { next(); return; }

  const path = (req.originalUrl || req.url || '').split('?')[0].toLowerCase().replace(/\/+$/, '');
  if (!/^\/(api|auth)(\/|$)/.test(path)) { next(); return; }
  // Device web proxy: token-authenticated, never uses the session (its
  // sandboxed pages send Origin: null).
  if (path.startsWith('/api/tunnel/p/')) { next(); return; }
  if (EXEMPT_PATHS.has(path)) { next(); return; }
  if (!carriesSessionCookie(req)) { next(); return; }

  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'same-origin' || fetchSite === 'none') { next(); return; }

  const originHeader = req.headers.origin;
  const refererHeader = req.headers.referer;
  const claimed = typeof originHeader === 'string' && originHeader
    ? originHeader
    : (typeof refererHeader === 'string' ? refererHeader : '');

  // No provenance at all: not a browser — or a very old one.
  if (!claimed && fetchSite === undefined && hasNonFormSignal(req)) { next(); return; }

  const source = claimed ? originOf(claimed) : null; // "null" origin → refused
  if (source && (allowedOrigins().has(source.origin)
    || (fetchSite === undefined && matchesHost(source, req.headers.host)))) {
    next();
    return;
  }
  res.status(403).json({ success: false, error: 'Cross-site request refused' });
}
