import { db } from '../db';
import { DEVICE_CHECK_LIMITS } from '@oblimap/shared';
import type { AppConfig, ObligateConfig } from '@oblimap/shared';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { safeEqualSecret } from '../utils/safeCompare';
import { sha256Hex } from '../utils/timingSafe';

// The Obliview-era 'agent_global_config' row may still exist in app_config:
// nothing reads it any more (the "Agent defaults" section was removed).
const OBLIGATE_CONFIG_KEY     = 'obligate_config';
const OBLIGATE_ENABLED_KEY    = 'obligate_enabled';
/** Advisory lock key serializing the Obligate admin patches (patchObligateConfig). */
const OBLIGATE_PATCH_LOCK     = 'oblimap:app-config:obligate';

// ── Obligate settings ──────────────────────────────────────────────────────
// Same model and names as Obliance, so Obligate admins configure every Obli*
// app the same way.
//   - The browser-facing /authorize URL always names this app by its public
//     client id, sha256(API key) (obligatePublicClientId): Obligate refuses
//     the raw API key there. The former client id form setting is gone: a
//     `clientIdMode` / `clientId` an earlier version stored is ignored (and
//     dropped at the next save), env OBLIGATE_CLIENT_ID_MODE is ignored.
//   - inboundSecret (optional): a secret distinct from the API key that
//     Obligate must present (Bearer) on its calls to this server. Env
//     OBLIGATE_INBOUND_SECRET wins over the setting; unset → the API key is
//     expected (today's behaviour). Write-only: never returned to a client.
// Outbound calls to Obligate always use the API key.

/** app_config.obligate_config as stored, without the environment overrides. */
interface ObligateStored {
  url: string | null;
  apiKey: string | null;
  inboundSecret: string | null;
}

/** Effective Obligate settings (environment overrides applied). Server side only. */
export interface ObligateRawConfig {
  url: string | null;
  /**
   * The app's Obligate API key: outbound Bearer (this server → Obligate) and,
   * unless an inbound secret is set, the secret Obligate presents on its calls
   * to this server. Never sent to a client.
   */
  apiKey: string | null;
  /** Distinct secret expected from Obligate (Bearer), or null. Never sent to a client. */
  inboundSecret: string | null;
}

/** Obligate settings of an ENABLED and configured (URL + API key) gateway. */
export interface ObligateActiveConfig {
  url: string;
  apiKey: string;
  inboundSecret: string | null;
}

/** Admin UI view: flags only, never a secret. */
export type ObligateAdminConfig = ObligateConfig;

/** Fields of an admin PUT /admin/config/obligate (absent = unchanged). */
export interface ObligateConfigPatch {
  url?: string | null;
  /** A non-empty string replaces the key; null / '' keep it. */
  apiKey?: string | null;
  enabled?: boolean;
  /** A non-empty string sets it, null clears it (the API key is expected again). */
  inboundSecret?: string | null;
}

/** Names of the Obligate settings a patch changed (audit: names only, never values). */
export type ObligateConfigField = 'url' | 'apiKey' | 'enabled' | 'inboundSecret';

/**
 * True when `secret` is the API key or its public client id (sha256 hex of
 * the key, obligatePublicClientId; compared case-insensitively). The client
 * id is public (it is in every /authorize redirect) and the key may have
 * leaked through the redirects of earlier versions that sent it as client_id,
 * so neither may serve as the inbound secret. Constant-time compares.
 */
export function isObligateKeyDerived(secret: string | null | undefined, apiKey: string | null | undefined): boolean {
  if (!secret || !apiKey) return false;
  return safeEqualSecret(secret, apiKey) || safeEqualSecret(secret.toLowerCase(), sha256Hex(apiKey));
}

// One warning per process for each setting that can't be used as is.
let envInboundSecretWarned = false;
let keyDerivedInboundSecretWarned = false;

function envInboundSecret(): string | null {
  const v = process.env.OBLIGATE_INBOUND_SECRET?.trim();
  if (!v) return null;
  if (v.length < 32 && !envInboundSecretWarned) {
    envInboundSecretWarned = true;
    logger.warn('OBLIGATE_INBOUND_SECRET is shorter than 32 characters — use a long random value (openssl rand -hex 32)');
  }
  return v;
}

/**
 * Stored settings. Only url / apiKey / inboundSecret are read: the
 * `clientIdMode` or free-form `clientId` an earlier version stored is ignored
 * (the client_id is always sha256(apiKey), obligatePublicClientId) and dropped
 * at the next save.
 */
function parseObligateStored(raw: string | null): ObligateStored {
  const empty: ObligateStored = { url: null, apiKey: null, inboundSecret: null };
  if (!raw) return empty;
  try {
    const cfg = (JSON.parse(raw) ?? {}) as { url?: unknown; apiKey?: unknown; inboundSecret?: unknown };
    const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
    return { url: str(cfg.url), apiKey: str(cfg.apiKey), inboundSecret: str(cfg.inboundSecret) };
  } catch { return empty; }
}

function obligateEffective(s: ObligateStored): ObligateRawConfig {
  const envSecret = envInboundSecret();
  const inboundSecret = envSecret ?? s.inboundSecret;
  // The admin PUT refuses such a pair, but OBLIGATE_INBOUND_SECRET is never
  // checked against the stored key there: say it loudly (it stays in force,
  // a bad value must not break SSO or startup).
  if (!keyDerivedInboundSecretWarned && isObligateKeyDerived(inboundSecret, s.apiKey)) {
    keyDerivedInboundSecretWarned = true;
    logger.warn(
      `Obligate SSO: the inbound secret (${envSecret ? 'OBLIGATE_INBOUND_SECRET' : 'Settings > Obligate'}) is the API key `
      + 'or its public client id, which can both be public — it protects nothing. Set a distinct long random value '
      + '(openssl rand -hex 32) here and in Obligate.',
    );
  }
  return {
    url: s.url,
    apiKey: s.apiKey,
    inboundSecret,
  };
}

/** What the admin UI may see: flags only, never a secret. */
function obligatePublicView(s: ObligateStored, enabled: boolean): ObligateAdminConfig {
  const envSecret = envInboundSecret();
  return {
    url: s.url,
    apiKeySet: !!s.apiKey,
    enabled,
    inboundSecretSet: !!(envSecret ?? s.inboundSecret),
    inboundSecretFromEnv: !!envSecret,
  };
}

// getObligateRawIfEnabled() is read by every Obligate route (and the SSO
// guards): cached 10 s. Writing obligate_config / obligate_enabled through
// set() drops the cache at once; the generation counter keeps a read that
// started before such a write from caching the old value.
const OBLIGATE_ACTIVE_TTL_MS = 10_000;
let obligateActiveCache: { at: number; value: ObligateActiveConfig | null } | null = null;
let obligateCacheGeneration = 0;

function invalidateObligateCache(): void {
  obligateActiveCache = null;
  obligateCacheGeneration++;
}

// ── Device Checks platform policy (app_config device_checks_policy) ─────────
// Platform-wide limits of the Device Checks engine, set by a
// platform admin. Rule validation checks every variant port against
// allowedPorts; config builds cap the targets per probe and raise intervals
// below minIntervalSeconds; the sweeper applies the retention days.

export interface DeviceChecksPolicy {
  allowedPorts: number[];
  maxTargetsPerProbe: number;
  minIntervalSeconds: number;
  eventRetentionDays: number;
  valueEventRetentionDays: number;
}

export const DEFAULT_DEVICE_CHECKS_POLICY: Readonly<DeviceChecksPolicy> = Object.freeze({
  allowedPorts: [80, 443, 8000, 8080, 8081, 8443],
  maxTargetsPerProbe: 50,
  minIntervalSeconds: 30,
  eventRetentionDays: 90,
  valueEventRetentionDays: 7,
});

const DEVICE_CHECKS_POLICY_KEY = 'device_checks_policy';
const DEVICE_CHECKS_POLICY_TTL_MS = 60_000;
let deviceChecksPolicyCache: { at: number; value: DeviceChecksPolicy } | null = null;

function intIn(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

/** Stored JSON (or a patch merged over it) → a policy within the hard limits; bad fields fall back to the defaults. */
function sanitizeDeviceChecksPolicy(raw: unknown): DeviceChecksPolicy {
  const d = DEFAULT_DEVICE_CHECKS_POLICY;
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const ports = Array.isArray(p.allowedPorts)
    ? [...new Set(p.allowedPorts.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 65535))].slice(0, 32)
    : [];
  return {
    allowedPorts: ports.length > 0 ? ports : [...d.allowedPorts],
    maxTargetsPerProbe: intIn(p.maxTargetsPerProbe, 1, DEVICE_CHECK_LIMITS.maxTargetsPerProbe, d.maxTargetsPerProbe),
    minIntervalSeconds: intIn(p.minIntervalSeconds, DEVICE_CHECK_LIMITS.minIntervalSeconds, DEVICE_CHECK_LIMITS.maxIntervalSeconds, d.minIntervalSeconds),
    eventRetentionDays: intIn(p.eventRetentionDays, 1, 3650, d.eventRetentionDays),
    valueEventRetentionDays: intIn(p.valueEventRetentionDays, 1, 365, d.valueEventRetentionDays),
  };
}

function clonePolicy(p: DeviceChecksPolicy): DeviceChecksPolicy {
  return { ...p, allowedPorts: [...p.allowedPorts] };
}

export const appConfigService = {
  async get(key: string): Promise<string | null> {
    const row = await db('app_config').where({ key }).first('value');
    return row?.value ?? null;
  },

  async set(key: string, value: string): Promise<void> {
    await db('app_config')
      .insert({ key, value })
      .onConflict('key')
      .merge({ value });
    if (key === OBLIGATE_CONFIG_KEY || key === OBLIGATE_ENABLED_KEY) invalidateObligateCache();
  },

  async getAll(): Promise<AppConfig> {
    const rows = await db('app_config').select('key', 'value');
    const map = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));

    /** Extract only the URL from a JSON config blob (never expose apiKey) */
    const parseUrl = (key: string): string | null => {
      if (!map[key]) return null;
      try { return (JSON.parse(map[key]) as { url?: string }).url || null; } catch { return null; }
    };

    return {
      allow_2fa: map['allow_2fa'] === 'true',
      force_2fa: map['force_2fa'] === 'true',
      otp_smtp_server_id: map['otp_smtp_server_id'] ? parseInt(map['otp_smtp_server_id'], 10) : null,
      obligateUrl:     parseUrl(OBLIGATE_CONFIG_KEY),
      obligateEnabled: map['obligate_enabled'] === 'true',
    };
  },

  // ── Obligate SSO gateway ───────────────────────────────────────────────

  /** Admin UI view of the Obligate settings (never returns the API key or the inbound secret). */
  async getObligateConfig(): Promise<ObligateAdminConfig> {
    const stored = parseObligateStored(await this.get(OBLIGATE_CONFIG_KEY));
    const enabled = await this.get(OBLIGATE_ENABLED_KEY);
    return obligatePublicView(stored, enabled === 'true');
  },

  /**
   * Effective Obligate settings (environment overrides applied), whether or
   * not SSO is enabled: for the admin settings and the calls that do not
   * depend on the flag. Anything that signs a user in or answers Obligate
   * uses getObligateRawIfEnabled().
   */
  async getObligateRaw(): Promise<ObligateRawConfig> {
    return obligateEffective(parseObligateStored(await this.get(OBLIGATE_CONFIG_KEY)));
  },

  /**
   * The Obligate settings when SSO is enabled (obligate_enabled = 'true') AND
   * configured (URL + API key); null otherwise. Cached 10 s.
   */
  async getObligateRawIfEnabled(): Promise<ObligateActiveConfig | null> {
    const now = Date.now();
    const hit = obligateActiveCache;
    if (hit && now - hit.at < OBLIGATE_ACTIVE_TTL_MS) return hit.value ? { ...hit.value } : null;

    const generation = obligateCacheGeneration;
    const [raw, enabled] = await Promise.all([this.getObligateRaw(), this.get(OBLIGATE_ENABLED_KEY)]);
    const value: ObligateActiveConfig | null = enabled === 'true' && raw.url && raw.apiKey
      ? { url: raw.url, apiKey: raw.apiKey, inboundSecret: raw.inboundSecret }
      : null;
    if (generation === obligateCacheGeneration) obligateActiveCache = { at: now, value };
    return value ? { ...value } : null;
  },

  /**
   * Applies an admin patch (format validated by the controller) to the stored
   * settings. Returns the admin view and the names of the settings that
   * changed (for the audit trail: never their values).
   *
   * Each patch reads, merges and rewrites the whole obligate_config JSON (and
   * obligate_enabled): patches run one at a time, in a transaction holding an
   * advisory lock (it works even before the row exists), so two close admin
   * PUTs cannot lose one of the updates nor audit a change that was lost.
   * The API key / inbound secret distinctness is checked under the same lock.
   */
  async patchObligateConfig(patch: ObligateConfigPatch): Promise<{ config: ObligateAdminConfig; changed: ObligateConfigField[] }> {
    const result = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [OBLIGATE_PATCH_LOCK]);
      const read = async (key: string): Promise<string | null> =>
        ((await trx('app_config').where({ key }).first('value')) as { value: string } | undefined)?.value ?? null;
      const write = (key: string, value: string) =>
        trx('app_config').insert({ key, value }).onConflict('key').merge({ value });

      const existing = parseObligateStored(await read(OBLIGATE_CONFIG_KEY));
      const merged: ObligateStored = {
        url: 'url' in patch ? (patch.url ?? null) : existing.url,
        apiKey: ('apiKey' in patch && patch.apiKey) ? patch.apiKey : existing.apiKey,
        // a non-empty string sets it, null clears it, absent keeps it
        inboundSecret: 'inboundSecret' in patch
          ? (typeof patch.inboundSecret === 'string' && patch.inboundSecret ? patch.inboundSecret : null)
          : existing.inboundSecret,
      };

      // The inbound secret exists to differ from the API key (which may have
      // leaked through the redirects of earlier versions that sent it as
      // client_id) and from its public client id (in every /authorize
      // redirect): refuse a new key or secret that makes them equal, for the
      // stored secret and for OBLIGATE_INBOUND_SECRET alike.
      if (patch.apiKey || patch.inboundSecret) {
        for (const secret of [merged.inboundSecret, envInboundSecret()]) {
          if (isObligateKeyDerived(secret, merged.apiKey)) {
            throw new AppError(400, 'The inbound secret must differ from the API key and its public client id');
          }
        }
      }

      const changed: ObligateConfigField[] = [];
      if (merged.url !== existing.url) changed.push('url');
      if (merged.apiKey !== existing.apiKey) changed.push('apiKey');
      if (merged.inboundSecret !== existing.inboundSecret) changed.push('inboundSecret');

      // Only the current fields are written: a legacy `clientIdMode` /
      // `clientId` (ignored by parseObligateStored) is dropped here.
      const toStore: Record<string, unknown> = { url: merged.url, apiKey: merged.apiKey };
      if (merged.inboundSecret) toStore.inboundSecret = merged.inboundSecret;
      await write(OBLIGATE_CONFIG_KEY, JSON.stringify(toStore));

      let enabled = (await read(OBLIGATE_ENABLED_KEY)) === 'true';
      if ('enabled' in patch) {
        const next = !!patch.enabled;
        if (next !== enabled) changed.push('enabled');
        await write(OBLIGATE_ENABLED_KEY, next ? 'true' : 'false');
        enabled = next;
      }
      return { merged, enabled, changed };
    });
    // After the commit: a read that started before it cannot cache the old value.
    invalidateObligateCache();
    return { config: obligatePublicView(result.merged, result.enabled), changed: result.changed };
  },

  // ── Device Checks platform policy ──────────────────────────────────────

  /** The Device Checks platform policy (defaults for unset fields). Cached 60 s. */
  async getDeviceChecksPolicy(): Promise<DeviceChecksPolicy> {
    const now = Date.now();
    const hit = deviceChecksPolicyCache;
    if (hit && now - hit.at < DEVICE_CHECKS_POLICY_TTL_MS) return clonePolicy(hit.value);
    const raw = await this.get(DEVICE_CHECKS_POLICY_KEY);
    let parsed: unknown = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
    }
    const value = sanitizeDeviceChecksPolicy(parsed);
    deviceChecksPolicyCache = { at: now, value };
    return clonePolicy(value);
  },

  /**
   * Merges `patch` (validated by the route: deviceChecksPolicySchema) over the
   * current policy, stores it and returns the result.
   */
  async setDeviceChecksPolicy(patch: Partial<DeviceChecksPolicy>): Promise<DeviceChecksPolicy> {
    deviceChecksPolicyCache = null;
    const current = await this.getDeviceChecksPolicy();
    const value = sanitizeDeviceChecksPolicy({ ...current, ...patch });
    await this.set(DEVICE_CHECKS_POLICY_KEY, JSON.stringify(value));
    deviceChecksPolicyCache = { at: Date.now(), value };
    return clonePolicy(value);
  },
};
