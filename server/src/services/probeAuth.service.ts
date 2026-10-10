import crypto from 'crypto';
import type { Probe } from '@oblimap/shared';
import { db } from '../db';
import { logger } from '../utils/logger';
import { liveAlertService } from './liveAlert.service';
import { auditService } from './audit.service';

// Probe authentication — the single check used by the HTTP push, the probe
// WebSocket upgrade, the tunnel data WebSocket and check-results.
//
// Identity = tenant API key + probe UUID, plus two protections:
//   1. Key binding: a probe is bound to the key it registered with
//      (probes.api_key_id). Another key of the same tenant presenting that
//      UUID is refused (it used to silently re-bind the probe). It re-binds
//      only when the bound key was deleted (api_key_id NULL, FK SET NULL).
//   2. Per-probe identity token, trust-on-first-use and backward compatible:
//      a probe row without token_hash keeps being accepted with key + UUID
//      (every probe deployed before this feature); a token is issued only to
//      a probe advertising the `token` feature (X-Probe-Features); once the
//      row holds a token hash, the token is required. resetProbeToken lets an
//      admin re-arm a reinstalled probe (the next contact gets a new token).
//
//      The hash reaches token_hash only once the probe has PRESENTED the
//      token it was sent (X-Probe-Token), or acknowledged storing it on the
//      control WS (confirmIssuedProbeToken). Until then it is pending: in
//      memory (the last few issued) and in probes.token_pending_hash (the
//      last one, so a server restart does not discard it). A token lost in
//      transit (response dropped, WS closed right after the probe_token
//      message) therefore never locks a probe out: it is still accepted with
//      key + UUID and simply gets a new one.

export const PROBE_TOKEN_FEATURE = 'token';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Raw `probes` row as returned by knex (snake_case). */
export interface ProbeRow {
  id: number;
  uuid: string;
  hostname: string;
  ip: string | null;
  mac?: string | null;
  ips?: unknown;
  os_info: unknown;
  probe_version: string | null;
  api_key_id: number | null;
  status: Probe['status'];
  tenant_id: number;
  site_id: number | null;
  name: string | null;
  scan_interval_seconds: number;
  scan_config: unknown;
  scan_config_override?: boolean;
  is_primary?: boolean;
  last_seen_at: Date | null;
  pending_command: string | null;
  uninstall_commanded_at: Date | null;
  updating_since: Date | null;
  approved_by: number | null;
  approved_at: Date | null;
  token_hash?: string | null;
  token_issued_at?: Date | null;
  token_pending_hash?: string | null;
  token_pending_at?: Date | string | null;
  created_at: Date;
  updated_at: Date;
  [column: string]: unknown;
}

export interface ProbeApiKeyRef {
  id: number;
  tenant_id: number;
}

export type ProbeAuthFailureCode =
  | 'invalid_key'
  | 'invalid_uuid'
  | 'key_mismatch'
  | 'probe_token_invalid'
  | 'probe_refused'
  | 'probe_not_approved'
  | 'uuid_conflict'
  | 'probe_not_registered';

export type ProbeAuthResult =
  | { ok: true; apiKey: ProbeApiKeyRef; probe: ProbeRow | null; shouldIssueToken: boolean }
  | { ok: false; status: 401 | 403 | 404 | 409; code: ProbeAuthFailureCode };

export interface ProbeAuthOptions {
  apiKey?: string;
  probeUuid?: string;
  probeToken?: string;
  /** X-Probe-Features header: comma-separated capability list. */
  features?: string;
  /** Refuse a probe whose status is not 'approved' (409 probe_not_approved). */
  requireApproved?: boolean;
  /** A UUID with no probe row in the key's tenant is accepted (probe: null) — registration path. */
  allowUnknownProbe?: boolean;
  /** Client IP, for the audit log. */
  ip?: string | null;
  /**
   * Identity v2: when no probe row has this UUID in the key's tenant, look
   * it up in probe_uuid_aliases (a probe that was re-keyed to the shared
   * Obli* device ID, with requests still in flight under its previous UUID).
   * Same tenant, rows bound to another key ignored, most recent alias wins;
   * every check below (status, key binding, identity token) then applies to
   * the row found. `true` for every endpoint except the push; the push
   * passes `{ onlyUuid: <X-Obli-Device-Id> }` (a lost ack replayed) or
   * nothing — it never falls back to an alias otherwise: a v1 push under a
   * migrated UUID comes from another machine and registers its own row.
   */
  aliasFallback?: boolean | { onlyUuid: string };
  /**
   * Do not raise the "identity token rejected" live alert / audit entry: the
   * caller retries under another UUID and reports the refusal itself when
   * that fails too (see handlePush, identity v2 first install).
   */
  quietTokenFailure?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * probe_api_keys.key is a uuid column. Canonicalise the spellings Postgres
 * accepted when the key was compared directly (braces, missing hyphens,
 * upper case) so no deployed probe config stops matching; anything else can
 * never match (and would make Postgres raise instead of returning no row).
 */
function canonicalKey(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const hex = value.trim().replace(/^\{|\}$/g, '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time check of a presented token against a stored sha256 hex hash. */
function tokenMatches(presented: string | undefined, storedHash: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 256) return false;
  const a = Buffer.from(sha256Hex(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== 32 || b.length !== 32) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Parses an X-Probe-Features header value ("token,device_checks:1"). */
export function parseProbeFeatures(features: string | undefined | null): string[] {
  if (typeof features !== 'string' || features.length === 0 || features.length > 1024) return [];
  return features.split(',').map((f) => f.trim()).filter((f) => f.length > 0 && f.length <= 64).slice(0, 32);
}

/** The probe advertises the per-probe identity token feature. */
export function advertisesProbeToken(features: string | undefined | null): boolean {
  return parseProbeFeatures(features).includes(PROBE_TOKEN_FEATURE);
}

// In-memory rate limit for alerts / audit rows / warnings triggered by probe
// auth failures (a misconfigured probe retries every few seconds).
const RATE_WINDOW_MS = 60 * 60 * 1000;
const lastEventAt = new Map<string, number>();

function allowEvent(key: string, windowMs = RATE_WINDOW_MS): boolean {
  const now = Date.now();
  const last = lastEventAt.get(key);
  if (last !== undefined && now - last < windowMs) return false;
  if (lastEventAt.size >= 5_000) {
    for (const [k, at] of lastEventAt) if (now - at >= windowMs) lastEventAt.delete(k);
    if (lastEventAt.size >= 5_000) lastEventAt.clear();
  }
  lastEventAt.set(key, now);
  return true;
}

// last_used_at is written at most once a minute per key.
const LAST_USED_WRITE_MS = 60 * 1000;
function touchApiKey(keyId: number, lastUsedAt: unknown): void {
  const last = lastUsedAt instanceof Date ? lastUsedAt.getTime() : lastUsedAt ? new Date(String(lastUsedAt)).getTime() : 0;
  if (Number.isFinite(last) && Date.now() - last < LAST_USED_WRITE_MS) return;
  db('probe_api_keys')
    .where({ id: keyId })
    .update({ last_used_at: new Date() })
    .catch((err: unknown) => logger.warn({ err: (err as Error)?.message, keyId }, 'probe_api_keys.last_used_at update failed'));
}

// Issued tokens waiting for the probe's first use (sha256 hex). A few per
// probe in memory so concurrent issues (HTTP push + WS hello) cannot strand
// the probe; the last one issued is also kept in probes.token_pending_hash so
// a server restart does not discard it. The stored one lives longer: a probe
// on a long-lived WebSocket presents its token only at its next reconnect.
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_STORED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_PER_PROBE = 3;
const MAX_PENDING_PROBES = 10_000;
const pendingTokens = new Map<number, Array<{ hash: string; at: number }>>();

function addPendingToken(probeId: number, hash: string): void {
  const now = Date.now();
  if (!pendingTokens.has(probeId) && pendingTokens.size >= MAX_PENDING_PROBES) {
    for (const [id, list] of pendingTokens) {
      if (list.every((p) => now - p.at > PENDING_TTL_MS)) pendingTokens.delete(id);
    }
    if (pendingTokens.size >= MAX_PENDING_PROBES) pendingTokens.clear();
  }
  const list = (pendingTokens.get(probeId) ?? []).filter((p) => now - p.at <= PENDING_TTL_MS);
  list.push({ hash, at: now });
  pendingTokens.set(probeId, list.slice(-PENDING_PER_PROBE));
}

function timeMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).getTime();
  return NaN;
}

type PendingSource = { id: number; token_pending_hash?: unknown; token_pending_at?: unknown };

/** The presented token is one issued to this probe and not bound yet: returns its hash. */
function matchPendingToken(probe: PendingSource, presented: string | undefined): string | null {
  const now = Date.now();
  for (const p of pendingTokens.get(probe.id) ?? []) {
    if (now - p.at <= PENDING_TTL_MS && tokenMatches(presented, p.hash)) return p.hash;
  }
  const stored = probe.token_pending_hash;
  const at = timeMs(probe.token_pending_at);
  if (typeof stored === 'string' && /^[0-9a-f]{64}$/.test(stored)
    && Number.isFinite(at) && now - at <= PENDING_STORED_TTL_MS && tokenMatches(presented, stored)) {
    return stored;
  }
  return null;
}

/**
 * Binds a pending token: from now on the probe must present it. Returns the
 * bind time, or null when a concurrent request bound a token first (the
 * caller re-checks against the stored hash).
 */
async function bindPendingToken(
  probe: { id: number; tenant_id: number; uuid: string },
  hash: string,
  ip: string | null,
  via: 'presented' | 'acknowledged',
): Promise<Date | null> {
  const now = new Date();
  const bound = await db('probes')
    .where({ id: probe.id })
    .whereNull('token_hash')
    .update({ token_hash: hash, token_issued_at: now, token_pending_hash: null, token_pending_at: null, updated_at: now });
  if (!bound) return null;
  pendingTokens.delete(probe.id);
  logger.info({ probeId: probe.id, via }, 'Probe identity token bound (first use)');
  void auditService.log({
    tenantId: probe.tenant_id,
    probeId: probe.id,
    action: 'probe.token_bound',
    resourceType: 'probe',
    resourceId: probe.id,
    details: { uuid: probe.uuid, via },
    ipAddress: ip,
  });
  return now;
}

function probeLabel(probe: ProbeRow): string {
  return String(probe.name || probe.hostname || probe.uuid).slice(0, 100);
}

/**
 * Identity v2: the probe row a previous UUID now points to (see
 * ProbeAuthOptions.aliasFallback). onlyUuid restricts the match to the row
 * currently keyed by that UUID.
 */
async function findProbeByAlias(
  aliasUuid: string,
  apiKey: ProbeApiKeyRef,
  onlyUuid: string | null,
): Promise<ProbeRow | undefined> {
  try {
    const q = db('probe_uuid_aliases as a')
      .join('probes as p', 'p.id', 'a.probe_id')
      .where({ 'a.uuid': aliasUuid, 'a.tenant_id': apiKey.tenant_id, 'p.tenant_id': apiKey.tenant_id })
      .where(function () { this.whereNull('p.api_key_id').orWhere('p.api_key_id', apiKey.id); })
      .orderBy('a.created_at', 'desc')
      .orderBy('a.id', 'desc')
      .select('p.*');
    if (onlyUuid) {
      const only = onlyUuid.trim().toLowerCase();
      if (!UUID_RE.test(only)) return undefined;
      q.where('p.uuid', only);
    }
    return await q.first() as ProbeRow | undefined;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'Probe alias lookup failed');
    return undefined;
  }
}

/**
 * Identity v2: may the request credentials (API key + identity token) act for
 * `probe`, a row other than the one authenticateProbe resolved? Same rules
 * as authenticateProbe, without side effects (no binding, no alert): not
 * refused / suspended, bound to this key (or to none), and the identity
 * token bound to the row — or one issued to it and not bound yet — when the
 * row has one.
 */
export function probeCredentialsMatch(probe: ProbeRow, apiKeyId: number, probeToken: string | undefined): boolean {
  if (probe.status === 'refused' || probe.status === 'suspended') return false;
  if (probe.api_key_id != null && probe.api_key_id !== apiKeyId) return false;
  const storedHash = typeof probe.token_hash === 'string' && probe.token_hash !== '' ? probe.token_hash : null;
  if (storedHash) return tokenMatches(probeToken, storedHash);
  return true;
}

// ── Authentication ───────────────────────────────────────────────────────────

export async function authenticateProbe(o: ProbeAuthOptions): Promise<ProbeAuthResult> {
  const apiKeyValue = canonicalKey(o.apiKey);
  if (!apiKeyValue) return { ok: false, status: 401, code: 'invalid_key' };

  const probeUuid = typeof o.probeUuid === 'string' ? o.probeUuid.trim().toLowerCase() : '';
  if (!UUID_RE.test(probeUuid)) return { ok: false, status: 401, code: 'invalid_uuid' };

  const keyRow = await db('probe_api_keys')
    .where({ key: apiKeyValue })
    .first('id', 'tenant_id', 'last_used_at') as { id: number; tenant_id: number; last_used_at: unknown } | undefined;
  if (!keyRow) return { ok: false, status: 401, code: 'invalid_key' };

  const apiKey: ProbeApiKeyRef = { id: keyRow.id, tenant_id: keyRow.tenant_id };
  touchApiKey(keyRow.id, keyRow.last_used_at);

  let probe = await db('probes')
    .where({ uuid: probeUuid, tenant_id: apiKey.tenant_id })
    .first() as ProbeRow | undefined;

  if (!probe && o.aliasFallback) {
    const onlyUuid = typeof o.aliasFallback === 'object' ? o.aliasFallback.onlyUuid : null;
    probe = await findProbeByAlias(probeUuid, apiKey, onlyUuid);
  }

  if (!probe) {
    // probes.uuid is globally unique: a row in another tenant can never be
    // registered or used from this tenant.
    const elsewhere = await db('probes').where({ uuid: probeUuid }).first('id');
    if (elsewhere) {
      if (allowEvent(`uuid-conflict:${probeUuid}:${apiKey.tenant_id}`)) {
        logger.warn({ probeUuid, tenantId: apiKey.tenant_id }, 'Probe auth refused: UUID already registered in another tenant');
      }
      return { ok: false, status: 409, code: 'uuid_conflict' };
    }
    if (o.allowUnknownProbe) return { ok: true, apiKey, probe: null, shouldIssueToken: false };
    return { ok: false, status: 404, code: 'probe_not_registered' };
  }

  // Revoked probes: refused before anything is written.
  if (probe.status === 'refused' || probe.status === 'suspended') {
    return { ok: false, status: 403, code: 'probe_refused' };
  }
  if (o.requireApproved && probe.status !== 'approved') {
    return { ok: false, status: 409, code: 'probe_not_approved' };
  }

  // Key binding: another key of the tenant may not act as this probe.
  if (probe.api_key_id != null && probe.api_key_id !== apiKey.id) {
    if (allowEvent(`key-mismatch:${probeUuid}`)) {
      logger.warn({ probeId: probe.id, probeUuid, boundKeyId: probe.api_key_id, presentedKeyId: apiKey.id },
        'Probe auth refused: API key does not match the key the probe is bound to');
      void liveAlertService.add(probe.tenant_id, {
        severity: 'warning',
        stableKey: `probe-key-mismatch:${probeUuid}`,
        title: `Probe API key mismatch: ${probeLabel(probe)}`,
        message: `A connection claiming to be probe "${probeLabel(probe)}" used a different API key than the one this probe is bound to, and was refused. `
          + 'If the probe was moved to a new API key on purpose, delete its previous key: the probe re-binds to the new key on its next contact.',
        navigateTo: `/manage/probes/${probe.id}`,
      }).catch((err: unknown) => logger.warn({ err: (err as Error)?.message }, 'Probe key-mismatch live alert failed'));
      void auditService.log({
        tenantId: probe.tenant_id,
        probeId: probe.id,
        action: 'probe.key_mismatch',
        resourceType: 'probe',
        resourceId: probe.id,
        details: { uuid: probeUuid, boundKeyId: probe.api_key_id, presentedKeyId: apiKey.id },
        ipAddress: o.ip ?? null,
      });
    }
    return { ok: false, status: 401, code: 'key_mismatch' };
  }

  // Identity token: required once the probe holds one.
  let storedHash = typeof probe.token_hash === 'string' && probe.token_hash !== '' ? probe.token_hash : null;
  if (storedHash && !tokenMatches(o.probeToken, storedHash)) {
    if (!o.quietTokenFailure && allowEvent(`token-invalid:${probeUuid}`)) {
      const presented = typeof o.probeToken === 'string' && o.probeToken.length > 0;
      logger.warn({ probeId: probe.id, probeUuid, tokenPresented: presented }, 'Probe auth refused: identity token missing or invalid');
      void liveAlertService.add(probe.tenant_id, {
        severity: 'warning',
        stableKey: `probe-token-invalid:${probeUuid}`,
        title: `Probe identity token rejected: ${probeLabel(probe)}`,
        message: `A connection claiming to be probe "${probeLabel(probe)}" did not present this probe's identity token, and was refused. `
          + 'If the probe was reinstalled on purpose, reset its identity token from the probe page.',
        navigateTo: `/manage/probes/${probe.id}`,
      }).catch((err: unknown) => logger.warn({ err: (err as Error)?.message }, 'Probe token live alert failed'));
      void auditService.log({
        tenantId: probe.tenant_id,
        probeId: probe.id,
        action: 'probe.token_invalid',
        resourceType: 'probe',
        resourceId: probe.id,
        details: { uuid: probeUuid, presented },
        ipAddress: o.ip ?? null,
      });
    }
    return { ok: false, status: 401, code: 'probe_token_invalid' };
  }

  // Bound key was deleted (FK SET NULL): bind to the key now in use.
  if (probe.api_key_id == null) {
    const rebound = await db('probes')
      .where({ id: probe.id })
      .whereNull('api_key_id')
      .update({ api_key_id: apiKey.id, updated_at: new Date() });
    if (rebound) {
      probe.api_key_id = apiKey.id;
      logger.info({ probeId: probe.id, probeUuid, keyId: apiKey.id }, 'Probe re-bound to a new API key (previous key deleted)');
      void auditService.log({
        tenantId: probe.tenant_id,
        probeId: probe.id,
        action: 'probe.key_rebound',
        resourceType: 'probe',
        resourceId: probe.id,
        details: { uuid: probeUuid, keyId: apiKey.id },
        ipAddress: o.ip ?? null,
      });
    } else {
      // Another request bound it concurrently: re-check against the winner.
      const current = await db('probes').where({ id: probe.id }).first('api_key_id') as { api_key_id: number | null } | undefined;
      if (!current || current.api_key_id !== apiKey.id) return { ok: false, status: 401, code: 'key_mismatch' };
      probe.api_key_id = apiKey.id;
    }
  }

  // First use of an issued token: the probe proved it received it — bind it.
  // From now on the token is required.
  if (!storedHash) {
    const pendingHash = matchPendingToken(probe, o.probeToken);
    if (pendingHash) {
      const boundAt = await bindPendingToken(probe, pendingHash, o.ip ?? null, 'presented');
      if (boundAt) {
        probe.token_hash = pendingHash;
        probe.token_issued_at = boundAt;
        probe.token_pending_hash = null;
        probe.token_pending_at = null;
        storedHash = pendingHash;
      } else {
        // Bound concurrently by another request: it must be this very token.
        const current = await db('probes').where({ id: probe.id }).first('token_hash') as { token_hash: string | null } | undefined;
        if (!current?.token_hash || !tokenMatches(o.probeToken, current.token_hash)) {
          return { ok: false, status: 401, code: 'probe_token_invalid' };
        }
        probe.token_hash = current.token_hash;
        storedHash = current.token_hash;
      }
    }
  }

  const shouldIssueToken = !storedHash && advertisesProbeToken(o.features);
  return { ok: true, apiKey, probe, shouldIssueToken };
}

// ── Token lifecycle ──────────────────────────────────────────────────────────

/**
 * Issues an identity token to a probe that has none (call it when
 * authenticateProbe returned shouldIssueToken) and returns the plaintext —
 * the only time it exists outside the probe; the server keeps its sha256
 * only. The hash stays pending (memory + probes.token_pending_hash) and is
 * written to probes.token_hash when the probe first presents the token (see
 * authenticateProbe) or acknowledges storing it (confirmIssuedProbeToken), so
 * a token lost in transit never locks the probe out.
 * Returns null when the probe does not exist or already holds a bound token
 * (a concurrent request bound one first): send nothing then — replacing the
 * probe's token would lock it out.
 */
export async function issueProbeToken(probeId: number): Promise<string | null> {
  if (!Number.isInteger(probeId) || probeId <= 0) return null;
  const row = await db('probes')
    .where({ id: probeId })
    .first('id', 'tenant_id', 'uuid', 'token_hash') as
    { id: number; tenant_id: number; uuid: string; token_hash: string | null } | undefined;
  if (!row || row.token_hash) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const hash = sha256Hex(token);
  // Conditional: a token bound concurrently must never be followed by a new one.
  const stored = await db('probes')
    .where({ id: row.id })
    .whereNull('token_hash')
    .update({ token_pending_hash: hash, token_pending_at: new Date() });
  if (!stored) return null;
  addPendingToken(row.id, hash);
  logger.info({ probeId: row.id }, 'Probe identity token issued');
  void auditService.log({
    tenantId: row.tenant_id,
    probeId: row.id,
    action: 'probe.token_issued',
    resourceType: 'probe',
    resourceId: row.id,
    details: { uuid: row.uuid },
  });
  return token;
}

/**
 * Binds a token the server just sent on an authenticated control WebSocket
 * (probe_token message / config_update.probeToken) once the probe answers
 * {type:'probe_token_ack', persisted:true}: the probe has the token on disk,
 * so there is no need to wait for its next reconnect to present it. `token`
 * is the plaintext this connection sent (the ack never carries it). Call it
 * only for persisted:true — a probe that could not save the token would be
 * locked out after its next restart.
 * Returns true when the probe's bound token is now this one (also when it
 * already was), false otherwise (unknown / other tenant / revoked probe,
 * token not issued to it or superseded, another token already bound).
 */
export async function confirmIssuedProbeToken(
  probeId: number,
  tenantId: number,
  token: string,
  ip: string | null = null,
): Promise<boolean> {
  if (!Number.isInteger(probeId) || probeId <= 0 || !Number.isInteger(tenantId) || tenantId <= 0) return false;
  const row = await db('probes')
    .where({ id: probeId, tenant_id: tenantId })
    .first('id', 'tenant_id', 'uuid', 'status', 'token_hash', 'token_pending_hash', 'token_pending_at') as
    { id: number; tenant_id: number; uuid: string; status: string; token_hash: string | null;
      token_pending_hash: string | null; token_pending_at: Date | string | null } | undefined;
  if (!row) return false;
  if (row.token_hash) return tokenMatches(token, row.token_hash);
  if (row.status === 'refused' || row.status === 'suspended') return false;
  const hash = matchPendingToken(row, token);
  if (!hash) return false;
  if (await bindPendingToken(row, hash, ip, 'acknowledged')) return true;
  // Bound concurrently (e.g. the probe presented it on another connection).
  const current = await db('probes').where({ id: row.id }).first('token_hash') as { token_hash: string | null } | undefined;
  return !!current?.token_hash && tokenMatches(token, current.token_hash);
}

/**
 * Clears a probe's identity token (admin action, e.g. after a reinstall): the
 * probe is accepted with key + UUID again and receives a new token on its
 * next contact. Returns false when the probe is not in that tenant.
 */
export async function resetProbeToken(probeId: number, tenantId: number): Promise<boolean> {
  const updated = await db('probes')
    .where({ id: probeId, tenant_id: tenantId })
    .update({
      token_hash: null,
      token_issued_at: null,
      token_pending_hash: null,
      token_pending_at: null,
      updated_at: new Date(),
    });
  if (Number(updated) > 0) pendingTokens.delete(probeId);
  return Number(updated) > 0;
}
