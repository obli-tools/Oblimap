// Problems found while parsing the environment. config.ts cannot use the
// logger (the logger imports config), so they are collected here and returned
// by assertProductionConfig(), whose caller logs them.
const parseWarnings: string[] = [];

/** Integer env var within [min, max]; anything else → default + warning. */
function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    parseWarnings.push(`${name}: expected an integer between ${min} and ${max}, got "${raw}" — using ${fallback}`);
    return fallback;
  }
  return n;
}

/** Positive number of hours (decimals allowed) → milliseconds. */
function hoursFromEnv(name: string, fallbackHours: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallbackHours * 60 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 365) {
    parseWarnings.push(`${name}: expected a positive number of hours, got "${raw}" — using ${fallbackHours}`);
    return fallbackHours * 60 * 60 * 1000;
  }
  return Math.round(n * 60 * 60 * 1000);
}

/**
 * APP_URL, else the first CLIENT_ORIGIN entry unless it is a loopback address
 * (the dev default); '' when neither names a public address.
 */
function publicUrlFromEnv(): string {
  const appUrl = (process.env.APP_URL || '').trim();
  if (appUrl) return appUrl.replace(/\/+$/, '');
  const first = (process.env.CLIENT_ORIGIN || '').split(',')[0].trim();
  try {
    const host = new URL(first).hostname;
    if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host)) return '';
  } catch {
    return '';
  }
  return first.replace(/\/+$/, '');
}

function listFromEnv(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** "https://app.example.com/" → "https://app.example.com" (unparseable values kept as-is). */
function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

/** Same default as Obliance utils/clientIp.ts: the client container's nginx
 *  and a reverse proxy running in Docker on the same host. */
export const DEFAULT_TRUSTED_PROXIES = 'loopback, self, 172.16.0.0/12';

function keyIdFromEnv(): string {
  const raw = process.env.DATA_ENCRYPTION_KEY_ID;
  if (raw === undefined || raw.trim() === '') return 'k1';
  // Stored next to every ciphertext (key_id column, and inside the
  // "enc:v1:<keyId>:…" string format, where ':' is the separator).
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(raw.trim())) {
    parseWarnings.push(`DATA_ENCRYPTION_KEY_ID: expected 1-32 characters [A-Za-z0-9._-], got "${raw}" — using "k1"`);
    return 'k1';
  }
  return raw.trim();
}

/**
 * DATA_ENCRYPTION_KEY → the 32-byte AES-256 key, or null when missing or not
 * the base64 (or base64url) encoding of exactly 32 bytes. Generate one with
 * `openssl rand -base64 32`. Used by utils/secretBox.ts.
 */
export function parseDataEncryptionKey(raw: string | undefined | null): Buffer | null {
  const s = (raw ?? '').trim();
  if (!s || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return buf.length === 32 ? buf : null;
}

const sessionMaxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

export const config = {
  port: parseInt(process.env.PORT || '3002', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgres://oblimap:changeme@localhost:5432/oblimap',

  // Session
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  sessionMaxAge,
  // Own cookie name so Obli* apps sharing a hostname do not overwrite each
  // other's session cookie (they all defaulted to connect.sid).
  sessionCookieName: process.env.SESSION_COOKIE_NAME || 'oblimap.sid',
  // A session unused for this long is dropped by sessionUserGuard…
  sessionIdleTimeoutMs: hoursFromEnv('SESSION_IDLE_TIMEOUT_HOURS', 12),
  // …and none outlives this, however active (loginAt, checked by sessionUserGuard).
  sessionAbsoluteMaxMs: sessionMaxAge,

  // CORS
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5174',
  // CLIENT_ORIGIN may list several origins (comma-separated): CORS, the socket
  // handshake and the CSRF origin check accept each of them.
  clientOrigins: listFromEnv(process.env.CLIENT_ORIGIN || 'http://localhost:5174').map(normalizeOrigin),

  // HTTPS — set to "true" if behind an HTTPS reverse proxy
  forceHttps: process.env.FORCE_HTTPS === 'true',

  // Reverse proxies — same semantics and defaults as utils/clientIp.ts
  // (TRUSTED_PROXIES: IPs, CIDRs or the keywords loopback / linklocal /
  // uniquelocal / self; TRUSTED_PROXY_HOPS: how many X-Forwarded-For entries
  // trusted proxies may add). They resolve the client address for audit and
  // display only. Rate-limit keys use req.ip with `trust proxy` 1 (the address
  // the client container's nginx saw), which a client cannot forge — do NOT
  // feed trustedProxyHops to Express `trust proxy`.
  trustedProxies: listFromEnv(process.env.TRUSTED_PROXIES || DEFAULT_TRUSTED_PROXIES),
  trustedProxyHops: intFromEnv('TRUSTED_PROXY_HOPS', 2, 1, 10),

  // Encryption at rest of stored secrets (utils/secretBox.ts): base64 of 32
  // random bytes. Without it, features that store secrets fail closed.
  dataEncryptionKey: process.env.DATA_ENCRYPTION_KEY || '',
  dataEncryptionKeyId: keyIdFromEnv(),
  // Allow sending stored credentials to probes over plain HTTP (not recommended).
  allowPlaintextProbeSecrets: process.env.ALLOW_PLAINTEXT_PROBE_SECRETS === 'true',

  // App name (used as prefix in SMS/push notifications)
  appName: process.env.APP_NAME || 'Oblimap',

  // Default admin
  defaultAdminUsername: process.env.DEFAULT_ADMIN_USERNAME || 'admin',
  defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || 'admin123',

  // 2FA bypass — set DISABLE_2FA_FORCE=true to skip forced 2FA requirement
  disable2faForce: process.env.DISABLE_2FA_FORCE === 'true',

  // Public address of this instance (password-reset links, probe installers,
  // allowed origins): APP_URL, else CLIENT_ORIGIN — every Obli* deployment
  // already sets CLIENT_ORIGIN to its public URL (nginx serves the client and
  // proxies the API on the same origin). Same rule as Obliance publicUrl.
  appUrl: publicUrlFromEnv() || 'http://localhost:5174',
  /** True when appUrl comes from the operator (APP_URL or a non-loopback CLIENT_ORIGIN), not the dev default. */
  publicUrlConfigured: publicUrlFromEnv() !== '',
};

const KNOWN_DEFAULT_SECRETS = ['dev-secret-change-me', 'change-this-in-production', 'dev-secret', 'changeme'];

/**
 * Checks the configuration for insecure-but-working values and returns one
 * human-readable warning per problem (empty array = nothing to report).
 *
 * It never throws and never exits: existing deployments must keep starting.
 * The caller (app.ts) logs every returned line loudly. Environment parsing
 * problems are reported in every mode; the security checks only in production.
 */
export function assertProductionConfig(): string[] {
  const warnings = [...parseWarnings];
  if (config.nodeEnv !== 'production') return warnings;

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    warnings.push('SECURITY: SESSION_SECRET is not set — sessions are signed with a public default secret. Set a random value of at least 32 characters (openssl rand -hex 32).');
  } else if (KNOWN_DEFAULT_SECRETS.includes(secret)) {
    warnings.push('SECURITY: SESSION_SECRET is a published default value — anyone can forge session cookies. Set a random value of at least 32 characters (openssl rand -hex 32).');
  } else if (secret.length < 32) {
    warnings.push('SECURITY: SESSION_SECRET is shorter than 32 characters. Set a random value of at least 32 characters (openssl rand -hex 32).');
  }

  if (config.databaseUrl.includes(':changeme@')) {
    warnings.push('SECURITY: DATABASE_URL uses the default database password "changeme". Change the PostgreSQL password and DATABASE_URL.');
  }

  if (config.defaultAdminPassword === 'admin123' && process.env.ALLOW_DEFAULT_ADMIN_PASSWORD !== 'true') {
    warnings.push('SECURITY: DEFAULT_ADMIN_PASSWORD is the default "admin123". It is only used to bootstrap an empty database: set a strong DEFAULT_ADMIN_PASSWORD (or ALLOW_DEFAULT_ADMIN_PASSWORD=true to silence this warning).');
  }

  if (!config.publicUrlConfigured) {
    warnings.push(`Neither APP_URL nor a public CLIENT_ORIGIN is set — links in e-mails (password reset…) point to ${config.appUrl} and probe installers use the request Host. Set CLIENT_ORIGIN to the public https:// address of Oblimap.`);
  } else if (!/^https:\/\//i.test(config.appUrl)) {
    warnings.push(`The public URL (${config.appUrl}, from ${process.env.APP_URL ? 'APP_URL' : 'CLIENT_ORIGIN'}) is not https:// — links in e-mails and probe traffic are not protected by TLS.`);
  }

  if (!config.dataEncryptionKey) {
    warnings.push('DATA_ENCRYPTION_KEY is not set — secrets cannot be encrypted at rest; features that store credentials are disabled. Set it to the base64 of 32 random bytes (openssl rand -base64 32) and keep a backup of it.');
  } else if (!parseDataEncryptionKey(config.dataEncryptionKey)) {
    warnings.push('DATA_ENCRYPTION_KEY is invalid — expected the base64 of exactly 32 bytes (openssl rand -base64 32). Encryption of stored secrets is disabled.');
  }

  return warnings;
}
