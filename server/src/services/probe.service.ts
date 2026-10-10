import path from 'path';
import fs from 'fs';
import { Server as SocketIOServer } from 'socket.io';
import type { Knex } from 'knex';
import { db } from '../db';
import { logger } from '../utils/logger';
import { toDbId, validDbIds } from '../utils/dbId';
import { AppError } from '../middleware/errorHandler';
import {
  SOCKET_EVENTS,
  DEVICE_CHECKS_CAPABILITY,
  SETTINGS_DEFAULTS,
  SCAN_INTERVAL_MAX_SECONDS,
  SCAN_INTERVAL_MIN_SECONDS,
  toProbeUpdatePolicy,
} from '@oblimap/shared';
import type {
  ItemAlertMode,
  Probe,
  ProbeApiKey,
  ProbeUpdatePolicy,
  ProbeScanConfig,
  ProbeDeviceChecksConfig,
  ResolvedSettings,
  SettingValue,
  SettingsKey,
} from '@oblimap/shared';
import { liveAlertService } from './liveAlert.service';
import { notificationService } from './notification.service';
import { obligateService } from './obligate.service';
import { settingsService } from './settings.service';
import { auditService } from './audit.service';
import { flowService } from './flow.service';
import { tenantAdminEventRooms } from './tenant.service';
import { createSiteEventBatch, setRealtimeIO, type SiteEventBatch } from './realtime.service';
import {
  buildProbeChecksConfig,
  pushConfigToAffectedProbes,
  secretsTransportAllowed,
} from './deviceChecks/config.service';
import type { ProbeHello } from '../validators/deviceCheck.schema';
import {
  allRandomized,
  classifyByPorts,
  decideIpClaim,
  isLocallyAdministered,
  mayReclassify,
  parseOpenPorts,
  type DeviceTypeSource,
} from './deviceClassification';
import { lookupVendorByMac } from './ouiRegistry.service';
import { maintenanceService } from './maintenance.service';
import { matchVendorRule, type ScopedVendorRuleRow } from './vendorRuleMatch';
import {
  deviceAlertAllowed,
  itemAlertModeOf,
  recordBatch as recordItemEvents,
  type ItemEventInput,
} from './itemEvents.service';
import {
  authenticateProbe,
  advertisesProbeToken,
  issueProbeToken,
  resetProbeToken,
  type ProbeApiKeyRef,
  type ProbeAuthResult,
  type ProbeRow,
} from './probeAuth.service';
import { probeIdentityService, type IdentityClaim } from './probeIdentity.service';
import {
  newTooWideExtraSubnet,
  parseProbePush,
  type ProbePushDevice,
  type ProbePushPayload,
  type ProbeCommand,
  type UpdateProbeInput,
} from '../validators/probe.schema';

export type { ProbePushPayload } from '../validators/probe.schema';

let _io: SocketIOServer | null = null;

export function setProbeServiceIO(io: SocketIOServer): void {
  _io = io;
  // The site-reader fan-out (realtime.service) shares the server's io.
  setRealtimeIO(io);
}

/** Check if a probe is connected via WebSocket (lazy import to avoid circular deps) */
function isProbeWsConnected(probeId: number): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isProbeConnected } = require('./probeHub.service');
    return isProbeConnected(probeId);
  } catch {
    return false;
  }
}

/**
 * Cuts off revoked probes (refused, deleted, API key deleted): closes their
 * control and tunnel WebSockets with 4003 — a reconnect goes through the
 * upgrade checks again. `byKey` also closes every connection authenticated
 * with that key. Returns the number of probes that had something open.
 */
async function closeProbeConnections(
  probeIds: number[],
  byKey?: { apiKeyId: number; tenantId: number },
): Promise<number> {
  try {
    const { disconnectProbe, disconnectApiKey } = await import('./probeHub.service');
    // disconnectApiKey also closes control connections of the key whose probe
    // has not registered yet (getConnectedProbes() does not list those).
    // disconnectProbe returns false for connections it already closed.
    let closed = byKey ? disconnectApiKey(byKey.apiKeyId, byKey.tenantId, 4003, 'revoked') : 0;
    for (const id of new Set(probeIds)) {
      if (disconnectProbe(id, 4003, 'revoked')) closed++;
    }
    return closed;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'Failed to close revoked probe connections');
    return 0;
  }
}

/**
 * Probe-level settings ('monitor' is the historical scope name of the probe
 * level) of deleted probes: no foreign key holds them.
 */
async function deleteProbeSettings(trx: Knex.Transaction, tenantId: number, probeIds: number[]): Promise<void> {
  if (probeIds.length === 0) return;
  await trx('settings')
    .where({ scope: 'monitor', tenant_id: tenantId })
    .whereIn('scope_id', probeIds)
    .delete();
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProbeEffectiveConfig {
  scanIntervalSeconds: number;
  excludedSubnets: string[];
  extraSubnets: string[];
  portScanEnabled: boolean;
  portScanPorts: number[];
  flowAnalysisEnabled: boolean;
  /**
   * The server stores the skippedSubnets of a push. Probes that know the
   * field report the subnets they did not scan only when it is set (older
   * probes ignore unknown fields).
   */
  acceptsSkippedSubnets: true;
  /**
   * Device Checks assignment — only for probes that advertise
   * DEVICE_CHECKS_CAPABILITY (older probes never see the field). A capable
   * probe stops every check when it is absent.
   */
  deviceChecks?: ProbeDeviceChecksConfig;
}

/** config_update answering a probe's WS hello. */
export interface ProbeHelloReply {
  status: string;
  config: ProbeEffectiveConfig;
  latestVersion: string | null;
  command: null;
}

export interface ProbePushResponse {
  status: string;
  config: ProbeEffectiveConfig;
  latestVersion: string | null;
  command: string | null;
  role?: 'primary' | 'secondary';
  /** Identity token issued to this probe — sent once, only when issued. */
  probeToken?: string;
}

/**
 * A rejected push: no config. `config: false` is deliberate. Probes built
 * before the status-code check decode ANY non-401 answer (HTTP body, or WS
 * config_update) as a push response and apply its config, so an answer
 * without one would wipe their cached subnet exclusions and port list;
 * `false` cannot be decoded into their config struct, the decode fails and
 * they keep the configuration they have. Current probes read the status /
 * error code only.
 */
export interface ProbePushFailure {
  httpStatus: 400 | 401 | 403 | 404 | 409;
  status: 'invalid' | 'unauthorized' | 'refused' | 'not_found' | 'conflict';
  error: string;
  detail?: string;
  config: false;
}

/**
 * identityAck (HTTP push only): the shared Obli* device ID the probe row is
 * now keyed by — sent back as the X-Obli-Device-Id-Ack header, never in the body.
 */
export type ProbePushResult = (ProbePushResponse & { httpStatus: 200 | 202; identityAck?: string }) | ProbePushFailure;

/** HTTP push credentials beyond the API key / UUID (the WS path authenticated at upgrade). */
export interface ProbePushHttpAuth {
  /** X-Probe-Token header. */
  probeToken?: string;
  /** X-Probe-Features header. */
  features?: string;
  /** Client IP (audit). */
  ip?: string | null;
  /** Identity v2 headers (X-Obli-Device-Id / X-Obli-Previous-Ids), HTTP push only. */
  identity?: IdentityClaim | null;
}

const FAILURE_STATUS: Record<ProbePushFailure['httpStatus'], ProbePushFailure['status']> = {
  400: 'invalid',
  401: 'unauthorized',
  403: 'refused',
  404: 'not_found',
  409: 'conflict',
};

function pushFailure(httpStatus: ProbePushFailure['httpStatus'], error: string, detail?: string): ProbePushFailure {
  return { httpStatus, status: FAILURE_STATUS[httpStatus], error, ...(detail ? { detail } : {}), config: false };
}

// Registration cap: a leaked key cannot flood the probes table. Large
// roll-outs (hundreds of sites installed before approval) raise it with
// PROBE_MAX_PENDING_PER_KEY (1–100000); beyond it new probes get 409
// pending_limit and simply retry at their next cycle.
const MAX_PENDING_PROBES_PER_KEY = (() => {
  const n = Number.parseInt(process.env.PROBE_MAX_PENDING_PER_KEY ?? '', 10);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 500;
})();
// A probe marked "updating" that pushes its unchanged version this long
// after did not update (download / checksum / version check failed). Above
// the probe's 120 s download timeout plus install and restart: scans keep
// running while a WS-mode probe downloads (cleanupStuckUpdating: 10 min).
const UPDATING_STALE_MS = 5 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rate limit for warnings a misbehaving probe would repeat on every push.
const WARN_WINDOW_MS = 60 * 60 * 1000;
const lastWarnAt = new Map<string, number>();

function warnOnce(key: string): boolean {
  const now = Date.now();
  const last = lastWarnAt.get(key);
  if (last !== undefined && now - last < WARN_WINDOW_MS) return false;
  if (lastWarnAt.size >= 5_000) lastWarnAt.clear();
  lastWarnAt.set(key, now);
  return true;
}

// probes.capabilities / probes.server_scheme come from migration 037, the
// scan telemetry columns (last_scan_at, …, last_push_error_*) from 050, the
// update state (last_update_error, _at, last_update_target) from 058:
// checked once, so a database without them keeps accepting pushes.
interface ProbeOptionalColumns { capabilities: boolean; serverScheme: boolean; scanTelemetry: boolean; updateState: boolean }
let optionalColumns: Promise<ProbeOptionalColumns> | null = null;

function probeOptionalColumns(): Promise<ProbeOptionalColumns> {
  if (!optionalColumns) {
    optionalColumns = Promise.all([
      db.schema.hasColumn('probes', 'capabilities'),
      db.schema.hasColumn('probes', 'server_scheme'),
      db.schema.hasColumn('probes', 'last_push_error_at'),
      db.schema.hasColumn('probes', 'last_update_error'),
    ])
      .then(([capabilities, serverScheme, scanTelemetry, updateState]) => ({ capabilities, serverScheme, scanTelemetry, updateState }))
      .catch((err: unknown) => {
        optionalColumns = null;
        logger.warn({ err: (err as Error)?.message }, 'Could not inspect the probes table columns');
        return { capabilities: false, serverScheme: false, scanTelemetry: false, updateState: false };
      });
  }
  return optionalColumns;
}

// ─── Probe versions and update policy ───────────────────────

/**
 * "x.y.z" → [x, y, z], read like the probe's own isStrictlyNewer (Go
 * fmt.Sscanf "%d.%d.%d": leading numbers, missing parts 0, a leading 'v'
 * tolerated). Null for an empty value.
 */
export function parseProbeVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^v/i, '');
  if (s === '') return null;
  const m = /^(\d{1,9})?(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?/.exec(s);
  const part = (x: string | undefined) => (x ? Number(x) : 0);
  return m ? [part(m[1]), part(m[2]), part(m[3])] : [0, 0, 0];
}

/** < 0 when a is older than b, 0 when equal, > 0 when newer (null versions are oldest). */
export function compareProbeVersions(a: unknown, b: unknown): number {
  const pa = parseProbeVersion(a);
  const pb = parseProbeVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * True when the server ships a strictly newer probe version than the one the
 * probe reported (display, "Update outdated probes"). False when either is
 * unknown, or the server's version could not be read ('0.0.0').
 */
export function isProbeVersionOutdated(probeVersion: unknown, latestVersion: string | null): boolean {
  if (!latestVersion || latestVersion === '0.0.0') return false;
  if (typeof probeVersion !== 'string' || probeVersion.trim() === '') return false;
  return compareProbeVersions(latestVersion, probeVersion) > 0;
}

/**
 * The update policy decision (pure; unit-tested): the server announces its
 * probe version (latestVersion in the push response, the hello reply and
 * config_update) only to approved probes whose policy is 'auto'. Pending,
 * refused and suspended probes, and 'manual' / 'frozen' scopes, get none —
 * the explicit 'update' command still works.
 */
export function shouldAnnounceLatestVersion(status: unknown, policy: ProbeUpdatePolicy): boolean {
  return status === 'approved' && policy === 'auto';
}

/** "Update outdated probes" skips the probes whose scope is frozen. */
export function fleetUpdateAllowed(policy: ProbeUpdatePolicy): boolean {
  return policy !== 'frozen';
}

// probe/VERSION is read at most once a minute for the DTOs (the push path
// reads it through getProbeVersion as before).
const PROBE_VERSION_CACHE_MS = 60_000;
let probeVersionCache: { at: number; version: string } | null = null;

/** The server's current probe version, null when it cannot be read. */
function cachedLatestProbeVersion(): string | null {
  const now = Date.now();
  if (!probeVersionCache || now - probeVersionCache.at > PROBE_VERSION_CACHE_MS) {
    probeVersionCache = { at: now, version: probeService.getProbeVersion().version };
  }
  const v = probeVersionCache.version;
  return v && v !== '0.0.0' ? v : null;
}

export interface ProbeUpdatePolicyResolution {
  policy: ProbeUpdatePolicy;
  source: SettingValue['source'];
  sourceId: number | null;
  sourceName: string | null;
}

/**
 * probeUpdatePolicy of a probe: Global → Group chain → its site (a probe
 * without a site of the tenant: the tenant's global value). Never throws:
 * an unreadable chain counts as 'manual' (nothing announced automatically,
 * explicit updates still work).
 */
async function resolveProbeUpdatePolicy(tenantId: number, siteId: unknown): Promise<ProbeUpdatePolicyResolution> {
  try {
    // resolveForSite answers the global chain for a site outside the tenant (0: none).
    const resolved = await settingsService.resolveForSite(tenantId, toDbId(siteId) ?? 0);
    const v = resolved.probeUpdatePolicy;
    return {
      policy: toProbeUpdatePolicy(v?.value),
      source: v?.source ?? 'default',
      sourceId: v?.sourceId ?? null,
      sourceName: v?.sourceName ?? null,
    };
  } catch (err) {
    if (warnOnce(`update-policy:${tenantId}`)) {
      logger.warn({ err: (err as Error)?.message, tenantId }, 'Probe update policy could not be resolved — no automatic update announced');
    }
    return { policy: 'manual', source: 'default', sourceId: null, sourceName: null };
  }
}

/** Short codes stored for an aborted update (probe-reported, validated). */
const UPDATE_REASON_RE = /^[a-z_]{1,32}$/;
/** Abort reasons that are no failure: the probe already runs that version (or a newer one). */
const HARMLESS_UPDATE_ABORTS = new Set(['same_version', 'not_newer']);
/** Columns reset when a new update starts: the last aborted one is history. */
const UPDATE_ERROR_CLEARED = { last_update_error: null, last_update_error_at: null, last_update_target: null };
const UPDATE_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

function shortCode(value: unknown, re: RegExp): string | null {
  return typeof value === 'string' && re.test(value) ? value : null;
}

// update_aborted audit rows / alerts: at most one per probe and reason per 10 min.
const UPDATE_ABORT_EVENT_MS = 10 * 60 * 1000;
const updateAbortEvents = new Map<string, number>();

function allowUpdateAbortEvent(key: string): boolean {
  const now = Date.now();
  const last = updateAbortEvents.get(key);
  if (last !== undefined && now - last < UPDATE_ABORT_EVENT_MS) return false;
  if (updateAbortEvents.size >= 5_000) updateAbortEvents.clear();
  updateAbortEvents.set(key, now);
  return true;
}

// ─── Paced fleet update ("Update outdated probes") ──────────────────────────

export interface FleetUpdateTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: FleetUpdateTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface FleetQueueState {
  ids: number[];
  perMinute: number;
  /** Send times (ms) of the last minute. */
  sent: number[];
  timer: unknown;
  running: boolean;
}

/**
 * In-memory per-tenant queue of 'update' commands, at most `perMinute` sent
 * in any rolling minute (one every 60 s / perMinute). `send` re-checks each
 * probe at its turn (still outdated, not updating, not frozen…) and returns
 * whether a command was sent; a skipped probe does not use a slot. Enqueuing
 * again for a tenant adds the new ids (no duplicate) and takes the new pace.
 * Lost on a server restart: the admin starts it again (the probes already
 * updated are no longer outdated).
 */
export class FleetUpdateQueue {
  private readonly queues = new Map<number, FleetQueueState>();

  constructor(
    private readonly send: (tenantId: number, probeId: number) => Promise<boolean>,
    private readonly timers: FleetUpdateTimers = REAL_TIMERS,
  ) {}

  enqueue(tenantId: number, ids: number[], perMinute: number): number {
    const pace = Math.min(60, Math.max(1, Math.floor(perMinute)));
    let q = this.queues.get(tenantId);
    if (!q) {
      q = { ids: [], perMinute: pace, sent: [], timer: null, running: false };
      this.queues.set(tenantId, q);
    }
    q.perMinute = pace;
    const known = new Set(q.ids);
    let added = 0;
    for (const id of ids) {
      if (known.has(id)) continue;
      known.add(id);
      q.ids.push(id);
      added++;
    }
    // The pace also holds across a Stop / a finished rollout followed by a
    // new start: the sends of the last minute are kept in the state.
    this.schedule(tenantId, this.nextDelay(q));
    return added;
  }

  /** Probes still waiting for their turn, and the pace (null when idle). */
  status(tenantId: number): { remaining: number; perMinute: number } | null {
    this.prune(tenantId);
    const q = this.queues.get(tenantId);
    return q && q.ids.length > 0 ? { remaining: q.ids.length, perMinute: q.perMinute } : null;
  }

  /** Stops the tenant's rollout; returns how many probes were still waiting. */
  cancel(tenantId: number): number {
    const q = this.queues.get(tenantId);
    if (!q) return 0;
    const remaining = q.ids.length;
    q.ids = [];
    if (q.timer !== null) this.timers.clearTimeout(q.timer);
    q.timer = null;
    // The send history stays until it leaves the rolling minute: a Stop then
    // a new start never sends more than perMinute in any minute.
    this.prune(tenantId);
    return remaining;
  }

  /** Drops an idle tenant state whose sends all left the rolling minute. */
  private prune(tenantId: number): void {
    const q = this.queues.get(tenantId);
    if (!q || q.ids.length > 0 || q.running || q.timer !== null) return;
    const now = this.timers.now();
    q.sent = q.sent.filter((t) => now - t < 60_000);
    if (q.sent.length === 0) this.queues.delete(tenantId);
  }

  /** Wait before the next send: one every 60 s / perMinute, at most perMinute per rolling minute. */
  private nextDelay(q: FleetQueueState): number {
    const now = this.timers.now();
    q.sent = q.sent.filter((t) => now - t < 60_000);
    const spacing = Math.ceil(60_000 / q.perMinute);
    const last = q.sent.length > 0 ? q.sent[q.sent.length - 1] : now - spacing;
    let wait = last + spacing - now;
    // A full minute window waits for its oldest send to leave it.
    if (q.sent.length >= q.perMinute) wait = Math.max(wait, q.sent[0] + 60_000 - now);
    return Math.max(0, wait);
  }

  private schedule(tenantId: number, delayMs: number): void {
    const q = this.queues.get(tenantId);
    if (!q || q.running || q.timer !== null) return;
    q.timer = this.timers.setTimeout(() => {
      q.timer = null;
      void this.tick(tenantId);
    }, Math.max(0, delayMs));
  }

  private async tick(tenantId: number): Promise<void> {
    const q = this.queues.get(tenantId);
    if (!q || q.running) return;
    q.running = true;
    try {
      while (q.ids.length > 0) {
        const now = this.timers.now();
        q.sent = q.sent.filter((t) => now - t < 60_000);
        if (q.sent.length >= q.perMinute) break;
        const id = q.ids.shift()!;
        let sent = false;
        try {
          sent = await this.send(tenantId, id);
        } catch (err) {
          logger.warn({ err: (err as Error)?.message, tenantId, probeId: id }, 'Fleet update: command not sent');
        }
        if (sent) {
          q.sent.push(this.timers.now());
          // One command per 60 s / perMinute: the fleet's downloads are spread.
          if (q.ids.length > 0) break;
        }
      }
    } finally {
      q.running = false;
    }
    if (q.ids.length === 0) {
      this.prune(tenantId);
      return;
    }
    this.schedule(tenantId, this.nextDelay(q));
  }
}

// ─── Row Helpers ─────────────────────────────────────────────────────────────

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function stringList(v: unknown): string[] | null {
  const parsed = parseJson(v);
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null;
}

function scanConfigOf(v: unknown): ProbeScanConfig {
  const parsed = v ? parseJson(v) : null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { excludedSubnets: [], extraSubnets: [] };
  return parsed as ProbeScanConfig;
}

function isoOrNull(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function intOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** probes.skipped_subnets (jsonb) → [{cidr, reason}] (undefined when never reported). */
function skippedSubnetsOf(v: unknown): { cidr: string; reason: string }[] | undefined {
  const parsed = parseJson(v);
  if (!Array.isArray(parsed)) return undefined;
  return parsed
    .filter((e): e is { cidr: string; reason?: unknown } => !!e && typeof e === 'object' && typeof (e as { cidr?: unknown }).cidr === 'string')
    .map((e) => ({ cidr: e.cidr, reason: typeof e.reason === 'string' ? e.reason : 'unknown' }));
}

/**
 * Server verdict on a probe's liveness (pure; unit-tested). For approved
 * probes: online when connected over the WebSocket, or seen at least once
 * and not reported offline by the probe-offline job (which owns the
 * threshold, max(multiplier × interval, grace)). Null for pending / refused
 * / suspended probes, whose liveness is not watched.
 */
export function probeOnlineState(
  row: { status?: unknown; last_seen_at?: unknown; offline_alerted_at?: unknown },
  wsConnected: boolean,
): { online: boolean | null; offlineSince: string | null } {
  if (row.status !== 'approved') return { online: null, offlineSince: null };
  if (wsConnected) return { online: true, offlineSince: null };
  const offlineSince = activeOfflineSince(row);
  return { online: row.last_seen_at != null && offlineSince === null, offlineSince };
}

/**
 * offline_alerted_at as long as it still holds: a probe seen after it
 * (last_seen_at > offline_alerted_at) has recovered, even before the
 * probe-offline job (every 60 s) clears the flag. Null otherwise.
 */
export function activeOfflineSince(row: { last_seen_at?: unknown; offline_alerted_at?: unknown }): string | null {
  const since = isoOrNull(row.offline_alerted_at);
  if (since === null) return null;
  const seen = isoOrNull(row.last_seen_at);
  return seen !== null && Date.parse(seen) > Date.parse(since) ? null : since;
}

/** probeOnlineState of a probes row, with its current WebSocket connection. */
export function probeLiveState(
  row: { id?: unknown; status?: unknown; last_seen_at?: unknown; offline_alerted_at?: unknown },
): { online: boolean | null; offlineSince: string | null } {
  const id = Number(row.id);
  return probeOnlineState(row, row.status === 'approved' && Number.isSafeInteger(id) && isProbeWsConnected(id));
}

function rowToProbe(row: Record<string, unknown>, wsConnected = false): Probe {
  const capabilities = stringList(row.capabilities);
  const scheme = row.server_scheme;
  return {
    ...probeOnlineState(row, wsConnected),
    wsConnected,
    apiKeyName: typeof row.api_key_name === 'string' ? row.api_key_name : null,
    id: row.id as number,
    uuid: row.uuid as string,
    hostname: row.hostname as string,
    ip: (row.ip as string | null) ?? null,
    mac: (row.mac as string | null) ?? null,
    ips: row.ips != null
      ? (typeof row.ips === 'string' ? JSON.parse(row.ips) : row.ips) as string[]
      : null,
    osInfo: row.os_info != null
      ? (typeof row.os_info === 'string' ? JSON.parse(row.os_info) : row.os_info)
      : null,
    probeVersion: (row.probe_version as string | null) ?? null,
    apiKeyId: (row.api_key_id as number | null) ?? null,
    status: row.status as Probe['status'],
    tenantId: row.tenant_id as number,
    siteId: (row.site_id as number | null) ?? null,
    name: (row.name as string | null) ?? null,
    scanIntervalSeconds: (row.scan_interval_seconds as number) ?? 300,
    scanConfig: scanConfigOf(row.scan_config),
    lastSeenAt: row.last_seen_at
      ? (row.last_seen_at as Date).toISOString()
      : null,
    pendingCommand: (row.pending_command as string | null) ?? null,
    uninstallCommandedAt: row.uninstall_commanded_at
      ? (row.uninstall_commanded_at as Date).toISOString()
      : null,
    updatingSince: row.updating_since
      ? (row.updating_since as Date).toISOString()
      : null,
    scanConfigOverride: (row.scan_config_override as boolean | undefined) ?? true,
    isPrimary: (row.is_primary as boolean | undefined) ?? false,
    approvedBy: (row.approved_by as number | null) ?? null,
    approvedAt: row.approved_at
      ? (row.approved_at as Date).toISOString()
      : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    capabilities,
    deviceChecksSupported: capabilities?.includes(DEVICE_CHECKS_CAPABILITY) ?? false,
    serverScheme: scheme === 'http' || scheme === 'https' ? scheme : null,
    // Never the hash itself.
    hasIdentityToken: typeof row.token_hash === 'string' && row.token_hash.length > 0,
    // The server's credential-delivery decision for this probe (device checks).
    checkSecretsDeliverable: secretsTransportAllowed(row),
    // Last scan report and last refused push (migration 050; null before).
    lastScanAt: isoOrNull(row.last_scan_at),
    lastScanDurationMs: intOrNull(row.last_scan_duration_ms),
    lastScanDeviceCount: intOrNull(row.last_scan_device_count),
    ...(stringList(row.last_scanned_subnets) ? { lastScannedSubnets: stringList(row.last_scanned_subnets)! } : {}),
    ...(skippedSubnetsOf(row.skipped_subnets) ? { skippedSubnets: skippedSubnetsOf(row.skipped_subnets)! } : {}),
    lastPushErrorCode: typeof row.last_push_error_code === 'string' ? row.last_push_error_code : null,
    lastPushErrorAt: isoOrNull(row.last_push_error_at),
    // Last aborted update (migration 058; null before) and the version the
    // server ships (display only: the policy decides what is announced).
    lastUpdateError: typeof row.last_update_error === 'string' ? row.last_update_error : null,
    lastUpdateErrorAt: isoOrNull(row.last_update_error_at),
    lastUpdateTarget: typeof row.last_update_target === 'string' ? row.last_update_target : null,
    ...latestVersionFields(row.probe_version),
  };
}

function latestVersionFields(probeVersion: unknown): { latestVersion: string | null; updateAvailable: boolean } {
  const latestVersion = cachedLatestProbeVersion();
  return { latestVersion, updateAvailable: isProbeVersionOutdated(probeVersion, latestVersion) };
}

function rowToApiKey(row: Record<string, unknown>): ProbeApiKey {
  return {
    id: row.id as number,
    name: row.name as string,
    key: row.key as string,
    tenantId: row.tenant_id as number,
    createdBy: (row.created_by as number | null) ?? null,
    lastUsedAt: row.last_used_at
      ? (row.last_used_at as Date).toISOString()
      : null,
    createdAt: (row.created_at as Date).toISOString(),
    defaultSiteId: toDbId(row.default_site_id) ?? null,
    defaultSiteName: typeof row.default_site_name === 'string' ? row.default_site_name : null,
    ...(row.probe_count !== undefined ? { probeCount: Number(row.probe_count) || 0 } : {}),
  };
}

// probe_api_keys.default_site_id comes from migration 045: checked once, so
// the key routes keep working on a database that has not run it yet.
let keyDefaultSiteColumn: Promise<boolean> | null = null;

function hasKeyDefaultSiteColumn(): Promise<boolean> {
  if (!keyDefaultSiteColumn) {
    keyDefaultSiteColumn = db.schema.hasColumn('probe_api_keys', 'default_site_id')
      .then((has) => {
        if (!has) keyDefaultSiteColumn = null; // re-checked once migrated
        return has;
      })
      .catch((err: unknown) => {
        keyDefaultSiteColumn = null;
        logger.warn({ err: (err as Error)?.message }, 'Could not inspect the probe_api_keys columns');
        return false;
      });
  }
  return keyDefaultSiteColumn;
}

/** A list-valued setting (stored as JSON text or already decoded) → array. */
function settingList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string' && value) {
    const parsed = parseJson(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  }
  return [];
}

// ─── Effective scan config ──────────────────────────────────────────────────

/** A scan interval as sent to a probe: SCAN_INTERVAL_MIN..MAX (older rows may hold 30 s). */
export function clampScanInterval(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return SETTINGS_DEFAULTS.scanIntervalSeconds as number;
  return Math.min(SCAN_INTERVAL_MAX_SECONDS, Math.max(SCAN_INTERVAL_MIN_SECONDS, Math.round(n)));
}

/** Keys of the effective config that come from a settings scope or from the probe. */
export const EFFECTIVE_SCAN_KEYS = [
  'scanIntervalSeconds',
  'excludedSubnets',
  'extraSubnets',
  'portScanEnabled',
  'portScanPorts',
  'flowAnalysisEnabled',
] as const satisfies readonly SettingsKey[];

export type EffectiveScanKey = (typeof EFFECTIVE_SCAN_KEYS)[number];

/**
 * Where a value of the effective config comes from: 'probe' = the probe's own
 * scan config (scan_config_override), else the settings scope it is
 * inherited from ('monitor' = a probe-level settings row).
 */
export interface EffectiveConfigSource {
  source: 'probe' | SettingValue['source'];
  sourceId: number | null;
  sourceName: string | null;
}

/** Effective scan config + the source of each value. */
export interface ScanConfigResolution {
  effective: Omit<ProbeEffectiveConfig, 'deviceChecks'>;
  sources: Record<EffectiveScanKey, EffectiveConfigSource>;
}

const FALLBACK_SOURCE: EffectiveConfigSource = { source: 'default', sourceId: null, sourceName: 'Default' };

function sourceOf(v: SettingValue | undefined): EffectiveConfigSource {
  return v ? { source: v.source, sourceId: v.sourceId ?? null, sourceName: v.sourceName ?? null } : FALLBACK_SOURCE;
}

/**
 * The scan part of a probe's effective config (pure; unit-tested). With
 * scan_config_override the probe's own interval / scan_config are used
 * (source 'probe'); otherwise the settings chain resolved for the probe
 * (`resolved`: resolveForProbe). flowAnalysisEnabled always comes from the
 * site chain (`flow`: resolveForSite's value, null without a site → off).
 * The interval is clamped to SCAN_INTERVAL_MIN..MAX either way.
 */
export function computeScanConfig(
  probe: { scan_config_override?: unknown; scan_interval_seconds?: unknown; scan_config?: unknown },
  resolved: Partial<ResolvedSettings> | null,
  flow: SettingValue | null,
): ScanConfigResolution {
  const flowValue = flow?.value;
  const flowAnalysisEnabled = flowValue === true || flowValue === 'true';
  const flowSource = flow ? sourceOf(flow) : FALLBACK_SOURCE;

  const override = (probe.scan_config_override as boolean | null | undefined) ?? true;
  if (override || !resolved) {
    const scanConfig = scanConfigOf(probe.scan_config);
    const own: EffectiveConfigSource = { source: 'probe', sourceId: null, sourceName: 'This probe' };
    return {
      effective: {
        scanIntervalSeconds: clampScanInterval(probe.scan_interval_seconds ?? SETTINGS_DEFAULTS.scanIntervalSeconds),
        excludedSubnets: scanConfig.excludedSubnets ?? [],
        extraSubnets: scanConfig.extraSubnets ?? [],
        portScanEnabled: scanConfig.portScanEnabled ?? false,
        portScanPorts: scanConfig.portScanPorts ?? [],
        flowAnalysisEnabled,
        acceptsSkippedSubnets: true,
      },
      sources: {
        scanIntervalSeconds: own,
        excludedSubnets: own,
        extraSubnets: own,
        portScanEnabled: own,
        portScanPorts: own,
        flowAnalysisEnabled: flowSource,
      },
    };
  }

  const portScan = resolved.portScanEnabled?.value;
  return {
    effective: {
      scanIntervalSeconds: clampScanInterval(resolved.scanIntervalSeconds?.value),
      excludedSubnets: settingList<string>(resolved.excludedSubnets?.value),
      extraSubnets: settingList<string>(resolved.extraSubnets?.value),
      portScanEnabled: portScan === true || portScan === 'true',
      portScanPorts: settingList<number>(resolved.portScanPorts?.value),
      flowAnalysisEnabled,
      acceptsSkippedSubnets: true,
    },
    sources: {
      scanIntervalSeconds: sourceOf(resolved.scanIntervalSeconds),
      excludedSubnets: sourceOf(resolved.excludedSubnets),
      extraSubnets: sourceOf(resolved.extraSubnets),
      portScanEnabled: sourceOf(resolved.portScanEnabled),
      portScanPorts: sourceOf(resolved.portScanPorts),
      flowAnalysisEnabled: flowSource,
    },
  };
}

/** The Device Checks assignment without its targets / credentials (effective-config view). */
function summarizeChecksConfig(c: ProbeDeviceChecksConfig): { rev: string; rules: number; targets: number } {
  return { rev: String(c.rev), rules: c.rules.length, targets: c.targets.length };
}

// ─── Scan telemetry ─────────────────────────────────────────────────────────

/** Columns of a push's scan report (migration 050). Pure; unit-tested. */
export function scanTelemetryColumns(payload: Pick<ProbePushPayload, 'scanDurationMs' | 'discoveredDevices' | 'scannedSubnets' | 'skippedSubnets'>, now: Date): Record<string, unknown> {
  const duration = payload.scanDurationMs;
  const columns: Record<string, unknown> = {
    last_scan_at: now,
    // int column: an absurd value (> ~24 days) is not a scan duration.
    last_scan_duration_ms: duration !== null && duration <= 2_147_483_647 ? Math.round(duration) : null,
    last_scan_device_count: payload.discoveredDevices?.length ?? 0,
    last_scanned_subnets: JSON.stringify(payload.scannedSubnets.slice(0, 256)),
  };
  // Only probes that report it (acceptsSkippedSubnets): older ones leave the column as it is.
  if (payload.skippedSubnets !== null) columns.skipped_subnets = JSON.stringify(payload.skippedSubnets);
  return columns;
}

// A rejected push is written to the probe row at most once a minute per probe.
const PUSH_ERROR_WRITE_INTERVAL_MS = 60_000;
const lastPushErrorWrite = new Map<number, number>();

/**
 * Stores a push the server refused or could not process after the probe
 * authenticated ('invalid_payload', 'device_processing_failed'), throttled
 * to once a minute per probe. Never throws, never blocks the push.
 */
function recordPushError(tenantId: number, probeId: number, code: string, columns: ProbeOptionalColumns): void {
  if (!columns.scanTelemetry || !shouldRecordPushError(probeId)) return;
  void db('probes')
    .where({ id: probeId, tenant_id: tenantId })
    .update({ last_push_error_code: code.slice(0, 64), last_push_error_at: new Date() })
    .catch((err: unknown) => {
      logger.warn({ err: (err as Error)?.message, probeId }, 'Could not store the probe push error');
    });
}

/** Whether a push error of this probe may be stored now (throttle). Exported for tests. */
export function shouldRecordPushError(probeId: number, now: number = Date.now()): boolean {
  const last = lastPushErrorWrite.get(probeId);
  if (last !== undefined && now - last < PUSH_ERROR_WRITE_INTERVAL_MS) return false;
  if (lastPushErrorWrite.size >= 5_000) lastPushErrorWrite.clear();
  lastPushErrorWrite.set(probeId, now);
  return true;
}

// ─── Dedup Cache ────────────────────────────────────────────────────────────
// When multiple probes scan the same site, they may report identical changes.
// The dedup cache suppresses duplicate Socket.io events and alerts within a TTL.
// Exception: IP_CONFLICT_DETECTED events are NEVER deduplicated.

interface DedupEntry {
  ts: number;
  probeId: number;
  isPrimary: boolean;
}

const dedupCache = new Map<string, DedupEntry>();
const DEDUP_TTL_MS = 60_000;

function dedupKey(tenantId: number, siteId: number, mac: string | null, changeType: string): string {
  return `${tenantId}:${siteId}:${mac ?? 'null'}:${changeType}`;
}

/**
 * Check if an event should be suppressed by dedup.
 * Returns true if the event should be SKIPPED (already reported within TTL).
 * MAC/IP conflict events (changeType='conflict') are never suppressed.
 */
function shouldDedup(
  tenantId: number,
  siteId: number,
  mac: string | null,
  changeType: string,
  probeId: number,
  isPrimary: boolean,
): boolean {
  if (changeType === 'conflict') return false; // Never dedup conflicts

  const key = dedupKey(tenantId, siteId, mac, changeType);
  const existing = dedupCache.get(key);
  const now = Date.now();

  if (existing && now - existing.ts < DEDUP_TTL_MS) {
    // Already reported within TTL
    if (isPrimary && !existing.isPrimary) {
      // Primary takes precedence — update cache but don't skip
      dedupCache.set(key, { ts: now, probeId, isPrimary });
      return false;
    }
    return true; // Skip duplicate
  }

  // Not in cache or expired — process and cache
  dedupCache.set(key, { ts: now, probeId, isPrimary });
  return false;
}

/** Cleanup expired entries — called periodically */
export function cleanupDedupCache(): void {
  const now = Date.now();
  for (const [key, entry] of dedupCache) {
    if (now - entry.ts > DEDUP_TTL_MS) {
      dedupCache.delete(key);
    }
  }
}

// ─── Alerting settings ───────────────────────────────────────────────────────
//
// IPAM alerts follow the settings chain of their site (Global → Group chain
// → Site; a probe's own overrides last for the probe-offline job):
// notificationEnabled is the master switch, and one notify* key per event
// type (new device, device offline, device back online, IP conflict, probe
// offline / back online). An event that is switched off raises neither a live
// alert nor a channel notification. Socket events (UI state) are always sent,
// and a resolution always runs (it only clears alerts that exist). An active
// maintenance window covering the site (maintenance.service) also
// suppresses the new alerts and notifications (siteAlertsEnabled, liveness).

export interface AlertSettings {
  notificationEnabled: boolean;
  notifyNewDevice: boolean;
  notifyDeviceOffline: boolean;
  notifyDeviceOnline: boolean;
  notifyIpConflict: boolean;
  notifyProbeOffline: boolean;
  /** Consecutive missed scans before a device goes offline. */
  maxMissedPushes: number;
  /** A probe is offline after this many scan intervals without contact… */
  offlineThresholdMultiplier: number;
  /** …and never before this many minutes. */
  probeOfflineGraceMinutes: number;
  scanIntervalSeconds: number;
}

type NotifyKey = 'notifyNewDevice' | 'notifyDeviceOffline' | 'notifyDeviceOnline' | 'notifyIpConflict' | 'notifyProbeOffline';

function boolSetting(resolved: Partial<ResolvedSettings> | null, key: SettingsKey): boolean {
  const v = resolved?.[key]?.value;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return SETTINGS_DEFAULTS[key] === true;
}

/** A number setting within [min, max] (integer unless `fraction`). */
function numSetting(resolved: Partial<ResolvedSettings> | null, key: SettingsKey, min: number, max: number, fraction = false): number {
  const v = resolved?.[key]?.value;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  const value = Number.isFinite(n) ? n : Number(SETTINGS_DEFAULTS[key]);
  return Math.min(max, Math.max(min, fraction ? value : Math.floor(value)));
}

/** Alerting settings from resolved settings (null or invalid values: the defaults). */
export function alertSettingsFrom(resolved: Partial<ResolvedSettings> | null): AlertSettings {
  return {
    notificationEnabled: boolSetting(resolved, 'notificationEnabled'),
    notifyNewDevice: boolSetting(resolved, 'notifyNewDevice'),
    notifyDeviceOffline: boolSetting(resolved, 'notifyDeviceOffline'),
    notifyDeviceOnline: boolSetting(resolved, 'notifyDeviceOnline'),
    notifyIpConflict: boolSetting(resolved, 'notifyIpConflict'),
    notifyProbeOffline: boolSetting(resolved, 'notifyProbeOffline'),
    maxMissedPushes: numSetting(resolved, 'maxMissedPushes', 1, 20),
    offlineThresholdMultiplier: numSetting(resolved, 'offlineThresholdMultiplier', 1, 10, true),
    probeOfflineGraceMinutes: numSetting(resolved, 'probeOfflineGraceMinutes', 1, 1440, true),
    scanIntervalSeconds: numSetting(resolved, 'scanIntervalSeconds', 10, 86400),
  };
}

/** Takeover window (minutes) of the device tracking pipeline (default when invalid). */
export function takeoverWindowFrom(resolved: Partial<ResolvedSettings> | null): number {
  return numSetting(resolved, 'takeoverWindowMinutes', 1, 10080);
}

/**
 * alertOnlyWatchedDevices of resolved settings (default false): device
 * offline / back-online alerts only for the devices set to 'always'.
 */
export function onlyWatchedDevicesFrom(resolved: Partial<ResolvedSettings> | null): boolean {
  return boolSetting(resolved, 'alertOnlyWatchedDevices');
}

/** The event raises alerts: master switch on and its notify* key on. */
export function alertsEnabled(settings: AlertSettings, key: NotifyKey): boolean {
  return settings.notificationEnabled && settings[key];
}

/** Alerting settings of a site (defaults when they cannot be resolved). */
async function siteAlertSettings(tenantId: number, siteId: number): Promise<{
  alerts: AlertSettings;
  takeoverWindowMinutes: number;
  onlyWatchedDevices: boolean;
}> {
  try {
    const resolved = await settingsService.resolveForSite(tenantId, siteId);
    return {
      alerts: alertSettingsFrom(resolved),
      takeoverWindowMinutes: takeoverWindowFrom(resolved),
      onlyWatchedDevices: onlyWatchedDevicesFrom(resolved),
    };
  } catch (err) {
    if (warnOnce(`alert-settings:${tenantId}:${siteId}`)) {
      logger.warn({ err: (err as Error)?.message, tenantId, siteId }, 'Site alert settings could not be resolved — defaults used');
    }
    return { alerts: alertSettingsFrom(null), takeoverWindowMinutes: takeoverWindowFrom(null), onlyWatchedDevices: onlyWatchedDevicesFrom(null) };
  }
}

// ─── Offline debounce ────────────────────────────────────────────────────────

/** Upper bound of site_items.missed_scans. */
export const MISSED_SCANS_CAP = 1000;

export interface OfflineDecision {
  status: string;
  missedScans: number;
  /** 'offline': the device just went offline; 'online': it came back from 'offline'. */
  transition: 'offline' | 'online' | null;
}

/**
 * Offline debounce of a discovered device, for one scan of the probe that
 * owns it (pure; unit-tested):
 *  - seen → online, count reset. Coming back from 'offline' is a transition;
 *    from 'unknown' / 'reserved' it is not (nothing was reported down);
 *  - not seen while online → one more missed scan (capped); offline once the
 *    count reaches maxMissed (at least 1: 1 = offline on the first miss, the
 *    behaviour before the debounce);
 *  - not seen while not online → unchanged (an offline device counts nothing).
 */
export function nextOfflineState(
  prev: { status: string; missedScans: number },
  seen: boolean,
  maxMissed: number,
): OfflineDecision {
  const threshold = Number.isFinite(maxMissed) && maxMissed >= 1 ? Math.floor(maxMissed) : 1;
  const missed = Number.isFinite(prev.missedScans) && prev.missedScans > 0
    ? Math.min(Math.floor(prev.missedScans), MISSED_SCANS_CAP)
    : 0;
  if (seen) {
    return { status: 'online', missedScans: 0, transition: prev.status === 'offline' ? 'online' : null };
  }
  if (prev.status !== 'online') return { status: prev.status, missedScans: missed, transition: null };
  const next = Math.min(missed + 1, MISSED_SCANS_CAP);
  return next >= threshold
    ? { status: 'offline', missedScans: next, transition: 'offline' }
    : { status: 'online', missedScans: next, transition: null };
}

/** How long (ms) a probe may stay silent before it is offline. */
export function probeOfflineThresholdMs(scanIntervalSeconds: number, multiplier: number, graceMinutes: number): number {
  return Math.max(multiplier * scanIntervalSeconds * 1000, graceMinutes * 60_000);
}

// ─── IPAM alerts ─────────────────────────────────────────────────────────────

/** One push (or job run) on one site: where alerts go and whether they are on. */
interface SiteAlertContext {
  tenantId: number;
  siteId: number;
  siteGroupId: number | null;
  siteName: string;
  alerts: AlertSettings;
  /**
   * A maintenance window covers the site (maintenance.service):
   * states are still updated and alerts still resolve, but no new live
   * alert or channel notification goes out.
   */
  inMaintenance: boolean;
  /** alertOnlyWatchedDevices of the site. */
  onlyWatchedDevices: boolean;
  now: Date;
  /**
   * Socket events of this push: detailed events to the admin room, one
   * coalesced SITE_UPDATED for the site's readers (realtime.service).
   */
  events: SiteEventBatch;
  /**
   * Device history of this push (site_item_events), written in one batch
   * at the end of processDevices (recordItemEvents never throws).
   */
  itemEvents: ItemEventInput[];
  /** Probe of the push (the events' probe_id). */
  probeId: number | null;
}

/** Appends one device history event of this push (written at its end). */
function addItemEvent(
  ctx: SiteAlertContext,
  e: Pick<ItemEventInput, 'kind' | 'itemId' | 'mac' | 'ip' | 'details'>,
): void {
  ctx.itemEvents.push({
    tenantId: ctx.tenantId,
    siteId: ctx.siteId,
    probeId: ctx.probeId,
    at: ctx.now,
    ...e,
  });
}

/** The site's event raises alerts: alertsEnabled and no active maintenance window. */
function siteAlertsEnabled(ctx: SiteAlertContext, key: NotifyKey): boolean {
  return !ctx.inMaintenance && alertsEnabled(ctx.alerts, key);
}

/** Page of one device (live alert links). */
export function devicePagePath(siteId: number, itemId: number): string {
  return `/sites/${siteId}/devices/${itemId}`;
}

/** Live alert stable key of a device's offline incident (resolved when it is back). */
export function deviceOfflineKey(siteId: number, itemId: number): string {
  return `device-offline:${siteId}:${itemId}`;
}

/** IP takeover / instability live alerts are resolved this long after they were raised. */
const IP_CONFLICT_ALERT_TTL_HOURS = 24;

/** Live alert stable key of a probe's offline incident (resolved when it is back). */
export function probeOfflineKey(probeId: number): string {
  return `probe-offline:${probeId}`;
}

function itemLabel(item: { custom_name?: unknown; hostname?: unknown; ip?: unknown }): string {
  return (typeof item.custom_name === 'string' && item.custom_name)
    || (typeof item.hostname === 'string' && item.hostname)
    || String(item.ip ?? '');
}

function sendSiteNotification(
  ctx: SiteAlertContext,
  payload: {
    monitorName: string;
    oldStatus: string;
    newStatus: string;
    message: string;
    deviceIp?: string;
    deviceMac?: string | null;
    deviceName?: string | null;
  },
  logLabel: string,
): void {
  void notificationService.sendForSite(ctx.tenantId, ctx.siteGroupId, {
    ...payload,
    timestamp: ctx.now.toISOString(),
    isIpamNotification: true,
    siteName: ctx.siteName,
    siteId: ctx.siteId,
  }, ctx.siteId).catch((err) => logger.warn({ err, siteId: ctx.siteId }, `IPAM ${logLabel} notification failed`));
}

/** A device of an alert: its label, addresses, type / vendor and alert mode (site_items.alert_mode). */
interface AlertedItem {
  id: number;
  ip: string;
  mac: string | null;
  name: string;
  deviceType?: string | null;
  vendor?: string | null;
  alertMode: ItemAlertMode;
}

/**
 * Live alert params of a device event (kinds device_offline / device_online).
 * deviceType (never 'unknown') and vendor are optional: clients show them
 * when present.
 */
function deviceAlertParams(ctx: SiteAlertContext, item: AlertedItem): Record<string, string | null> {
  const deviceType = item.deviceType && item.deviceType !== 'unknown' ? item.deviceType : null;
  const vendor = item.vendor?.trim() ? item.vendor.trim().slice(0, 128) : null;
  return { name: item.name, ip: item.ip, mac: item.mac, siteName: ctx.siteName, deviceType, vendor };
}

/**
 * A device just went offline (after the debounce): live alert + notification,
 * under notificationEnabled / notifyDeviceOffline and the device's alert mode
 * (deviceAlertAllowed).
 */
async function reportDeviceOffline(ctx: SiteAlertContext, item: AlertedItem): Promise<void> {
  if (!siteAlertsEnabled(ctx, 'notifyDeviceOffline')) return;
  if (!deviceAlertAllowed(item.alertMode, ctx.onlyWatchedDevices)) return;
  const message = `Device "${item.name}" (${item.ip}${item.mac ? ` / ${item.mac}` : ''}) on site "${ctx.siteName}" has gone offline.`;
  await liveAlertService.add(ctx.tenantId, {
    severity: 'down',
    title: `Device offline: ${item.name}`.slice(0, 255),
    message,
    navigateTo: devicePagePath(ctx.siteId, item.id),
    stableKey: deviceOfflineKey(ctx.siteId, item.id),
    siteId: ctx.siteId,
    kind: 'device_offline',
    params: deviceAlertParams(ctx, item),
  }).catch((err) => logger.warn({ err, itemId: item.id }, 'Device offline live alert failed'));
  sendSiteNotification(ctx, {
    monitorName: `Device offline on ${ctx.siteName}`,
    oldStatus: 'up',
    newStatus: 'down',
    message,
    deviceIp: item.ip,
    deviceMac: item.mac,
    deviceName: item.name,
  }, 'offline');
}

/**
 * An offline device was seen again: its offline alert is resolved (whatever
 * the settings) and, when notifyDeviceOnline is on, a notification goes out
 * — unless another probe of the site reported the same change just before.
 */
async function reportDeviceOnline(
  ctx: SiteAlertContext,
  item: AlertedItem,
  duplicate: boolean,
): Promise<void> {
  await liveAlertService.resolve(ctx.tenantId, deviceOfflineKey(ctx.siteId, item.id))
    .catch((err) => logger.warn({ err, itemId: item.id }, 'Device offline alert resolution failed'));
  if (duplicate || !siteAlertsEnabled(ctx, 'notifyDeviceOnline')) return;
  if (!deviceAlertAllowed(item.alertMode, ctx.onlyWatchedDevices)) return;
  sendSiteNotification(ctx, {
    monitorName: `Device back online on ${ctx.siteName}`,
    oldStatus: 'down',
    newStatus: 'up',
    message: `Device "${item.name}" (${item.ip}${item.mac ? ` / ${item.mac}` : ''}) on site "${ctx.siteName}" is back online.`,
    deviceIp: item.ip,
    deviceMac: item.mac,
    deviceName: item.name,
  }, 'online');
}

/**
 * IP conflict (takeover or instability): live alert and, when the alert is
 * new (not a duplicate of an unread one), a notification.
 */
async function reportIpConflict(
  ctx: SiteAlertContext,
  alert: {
    title: string;
    message: string;
    stableKey: string;
    ip: string;
    mac: string | null;
    kind: 'ip_takeover' | 'ip_instability';
    params: Record<string, string | number | null>;
  },
): Promise<void> {
  if (!siteAlertsEnabled(ctx, 'notifyIpConflict')) return;
  let inserted = false;
  try {
    inserted = (await liveAlertService.add(ctx.tenantId, {
      severity: 'warning',
      title: alert.title,
      message: alert.message,
      navigateTo: `/sites/${ctx.siteId}`,
      stableKey: alert.stableKey,
      siteId: ctx.siteId,
      kind: alert.kind,
      params: { ...alert.params, siteName: ctx.siteName },
    })) !== null;
  } catch (err) {
    logger.warn({ err, ip: alert.ip }, 'IP conflict live alert failed');
    return;
  }
  if (!inserted) return;
  sendSiteNotification(ctx, {
    monitorName: `${alert.title} on ${ctx.siteName}`,
    oldStatus: 'online',
    newStatus: 'conflict',
    message: alert.message,
    deviceIp: alert.ip,
    deviceMac: alert.mac,
  }, 'IP conflict');
}

// ─── Probe liveness (probe-offline job) ──────────────────────────────────────

/** Silence below which no probe is ever a candidate (the smallest possible threshold). */
const PROBE_SILENCE_MIN_MS = 60_000;
/** Server start: the silence of a probe is never counted before it. */
const livenessEpoch = Date.now();
/**
 * Probes approved / reactivated by an admin (id → time): their silence is
 * not counted before that moment either (refused / suspended contacts never
 * refresh last_seen_at, so a long-suspended probe would otherwise be
 * reported offline before it had a chance to reconnect). In memory only:
 * a restart gives every probe the same grace through livenessEpoch.
 */
const livenessReactivatedAt = new Map<number, number>();

function markProbesReactivated(ids: Iterable<number>, at: number = Date.now()): void {
  for (const id of ids) livenessReactivatedAt.set(id, at);
}

/** Lower bound of a probe's silence: server start or its latest reactivation. */
function livenessEpochFor(probeId: number): number {
  return Math.max(livenessEpoch, livenessReactivatedAt.get(probeId) ?? 0);
}
/** A probe's alerting settings are re-resolved at most this often by the job. */
const LIVENESS_SETTINGS_TTL_MS = 5 * 60_000;
const livenessSettingsCache = new Map<number, { at: number; key: string; settings: AlertSettings }>();

interface LivenessRow {
  id: number;
  tenant_id: number;
  site_id: number | null;
  name: string | null;
  hostname: string | null;
  ip: string | null;
  last_seen_at: Date | string;
  offline_alerted_at: Date | string | null;
  scan_interval_seconds: number | null;
  scan_config_override: boolean | null;
  /** The probe's site, when it is in the probe's tenant. */
  site_row_id: number | null;
  site_name: string | null;
  site_group_id: number | null;
}

function probeLabel(row: { id: number; name?: string | null; hostname?: string | null }): string {
  return (row.name || row.hostname || `#${row.id}`).slice(0, 128);
}

type LivenessSettingsRow = Pick<LivenessRow, 'id' | 'tenant_id' | 'site_row_id' | 'site_group_id'>;
type LivenessIntervalRow = Pick<LivenessRow, 'scan_interval_seconds' | 'scan_config_override'>;

/**
 * Silence (ms) after which a probe is offline: max(multiplier × interval,
 * grace), the interval being the probe's own when it overrides the settings
 * chain (scan_config_override, the default), else the chain's. Shared by the
 * probe-offline job and the primary failover (pure; unit-tested).
 */
export function probeSilenceThresholdMs(row: LivenessIntervalRow, settings: AlertSettings): number {
  const override = row.scan_config_override ?? true;
  // The interval the probe actually runs (clamped when sent, see computeScanConfig).
  const interval = override && Number(row.scan_interval_seconds) > 0
    ? clampScanInterval(row.scan_interval_seconds)
    : settings.scanIntervalSeconds;
  return probeOfflineThresholdMs(interval, settings.offlineThresholdMultiplier, settings.probeOfflineGraceMinutes);
}

/** How long (ms) a probe has been silent, never counted before `epoch` (server start). */
export function probeSilenceMs(lastSeenAt: unknown, now: number, epoch: number = livenessEpoch): number {
  const parsed = lastSeenAt == null ? NaN
    : typeof lastSeenAt === 'number' ? lastSeenAt
      : (lastSeenAt instanceof Date ? lastSeenAt : new Date(String(lastSeenAt))).getTime();
  const lastSeen = Number.isFinite(parsed) ? parsed : 0;
  return now - Math.max(lastSeen, epoch);
}

/**
 * Primary failover (pure; unit-tested): another probe of the site takes the
 * primary role only when the current primary is no longer approved, or —
 * not on the WebSocket — is still reported offline by the probe-offline job
 * (not seen since) or has been silent longer than its offline threshold (the
 * job's own rule, probeSilenceThresholdMs). A probe in HTTP mode that pushes
 * once per scan interval keeps the role, as does one connected again.
 */
export function primaryNeedsFailover(
  primary: { status?: unknown; last_seen_at?: unknown; offline_alerted_at?: unknown },
  wsConnected: boolean,
  silenceMs: number,
  thresholdMs: number,
): boolean {
  if (primary.status !== 'approved') return true;
  if (wsConnected) return false;
  if (activeOfflineSince(primary) !== null) return true;
  return silenceMs >= thresholdMs;
}

/** Alerting settings of a probe: its site chain, then its own overrides (cached). */
async function livenessSettings(row: LivenessSettingsRow): Promise<AlertSettings> {
  const siteId = row.site_row_id ?? null;
  const groupId = siteId !== null ? (row.site_group_id ?? null) : null;
  const key = `${row.tenant_id}:${siteId ?? ''}:${groupId ?? ''}`;
  const now = Date.now();
  const cached = livenessSettingsCache.get(row.id);
  if (cached && cached.key === key && now - cached.at < LIVENESS_SETTINGS_TTL_MS) return cached.settings;
  let settings: AlertSettings;
  try {
    settings = alertSettingsFrom(await settingsService.resolveForProbe(row.tenant_id, row.id, siteId, groupId));
  } catch (err) {
    if (warnOnce(`liveness-settings:${row.id}`)) {
      logger.warn({ err: (err as Error)?.message, probeId: row.id }, 'Probe alert settings could not be resolved — defaults used');
    }
    settings = alertSettingsFrom(null);
  }
  if (livenessSettingsCache.size >= 5_000) livenessSettingsCache.clear();
  livenessSettingsCache.set(row.id, { at: now, key, settings });
  return settings;
}

// ─── Vendor / Device-Type Helpers ────────────────────────────────────────────

/**
 * Vendor of a MAC: the longest registered prefix of the IEEE
 * registries (MA-S 36 bits, MA-M 28, MA-L 24; ouiRegistry.service, 5-minute
 * cache), the admin override (custom_name) first. Null when unknown or on a
 * lookup error (logged there).
 */
function lookupVendor(mac: string): Promise<string | null> {
  return lookupVendorByMac(mac);
}

/**
 * The vendor rules that may apply to a site of `groupId`: tenant-wide rules
 * and the rules of the group and its ancestor groups (closure table; depth 0
 * is the group itself), with the group's ancestors, for vendorRuleMatch (the
 * semantics shared with the re-apply action: priority desc, id asc, first
 * case-insensitive substring match).
 */
async function loadVendorRules(
  tenantId: number,
  groupId: number | null,
): Promise<{ rules: ScopedVendorRuleRow[]; ancestors: number[] }> {
  const [rules, ancestorRows] = await Promise.all([
    db('vendor_type_rules')
      .where({ tenant_id: tenantId })
      .where(function () {
        this.whereNull('group_id');
        if (groupId) {
          this.orWhereIn('group_id', db('group_closure').select('ancestor_id').where('descendant_id', groupId));
        }
      })
      .select('id', 'group_id', 'priority', 'vendor_pattern', 'device_type', 'label') as Promise<ScopedVendorRuleRow[]>,
    groupId
      ? db('group_closure').where('descendant_id', groupId).select('ancestor_id') as Promise<Array<{ ancestor_id: number }>>
      : Promise.resolve([] as Array<{ ancestor_id: number }>),
  ]);
  const ancestors = ancestorRows.map((r) => Number(r.ancestor_id));
  // The group itself (depth 0) even if its closure row were missing.
  if (groupId && !ancestors.includes(groupId)) ancestors.push(groupId);
  return { rules, ancestors };
}

/**
 * Classification of one device during a push: the first
 * matching vendor rule ('rule'), else the open-port guess ('ports'), else
 * null. The rules of the site are loaded once per push (on first use).
 */
interface DeviceClassifier {
  classify(vendor: string | null, openPorts: number[]): Promise<{ deviceType: string; label: string | null; source: DeviceTypeSource } | null>;
}

function createDeviceClassifier(tenantId: number, groupId: number | null): DeviceClassifier {
  let loaded: Promise<{ rules: ScopedVendorRuleRow[]; ancestors: number[] }> | null = null;
  return {
    async classify(vendor, openPorts) {
      if (vendor) {
        if (!loaded) {
          loaded = loadVendorRules(tenantId, groupId).catch((err: unknown) => {
            logger.warn({ err: (err as Error)?.message, tenantId }, 'Vendor rules could not be loaded');
            return { rules: [], ancestors: [] };
          });
        }
        const { rules, ancestors } = await loaded;
        const rule = matchVendorRule(vendor, rules, ancestors);
        if (rule) return { deviceType: rule.deviceType, label: rule.label, source: 'rule' };
      }
      const byPorts = classifyByPorts(openPorts);
      return byPorts ? { deviceType: byPorts, label: null, source: 'ports' } : null;
    },
  };
}

// ─── IP History ──────────────────────────────────────────────────────────────

const IP_HISTORY_CHUNK = 1000;

/**
 * Records every mac → ip pair seen in a push: one batched upsert on
 * the (site_id, mac, ip) unique key (migration 048) instead of a SELECT then
 * UPDATE / INSERT per device; last_seen_at only moves forward.
 */
async function recordIpHistoryBatch(
  siteId: number,
  tenantId: number,
  pairs: Iterable<{ mac: string; ip: string }>,
  now: Date,
): Promise<void> {
  const rows = [...pairs].map(({ mac, ip }) => ({
    mac,
    site_id: siteId,
    tenant_id: tenantId,
    ip,
    first_seen_at: now,
    last_seen_at: now,
  }));
  // Deterministic order: concurrent pushes of the site's probes lock the
  // same rows in the same order (no deadlock between two upserts).
  rows.sort((a, b) => (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : 0));
  for (let i = 0; i < rows.length; i += IP_HISTORY_CHUNK) {
    await db('item_ip_history')
      .insert(rows.slice(i, i + IP_HISTORY_CHUNK))
      .onConflict(['site_id', 'mac', 'ip'])
      .merge({ last_seen_at: db.raw('GREATEST(item_ip_history.last_seen_at, EXCLUDED.last_seen_at)') });
  }
}

// ─── IP Instability Detection ─────────────────────────────────────────────────

/**
 * After a push, detect IP address instability: an IP that has been claimed by
 * >= 3 distinct MACs across recent consecutive scans.
 *
 * Because a single probe reports each IP exactly once per scan, intra-push
 * conflict detection is meaningless. Instead we query item_ip_history —
 * which is written for EVERY mac→ip pair seen in every push — and look for
 * IPs with too many distinct MACs in the sliding window.
 *
 * An IP whose MACs are all randomized (locally administered) raises nothing.
 *
 * @param seenIpMacs  Map of ip → mac from the current push (only IPs with MACs)
 * @param windowMs    Sliding window; should comfortably span 3+ scan intervals
 *                    Default: 3 × 10 min = 30 min
 */
async function checkIpInstability(
  ctx: SiteAlertContext,
  seenIpMacs: Map<string, string>,
  windowMs = 30 * 60 * 1000,
): Promise<void> {
  const { tenantId, siteId } = ctx;
  if (seenIpMacs.size === 0) return;
  const since = new Date(Date.now() - windowMs);
  const ips = [...seenIpMacs.keys()];

  let rows: { ip: string; mac: string }[];
  try {
    rows = await db('item_ip_history')
      .where({ site_id: siteId, tenant_id: tenantId })
      .whereIn('ip', ips)
      .where('last_seen_at', '>=', since)
      .select('ip', 'mac') as { ip: string; mac: string }[];
  } catch (err) {
    logger.warn({ err }, 'IP instability query failed');
    return;
  }

  // Group distinct MACs per IP
  const macsByIp = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!macsByIp.has(row.ip)) macsByIp.set(row.ip, new Set());
    macsByIp.get(row.ip)!.add(row.mac);
  }

  for (const [ip, macs] of macsByIp) {
    if (macs.size < 3) continue;
    // Rotating private MACs (phones, laptops) on one lease are not a conflict.
    if (allRandomized(macs)) continue;

    const macList = [...macs].join(', ');
    const stableKey = `ip-instability:${siteId}:${ip}`;

    logger.warn({ ip, siteId, tenantId, distinctMacs: macs.size }, 'IP instability detected');

    await reportIpConflict(ctx, {
      title: `IP Instability: ${ip}`,
      message: `${macs.size} different MACs claimed ${ip} across the last 3 scans: ${macList}`,
      stableKey,
      ip,
      mac: seenIpMacs.get(ip) ?? null,
      kind: 'ip_instability',
      params: { ip, macCount: macs.size },
    });

    ctx.events.toAdmins(SOCKET_EVENTS.IP_CONFLICT_DETECTED, {
      ip,
      siteId,
      tenantId,
      distinctMacs: macs.size,
      macs: [...macs],
    });
  }
}

// ─── Device Processing ───────────────────────────────────────────────────────

// site_items.alert_mode comes from migration 052: selected only once it
// exists (once seen never checked again; re-checked a minute later while
// missing). Full-row reads (first()) simply lack it before: 'inherit'.
let alertModeColumn: { at: number; exists: boolean } | null = null;
let alertModeColumnCheck: Promise<boolean> | null = null;

function hasItemAlertModeColumn(): Promise<boolean> {
  const seen = alertModeColumn;
  if (seen && (seen.exists || Date.now() - seen.at < 60_000)) return Promise.resolve(seen.exists);
  if (!alertModeColumnCheck) {
    alertModeColumnCheck = db.schema.hasColumn('site_items', 'alert_mode')
      .then((exists) => {
        alertModeColumn = { at: Date.now(), exists };
        return exists;
      })
      .catch((err: unknown) => {
        logger.warn({ err: (err as Error)?.message }, 'site_items.alert_mode lookup failed');
        return false;
      })
      .finally(() => { alertModeColumnCheck = null; });
  }
  return alertModeColumnCheck;
}

async function processDevices(
  probeId: number,
  tenantId: number,
  siteId: number,
  siteGroupId: number | null,
  siteName: string,
  devices: ProbePushDevice[],
  probeMac: string | null,
  isProbePrimary: boolean,
  events: SiteEventBatch,
): Promise<{ checkTargetsChanged: boolean }> {
  const now = new Date();
  // Alerting settings of the site, resolved once for the whole push.
  const siteSettings = await siteAlertSettings(tenantId, siteId);
  const ctx: SiteAlertContext = {
    tenantId,
    siteId,
    siteGroupId,
    siteName,
    alerts: siteSettings.alerts,
    // Resolved once per push (cached 30 s, never throws: false on error).
    inMaintenance: await maintenanceService.isSiteInMaintenance(tenantId, siteId, now),
    onlyWatchedDevices: siteSettings.onlyWatchedDevices,
    now,
    events,
    itemEvents: [],
    probeId,
  };
  const classifier = createDeviceClassifier(tenantId, siteGroupId);
  const updatedItemIds: number[] = [];
  // ip → mac for every device with a known MAC seen in this push (instability
  // detector input).
  const seenIpMacs = new Map<string, string>();
  // Every mac → ip pair of this push, written to item_ip_history in one
  // batched upsert after the loop.
  const historyPairs = new Map<string, { mac: string; ip: string }>();
  const recordPair = (mac: string, ip: string): void => {
    seenIpMacs.set(ip, mac);
    historyPairs.set(`${mac}|${ip}`, { mac, ip });
  };
  // MACs this push reports: a randomized-MAC row still listed here is a
  // device present right now, never the previous address of a rotated one.
  const pushMacs = new Set(devices.map((d) => d.mac).filter((m): m is string => Boolean(m)));
  // A device was re-typed or changed MAC: the Device Checks targets may change.
  let checkTargetsChanged = false;

  for (const device of devices) {
    // Validated and normalised by parseProbePush ("AA:BB:CC:DD:EE:FF").
    const mac = device.mac;
    const ip = device.ip;
    // Probes report the devices they saw (isOnline true). A device listed
    // with isOnline false counts as a missed scan, like an absent one.
    const seen = device.isOnline;

    try {
      let existingItem: Record<string, unknown> | undefined;
      // The IP was claimed from another device (step 2): recorded on the new
      // device's history once its row exists.
      let ipClaim: { kind: 'takeover' | 'ip_reassigned'; oldMac: string; oldItemId: number } | null = null;

      // 1. Try to find by MAC (MAC is the tracking key — follows device across IP changes)
      if (mac) {
        existingItem = await db('site_items')
          .where({ site_id: siteId, tenant_id: tenantId, mac })
          .first();
      }

      // 1b. A rotated private MAC (phones, laptops): the row of the same
      // device under its previous randomized MAC — same hostname, gone from
      // this push — takes the new MAC instead of a duplicate row per rotation.
      if (!existingItem && mac && device.hostname && isLocallyAdministered(mac)) {
        existingItem = await findRotatedMacItem(tenantId, siteId, probeId, device.hostname, pushMacs, updatedItemIds);
        if (existingItem) {
          logger.info({ siteId, itemId: existingItem.id, hostname: device.hostname }, 'Randomized MAC rotation: device row kept');
        }
      }

      // 2. If no MAC match, try by IP (the most recently seen holder first)
      if (!existingItem) {
        const ipItem = await db('site_items')
          .where({ site_id: siteId, tenant_id: tenantId, ip })
          .orderBy('last_seen_at', 'desc')
          .first();

        if (ipItem && mac && ipItem.mac && (ipItem.mac as string) !== mac) {
          // The IP was previously held by a different MAC. Do NOT overwrite
          // the old device — it keeps its customizations (custom_name,
          // device_type, notes) and stays offline until its MAC reappears on
          // a new IP. Create the new device instead. It is an IP takeover
          // (alerted) only when the old owner was seen within the takeover
          // window and has a real MAC; otherwise the DHCP lease was reused
          // (quiet).
          const claim = decideIpClaim({
            oldLastSeenAt: ipItem.last_seen_at as Date | string | null,
            oldMac: ipItem.mac as string,
            now,
            windowMinutes: siteSettings.takeoverWindowMinutes,
          });
          ipClaim = {
            kind: claim === 'takeover' ? 'takeover' : 'ip_reassigned',
            oldMac: ipItem.mac as string,
            oldItemId: Number(ipItem.id),
          };
          if (claim === 'takeover') {
            const oldName = itemLabel(ipItem);
            await reportIpConflict(ctx, {
              title: `IP Takeover: ${ip}`,
              message: `${ip} was used by "${oldName}" (${ipItem.mac as string}) and is now claimed by a new device (${mac}).`,
              stableKey: `ip-takeover:${siteId}:${ip}:${mac}`,
              ip,
              mac,
              kind: 'ip_takeover',
              params: { ip, oldMac: ipItem.mac as string, newMac: mac, oldName },
            });
          } else {
            logger.info({ siteId, ip, oldItemId: ipItem.id }, 'IP reassigned to a new device (previous owner gone or randomized MAC)');
          }
          // Leave existingItem undefined so a new device row is created below
        } else {
          existingItem = ipItem;
        }
      }

      if (existingItem) {
        const itemId = existingItem.id as number;
        const prevStatus = String(existingItem.status ?? 'unknown');
        const decision = nextOfflineState(
          { status: prevStatus, missedScans: Number(existingItem.missed_scans ?? 0) },
          seen,
          ctx.alerts.maxMissedPushes,
        );
        const updates: Record<string, unknown> = {
          status: decision.status,
          missed_scans: decision.missedScans,
          updated_at: now,
          discovered_by_probe_id: probeId,
        };
        if (seen) updates.last_seen_at = now;
        // Update open_ports if the probe ran a port scan (non-null array)
        if (device.openPorts != null) {
          updates.open_ports = JSON.stringify(device.openPorts);
        }

        // Fill in MAC if the existing item had none (e.g. probe's own device
        // was previously discovered via TCP scan without ARP entry), or take
        // the new address of a rotated randomized MAC (step 1b).
        if (mac && existingItem.mac !== mac) {
          updates.mac = mac;
          updates.mac_randomized = isLocallyAdministered(mac);
          checkTargetsChanged = true;
        }

        // MAC-based tracking: IP moved?
        if (mac && existingItem.ip !== ip) {
          updates.ip = ip;
          ctx.events.toAdmins(SOCKET_EVENTS.DEVICE_IP_CHANGED, {
            itemId: existingItem.id,
            mac,
            oldIp: existingItem.ip,
            newIp: ip,
            siteId,
          });
          addItemEvent(ctx, {
            kind: 'ip_changed',
            itemId,
            mac,
            ip,
            details: { oldIp: (existingItem.ip as string | null) ?? null, newIp: ip },
          });
        }

        // Always record mac→ip in history (batched upsert after the loop:
        // updates last_seen_at if the pair already exists). This feeds the
        // cross-scan instability detector.
        if (mac) recordPair(mac, ip);

        if (device.hostname && existingItem.hostname !== device.hostname) {
          updates.hostname = device.hostname;
        }

        // Vendor from the longest registered prefix (cached lookup). Also
        // refreshed when it changed: an admin override (custom_name), or a
        // device of an MA-M / MA-S block first named after the 24-bit
        // 'IEEE Registration Authority' entry. A failed lookup (null) never
        // clears a known vendor.
        if (mac) {
          const vendor = (await lookupVendor(mac))?.slice(0, 128) ?? null;
          if (vendor && vendor !== existingItem.vendor) {
            updates.vendor = vendor;
            // Rules matching on vendorContains must see the corrected vendor.
            checkTargetsChanged = true;
          }
        }

        // Classification: a device still 'unknown', or typed
        // by a rule / the ports and whose vendor just arrived, is classified
        // again — vendor rule first, then open ports. A type set by hand
        // (device_type_source 'manual') is never touched.
        const currentType = String(existingItem.device_type ?? 'unknown') || 'unknown';
        const currentSource = (existingItem.device_type_source as string | null | undefined) ?? null;
        if (mayReclassify(currentType, currentSource, Boolean(updates.vendor))) {
          const vendorNow = ((updates.vendor ?? existingItem.vendor) as string | null | undefined) ?? null;
          const ports = device.openPorts != null ? device.openPorts : parseOpenPorts(existingItem.open_ports);
          const classified = await classifier.classify(vendorNow, ports);
          if (classified && (classified.deviceType !== currentType || classified.source !== currentSource)) {
            updates.device_type = classified.deviceType;
            updates.device_type_source = classified.source;
            // The rule's label names a device that had no type and no name yet.
            if (classified.label && currentType === 'unknown' && !existingItem.custom_name) {
              updates.custom_name = classified.label.slice(0, 255);
            }
            if (classified.deviceType !== currentType) checkTargetsChanged = true;
          }
        }

        await db('site_items')
          .where({ id: itemId, site_id: siteId, tenant_id: tenantId })
          .update(updates);

        // If this device IS the probe itself (MAC match), keep probe.ip in sync
        if (probeMac && mac === probeMac) {
          await db('probes').where({ id: probeId, tenant_id: tenantId }).update({ ip, updated_at: now }).catch(() => {});
        }

        updatedItemIds.push(itemId);

        if (decision.status !== prevStatus) {
          const changeType = decision.status === 'online' ? 'online' : 'offline';
          const duplicate = shouldDedup(tenantId, siteId, mac, changeType, probeId, isProbePrimary);
          if (!duplicate) {
            ctx.events.toAdmins(SOCKET_EVENTS.ITEM_STATUS_CHANGED, {
              itemId,
              status: decision.status,
              siteId,
            });
          }
          const item: AlertedItem = {
            id: itemId,
            ip: (updates.ip as string | undefined) ?? String(existingItem.ip),
            mac: mac ?? ((existingItem.mac as string | null) ?? null),
            name: itemLabel({ ...existingItem, hostname: updates.hostname ?? existingItem.hostname }),
            deviceType: ((updates.device_type as string | undefined) ?? (existingItem.device_type as string | null)) ?? null,
            vendor: ((updates.vendor as string | undefined) ?? (existingItem.vendor as string | null)) ?? null,
            alertMode: itemAlertModeOf(existingItem.alert_mode),
          };
          if (decision.transition !== null) {
            addItemEvent(ctx, {
              kind: decision.transition,
              itemId,
              mac: item.mac,
              ip: item.ip,
              details: decision.transition === 'offline' ? { missedScans: decision.missedScans } : null,
            });
          }
          if (decision.transition === 'online') await reportDeviceOnline(ctx, item, duplicate);
          else if (decision.transition === 'offline') await reportDeviceOffline(ctx, item);
        }
      } else {
        // New device discovered
        const vendor = mac ? (await lookupVendor(mac))?.slice(0, 128) ?? null : null;
        // Vendor rule first, then the open ports.
        const classified = await classifier.classify(vendor, device.openPorts ?? []);
        const deviceType = classified?.deviceType ?? 'unknown';

        const [newItem] = await db('site_items')
          .insert({
            site_id: siteId,
            tenant_id: tenantId,
            ip,
            mac: mac ?? null,
            mac_randomized: isLocallyAdministered(mac),
            hostname: device.hostname ?? null,
            // The matching rule's label names the new device (never overwrites a user-set name).
            custom_name: classified?.label ? classified.label.slice(0, 255) : null,
            status: seen ? 'online' : 'offline',
            missed_scans: 0,
            vendor,
            device_type: deviceType,
            device_type_source: classified?.source ?? null,
            is_manual: false,
            discovered_by_probe_id: probeId,
            open_ports: device.openPorts != null ? JSON.stringify(device.openPorts) : null,
            first_seen_at: now,
            last_seen_at: now,
            created_at: now,
            updated_at: now,
          })
          .returning('id');

        const itemId = newItem.id as number;
        updatedItemIds.push(itemId);

        addItemEvent(ctx, {
          kind: 'discovered',
          itemId,
          mac,
          ip,
          details: { vendor, hostname: device.hostname ?? null, deviceType },
        });
        if (ipClaim) {
          addItemEvent(ctx, {
            kind: ipClaim.kind,
            itemId,
            mac,
            ip,
            details: { oldMac: ipClaim.oldMac, oldItemId: ipClaim.oldItemId },
          });
        }

        if (mac) recordPair(mac, ip);

        // If this new device IS the probe itself, sync probe.ip
        if (probeMac && mac === probeMac) {
          await db('probes').where({ id: probeId, tenant_id: tenantId }).update({ ip, updated_at: now }).catch(() => {});
        }

        if (!shouldDedup(tenantId, siteId, mac, 'new', probeId, isProbePrimary)) {
          ctx.events.toAdmins(SOCKET_EVENTS.NEW_DEVICE_DISCOVERED, {
            itemId,
            ip,
            mac,
            siteId,
            vendor,
            deviceType,
          });
        }

        // Notification: new device found on this site
        if (siteAlertsEnabled(ctx, 'notifyNewDevice')) {
          sendSiteNotification(ctx, {
            monitorName: `New device on ${siteName}`,
            oldStatus: 'unknown',
            newStatus: 'up',
            message: `A new device was discovered at ${ip}${mac ? ` (${mac})` : ''}${vendor ? ` — ${vendor}` : ''} on site "${siteName}".`,
            deviceIp: ip,
            deviceMac: mac,
            deviceName: device.hostname ?? null,
          }, 'new-device');
        }
      }
    } catch (err) {
      logger.warn({ err, ip, mac }, 'Failed to upsert site item');
    }
  }

  // Devices of this probe that this push did not list: one more missed scan
  // each; offline only once the site's maxMissedPushes consecutive scans
  // missed them (nextOfflineState). Only this probe's online devices count:
  // a device another probe saw since is owned by that probe
  // (discovered_by_probe_id), and an offline one has nothing left to count.
  try {
    const notListed = () => {
      const q = db('site_items').where({
        site_id: siteId,
        tenant_id: tenantId,
        discovered_by_probe_id: probeId,
        is_manual: false,
        status: 'online',
      });
      if (updatedItemIds.length > 0) q.whereNotIn('id', updatedItemIds);
      return q;
    };

    const columns = ['id', 'ip', 'mac', 'custom_name', 'hostname', 'missed_scans', 'device_type', 'vendor'];
    if (await hasItemAlertModeColumn()) columns.push('alert_mode');
    const candidates = await notListed().select(columns) as Array<{
      id: number; ip: string; mac: string | null; custom_name: string | null; hostname: string | null;
      missed_scans: number | null; device_type: string | null; vendor: string | null; alert_mode?: string | null;
    }>;

    if (candidates.length > 0) {
      const goingOffline = candidates.filter((item) =>
        nextOfflineState({ status: 'online', missedScans: Number(item.missed_scans ?? 0) }, false, ctx.alerts.maxMissedPushes)
          .transition === 'offline');

      await notListed().update({ missed_scans: db.raw('LEAST(missed_scans + 1, ?)', [MISSED_SCANS_CAP]) });

      // Claimed by the status update: a device another push brought back
      // meanwhile is left alone.
      const wentOffline = new Set<number>();
      for (let i = 0; i < goingOffline.length; i += 1000) {
        const ids = goingOffline.slice(i, i + 1000).map((item) => item.id);
        const rows = await notListed().whereIn('id', ids)
          .update({ status: 'offline', updated_at: now })
          .returning('id') as Array<{ id: number }>;
        for (const r of rows) wentOffline.add(Number(r.id));
      }

      for (const item of goingOffline) {
        const itemId = Number(item.id);
        if (!wentOffline.has(itemId)) continue;
        ctx.events.toAdmins(SOCKET_EVENTS.ITEM_STATUS_CHANGED, { itemId, status: 'offline', siteId });
        addItemEvent(ctx, {
          kind: 'offline',
          itemId,
          mac: item.mac ?? null,
          ip: item.ip,
          details: { missedScans: Math.min(Number(item.missed_scans ?? 0) + 1, MISSED_SCANS_CAP) },
        });
        await reportDeviceOffline(ctx, {
          id: itemId,
          ip: item.ip,
          mac: item.mac ?? null,
          name: itemLabel(item),
          deviceType: item.device_type,
          vendor: item.vendor,
          alertMode: itemAlertModeOf(item.alert_mode),
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to mark offline items');
  }

  // Device history of the whole push in one insert. Never throws:
  // a failure is logged and never holds back the alerts above.
  if (ctx.itemEvents.length > 0) await recordItemEvents(ctx.itemEvents);

  // IP history of the whole push in one batched upsert, then the
  // IP instability detection across scans, which reads it (fire-and-forget,
  // errors logged inside).
  if (historyPairs.size > 0) {
    await recordIpHistoryBatch(siteId, tenantId, historyPairs.values(), now)
      .catch((err: unknown) => logger.warn({ err: (err as Error)?.message, siteId }, 'IP history upsert failed'));
  }
  void checkIpInstability(ctx, seenIpMacs);
  return { checkTargetsChanged };
}

/**
 * Step 1b of processDevices: the row of a device that rotated its randomized
 * MAC. Candidates: discovered rows of the site with a randomized MAC and the
 * same hostname (case-insensitive), whose MAC is not in this push. Taken if
 * offline, or still online but owned by this probe (it did not see the old
 * MAC this time: the device now answers under the new one). Never a row
 * already updated by this push; the most recently seen first.
 */
async function findRotatedMacItem(
  tenantId: number,
  siteId: number,
  probeId: number,
  hostname: string,
  pushMacs: ReadonlySet<string>,
  updatedItemIds: readonly number[],
): Promise<Record<string, unknown> | undefined> {
  const candidates = await db('site_items')
    .where({ site_id: siteId, tenant_id: tenantId, mac_randomized: true, is_manual: false })
    .whereNotNull('mac')
    .whereRaw('lower(hostname) = lower(?)', [hostname])
    .orderBy('last_seen_at', 'desc')
    .limit(10) as Array<Record<string, unknown>>;
  return candidates.find((c) => {
    if (pushMacs.has(String(c.mac)) || updatedItemIds.includes(Number(c.id))) return false;
    return c.status === 'offline' || Number(c.discovered_by_probe_id) === probeId;
  });
}

// ─── Push authentication (WS path) ───────────────────────────────────────────

// probe_api_keys.last_used_at, written at most once a minute per key (as
// probeAuth.service does at the upgrade): a probe on a long-lived WebSocket
// keeps its key's "last used" current.
const LAST_USED_WRITE_MS = 60 * 1000;

function touchApiKeyLastUsed(keyId: number, lastUsedAt: unknown): void {
  const last = lastUsedAt instanceof Date
    ? lastUsedAt.getTime()
    : lastUsedAt ? new Date(String(lastUsedAt)).getTime() : 0;
  if (Number.isFinite(last) && Date.now() - last < LAST_USED_WRITE_MS) return;
  db('probe_api_keys')
    .where({ id: keyId })
    .update({ last_used_at: new Date() })
    .catch((err: unknown) => logger.warn({ err: (err as Error)?.message, keyId }, 'probe_api_keys.last_used_at update failed'));
}

/**
 * scan_result over the probe WebSocket: the connection was authenticated at
 * upgrade (authenticateProbe: API key, UUID, identity token, key binding).
 * Re-checks, per message, what can change while it stays open: the key
 * still exists, the probe row still exists in that key's tenant, is not
 * refused / suspended and is still bound to that key (the upgrade bound it).
 * Never registers nor re-binds a probe.
 */
async function authenticateConnectedProbe(apiKeyId: number, probeUuid: string): Promise<ProbeAuthResult> {
  const keyId = toDbId(apiKeyId);
  if (keyId === null) return { ok: false, status: 401, code: 'invalid_key' };
  const uuid = typeof probeUuid === 'string' ? probeUuid.trim().toLowerCase() : '';
  if (!UUID_RE.test(uuid)) return { ok: false, status: 401, code: 'invalid_uuid' };

  const key = await db('probe_api_keys').where({ id: keyId }).first('id', 'tenant_id', 'last_used_at') as
    (ProbeApiKeyRef & { last_used_at: unknown }) | undefined;
  if (!key) return { ok: false, status: 401, code: 'invalid_key' };
  touchApiKeyLastUsed(key.id, key.last_used_at);

  let probe = await db('probes').where({ uuid, tenant_id: key.tenant_id }).first() as ProbeRow | undefined;
  if (!probe) {
    // Identity v2: the HTTP push re-keyed the probe to the shared device ID
    // while this scan_result was in flight under its previous UUID (the
    // connection itself is moved by rekeyProbeConnections).
    probe = await db('probe_uuid_aliases as a')
      .join('probes as p', 'p.id', 'a.probe_id')
      .where({ 'a.uuid': uuid, 'a.tenant_id': key.tenant_id, 'p.tenant_id': key.tenant_id, 'p.api_key_id': key.id })
      .orderBy('a.created_at', 'desc')
      .orderBy('a.id', 'desc')
      .first('p.*') as ProbeRow | undefined;
  }
  if (!probe) return { ok: false, status: 404, code: 'probe_not_registered' };
  if (probe.status === 'refused' || probe.status === 'suspended') {
    return { ok: false, status: 403, code: 'probe_refused' };
  }
  if (probe.api_key_id !== key.id) return { ok: false, status: 401, code: 'key_mismatch' };
  return { ok: true, apiKey: { id: key.id, tenant_id: key.tenant_id }, probe, shouldIssueToken: false };
}

// ─── Probe Service ────────────────────────────────────────────────────────────

class ProbeService {
  // ── Push ──────────────────────────────────────────────────────────────────

  /**
   * One scan report — HTTP push (apiKeyValue + httpAuth from the headers) or
   * WS scan_result (preValidatedApiKeyId of the authenticated connection).
   * Authenticates (services/probeAuth.service.ts), validates the payload
   * (validators/probe.schema.ts), registers unknown probes (HTTP only),
   * processes the devices of approved probes and returns the probe config.
   * A rejected push mutates nothing and carries no config (ProbePushFailure).
   */
  async handlePush(
    apiKeyValue: string,
    probeUuid: string,
    rawPayload: unknown,
    preValidatedApiKeyId?: number,
    httpAuth: ProbePushHttpAuth = {},
  ): Promise<ProbePushResult> {
    const viaWs = preValidatedApiKeyId !== undefined;
    // Identity v2 (shared Obli* device ID): the claim rides on
    // the HTTP push only. The push resolves an alias only to the row already
    // keyed by the announced shared ID (a push replayed after a lost ack);
    // without the headers it never falls back to an alias.
    let identityClaim = viaWs ? null : (httpAuth.identity ?? null);
    // A first install holds no identity token. When it announces a shared
    // Obli* device ID, a token refusal of its legacy UUID means another
    // machine already holds that UUID (SMBIOS UUIDs duplicated across a
    // fleet of identical machines): the push is retried under the shared ID.
    const firstInstallWithSharedId = !viaWs && !!identityClaim && !httpAuth.probeToken
      && identityClaim.target !== probeUuid.trim().toLowerCase();
    let auth = viaWs
      ? await authenticateConnectedProbe(preValidatedApiKeyId, probeUuid)
      : await authenticateProbe({
        apiKey: apiKeyValue,
        probeUuid,
        probeToken: httpAuth.probeToken,
        features: httpAuth.features,
        allowUnknownProbe: true,
        ...(identityClaim ? { aliasFallback: { onlyUuid: identityClaim.target } } : {}),
        quietTokenFailure: firstInstallWithSharedId,
        ip: httpAuth.ip ?? null,
      });
    if (!auth.ok && auth.code === 'probe_token_invalid' && firstInstallWithSharedId && identityClaim) {
      // Only the shared ID is used from here: the legacy row (another
      // machine's) is never claimed nor touched. An unknown shared ID
      // registers a new pending probe; a known one passes its own checks.
      const viaTarget = await authenticateProbe({
        apiKey: apiKeyValue,
        probeUuid: identityClaim.target,
        probeToken: httpAuth.probeToken,
        features: httpAuth.features,
        allowUnknownProbe: true,
        ip: httpAuth.ip ?? null,
      });
      if (viaTarget.ok) {
        logger.info({ legacyUuid: probeUuid, target: identityClaim.target, tenantId: viaTarget.apiKey.tenant_id },
          'identity v2: legacy UUID held by another probe — first install enrolled under the shared device ID');
        auth = viaTarget;
        probeUuid = identityClaim.target;
        identityClaim = { target: identityClaim.target, claims: [] };
      } else {
        // Report the original refusal as usual (alert + audit on the legacy row).
        auth = await authenticateProbe({
          apiKey: apiKeyValue,
          probeUuid,
          probeToken: httpAuth.probeToken,
          features: httpAuth.features,
          allowUnknownProbe: true,
          aliasFallback: { onlyUuid: identityClaim.target },
          ip: httpAuth.ip ?? null,
        });
      }
    }
    if (!auth.ok) return pushFailure(auth.status, auth.code);

    const tenantId = auth.apiKey.tenant_id;
    let uuid = probeUuid.trim().toLowerCase();

    const parsed = parseProbePush(rawPayload);
    if (!parsed.ok) {
      if (warnOnce(`invalid-payload:${uuid}`)) {
        logger.warn({ probeUuid: uuid, tenantId, probeId: auth.probe?.id ?? null, error: parsed.error },
          'Probe push rejected: invalid payload');
      }
      if (auth.probe) recordPushError(tenantId, auth.probe.id, 'invalid_payload', await probeOptionalColumns());
      return pushFailure(400, 'invalid_payload', parsed.error);
    }
    const payload = parsed.data;
    if (parsed.droppedFlows > 0 && warnOnce(`dropped-flows:${uuid}`)) {
      logger.warn({ probeUuid: uuid, tenantId, dropped: parsed.droppedFlows }, 'Probe push: unparseable flow entries dropped');
    }
    if (parsed.droppedDevices > 0 && warnOnce(`dropped-devices:${uuid}`)) {
      logger.warn({ probeUuid: uuid, tenantId, dropped: parsed.droppedDevices },
        'Probe push: devices with a non-IPv4 address dropped');
    }

    const now = new Date();
    const columns = await probeOptionalColumns();

    // Identity v2: which row this push is about — the shared ID's row
    // (adopted from a claimed legacy row when allowed), a new row under the
    // shared ID, or the legacy row as before (v2 headers ignored, no ack).
    let authProbe: ProbeRow | null = auth.probe;
    let shouldIssueToken = auth.shouldIssueToken;
    let identityAck: string | null = null;
    let registerUnderTarget = false;
    if (identityClaim) {
      const ident = await probeIdentityService.resolvePush({
        tenantId,
        apiKeyId: auth.apiKey.id,
        probeToken: httpAuth.probeToken,
        hostname: payload.hostname,
        claim: identityClaim,
        authProbe: auth.probe,
        ip: httpAuth.ip ?? null,
      });
      if (ident.kind === 'probe') {
        if (ident.probe.id !== auth.probe?.id) {
          // Not the row authenticateProbe resolved: its own token state decides.
          shouldIssueToken = !ident.probe.token_hash && advertisesProbeToken(httpAuth.features);
        }
        authProbe = ident.probe;
        uuid = identityClaim.target;
        identityAck = identityClaim.target;
      } else if (ident.kind === 'register') {
        registerUnderTarget = true;
      }
    }

    // Find or register probe
    let probe: ProbeRow | null = null;
    let registeredNow = false;
    if (registerUnderTarget && identityClaim) {
      const registered = await this.registerProbe(auth.apiKey, identityClaim.target, payload, now, columns);
      if (registered.ok) {
        probe = registered.probe;
        registeredNow = true;
        uuid = identityClaim.target;
        identityAck = identityClaim.target;
      } else if (!authProbe) {
        return registered.failure;
      } else {
        // The legacy row keeps working exactly as a v1 push (no ack).
        logger.warn({ probeId: authProbe.id, target: identityClaim.target, code: registered.failure.error },
          'identity v2: registration under the shared ID failed — probe stays on its legacy UUID');
      }
    }
    if (probe) {
      // Registered under the shared ID just above.
    } else if (!authProbe) {
      const registered = await this.registerProbe(auth.apiKey, uuid, payload, now, columns);
      if (!registered.ok) return registered.failure;
      probe = registered.probe;
      registeredNow = true;
    } else {
      const current = authProbe;
      const versionChanged = current.probe_version !== payload.probeVersion;
      const updates: Record<string, unknown> = {
        hostname: payload.hostname,
        probe_version: payload.probeVersion,
        last_seen_at: now,
        updated_at: now,
      };
      if (payload.osInfo) updates.os_info = JSON.stringify(payload.osInfo);
      if (payload.probeMac) updates.mac = payload.probeMac;
      if (payload.probeIPs) updates.ips = JSON.stringify(payload.probeIPs);
      // Clear updating_since when the version changed (update done) or when
      // the probe still reports its old version well after (update aborted).
      if (current.updating_since) {
        const since = new Date(current.updating_since as Date | string).getTime();
        if (versionChanged || !Number.isFinite(since) || now.getTime() - since > UPDATING_STALE_MS) {
          updates.updating_since = null;
        }
      }
      // A new version reported: the last aborted update is history.
      // So is one of a probe that is no longer behind the server.
      if (columns.updateState && (current as { last_update_error?: unknown }).last_update_error != null
        && (versionChanged || !isProbeVersionOutdated(payload.probeVersion, this.getProbeVersion().version))) {
        Object.assign(updates, UPDATE_ERROR_CLEARED);
      }
      if (columns.capabilities) {
        if (payload.capabilities !== null) updates.capabilities = JSON.stringify(payload.capabilities);
        // A probe that stopped advertising (downgraded) has none any more.
        else if (versionChanged) updates.capabilities = null;
      }
      if (columns.serverScheme && payload.serverScheme) updates.server_scheme = payload.serverScheme;
      // Every push is one scan report (HTTP push and WS scan_result).
      if (columns.scanTelemetry) Object.assign(updates, scanTelemetryColumns(payload, now));

      await db('probes').where({ id: current.id, tenant_id: tenantId }).update(updates);
      // Refresh probe data
      const refreshed = await db('probes').where({ id: current.id, tenant_id: tenantId }).first() as ProbeRow | undefined;
      if (!refreshed) return pushFailure(404, 'probe_not_registered'); // deleted concurrently
      probe = refreshed;
    }

    const probeId = probe.id;
    const isApproved = probe.status === 'approved';

    // Register/update probe UUID with Obligate for cross-app linking
    // (non-blocking, idempotent, throttled) — approved probes only.
    if (isApproved) {
      obligateService.registerDeviceLink(probe.uuid, `/manage/probes/${probeId}`).catch(() => {});
    }

    // The probe's site, in the probe's tenant. A site_id pointing elsewhere
    // (assigned before assignments were checked) is ignored: nothing is
    // written into another tenant's site.
    let site: { id: number; name: string; group_id: number | null } | undefined;
    if (isApproved && probe.site_id) {
      site = await db('sites')
        .where({ id: probe.site_id, tenant_id: tenantId })
        .first('id', 'name', 'group_id');
      if (!site && warnOnce(`foreign-site:${probeId}`)) {
        logger.warn({ probeId, siteId: probe.site_id, tenantId }, 'Probe push: assigned site not found in the probe tenant — scan data ignored');
      }
    }
    const siteGroupId = (site?.group_id as number | null | undefined) ?? null;

    // ── Primary auto-election ──
    // An approved probe of a site without a primary becomes its primary. It
    // also takes over from a primary that is no longer approved, was reported
    // offline, or has been silent longer than its own offline threshold
    // (primaryNeedsFailover: the probe-offline job's rule, never a fixed delay).
    if (site) {
      const currentPrimary = await db('probes')
        .where({ site_id: site.id, tenant_id: tenantId, is_primary: true })
        .first() as Record<string, unknown> | undefined;

      if (!currentPrimary) {
        // No primary — promote this probe, unless a concurrent push of another
        // probe of the site was elected in the meantime.
        const promoted = await this.promoteIfSiteHasNoPrimary(tenantId, probeId, site.id);
        if (promoted) {
        probe.is_primary = true;
        logger.info({ probeId, siteId: site.id }, 'Auto-promoted probe to primary (no existing primary)');
        void auditService.log({
          tenantId,
          probeId,
          action: 'probe.primary_promoted',
          resourceType: 'probe',
          resourceId: probeId,
          details: { siteId: site.id, from: null, to: probeId, reason: 'no_primary' },
        });
        }
      } else if (
        Number(currentPrimary.id) !== probeId &&
        await this.primaryFailoverDue(currentPrimary, tenantId, site.id, siteGroupId, now.getTime())
      ) {
        const fromId = Number(currentPrimary.id);
        // Only the push that actually demoted the old primary promotes itself
        // (two secondaries pushing at once never both take the role).
        const demoted = await db('probes')
          .where({ id: fromId, tenant_id: tenantId, is_primary: true })
          .update({ is_primary: false });
        const promoted = demoted > 0 && await this.promoteIfSiteHasNoPrimary(tenantId, probeId, site.id);
        if (promoted) {
        probe.is_primary = true;
        logger.info(
          { probeId, oldPrimaryId: fromId, siteId: site.id },
          'Auto-promoted probe to primary (old primary unavailable)',
        );
        void auditService.log({
          tenantId,
          probeId,
          action: 'probe.primary_promoted',
          resourceType: 'probe',
          resourceId: probeId,
          details: { siteId: site.id, from: fromId, to: probeId, reason: 'failover' },
        });
        // The primary executes the site's device checks.
        await this.refreshDeviceCheckAssignments(tenantId, [site.id]);
        this.emitProbesUpdated(tenantId, [fromId, probeId]);
        } else if (demoted > 0) {
          // Another probe was elected between the two updates.
          await this.refreshDeviceCheckAssignments(tenantId, [site.id]);
          this.emitProbesUpdated(tenantId, [fromId]);
        }
      }
    }

    // Process discovered devices (approved probes with a site of their tenant only)
    if (site) {
      // One coalesced SITE_UPDATED per push for the site's readers, whatever
      // the number of changed devices (the admin room keeps the detail).
      const siteEvents = createSiteEventBatch(tenantId, site.id);
      // No device list at all (Go nil slice: nothing found) → nothing is
      // marked offline, as before.
      if (payload.discoveredDevices) {
        const processed = await processDevices(
          probeId,
          tenantId,
          site.id,
          siteGroupId,
          site.name ?? `Site #${site.id}`,
          payload.discoveredDevices,
          payload.probeMac,
          Boolean(probe.is_primary),
          siteEvents,
        ).catch((err) => {
          logger.error({ err }, 'Device processing failed');
          recordPushError(tenantId, probeId, 'device_processing_failed', columns);
          return null;
        });
        // Devices re-typed or with a new MAC: the Device Checks targets of the
        // site may have changed for every executor probe, not only this one.
        if (processed?.checkTargetsChanged) void this.refreshDeviceCheckAssignments(tenantId, [site.id]);
      }

      // Process network flows if present
      if (payload.discoveredFlows.length > 0) {
        await flowService.processFlows(tenantId, site.id, probeId, payload.discoveredFlows)
          .catch((err) => logger.error({ err }, 'Flow processing failed'));
      }

      siteEvents.flush();
    }

    // Deliver pending command (one-shot). Over the WS it goes out as a
    // `command` message and stays queued until that send succeeded: probes
    // built before config_update carried commands read only its config and
    // latestVersion, so a command inside it would be lost. Over HTTP it rides
    // in the response and is cleared here.
    let command = probe.pending_command ?? null;
    if (command && viaWs) {
      await this.deliverCommand(tenantId, probeId, command as ProbeCommand)
        .catch((err) => logger.warn({ err: (err as Error)?.message, probeId }, 'Queued probe command delivery failed'));
      command = null;
    } else if (command) {
      const updateStarts = command === 'update';
      await db('probes').where({ id: probeId, tenant_id: tenantId }).update({
        pending_command: null,
        updated_at: now,
        ...(command === 'uninstall' ? { uninstall_commanded_at: now } : {}),
        ...(updateStarts ? { updating_since: now } : {}),
        ...(updateStarts && columns.updateState ? UPDATE_ERROR_CLEARED : {}),
      });
    }

    const config = await this.buildEffectiveConfig(tenantId, probeId, {
      probeRow: probe,
      ...(site ? { siteGroupId } : {}),
    });
    if (!config) return pushFailure(404, 'probe_not_registered');

    // Identity token (trust on first use), only to a probe that advertises
    // the feature and holds none yet. The WS path issues it on the socket.
    let probeToken: string | null = null;
    const issue = registeredNow ? (!viaWs && advertisesProbeToken(httpAuth.features)) : shouldIssueToken;
    if (issue) {
      try {
        probeToken = await issueProbeToken(probeId);
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, probeId }, 'Probe identity token issuance failed');
      }
    }

    return {
      httpStatus: probe.status === 'pending' ? 202 : 200,
      status: probe.status,
      config,
      latestVersion: await this.latestVersionFor(tenantId, probe),
      command,
      role: probe.is_primary ? 'primary' as const : 'secondary' as const,
      ...(probeToken ? { probeToken } : {}),
      ...(identityAck ? { identityAck } : {}),
    };
  }

  /** First push of an unknown UUID: registers it as pending. */
  private async registerProbe(
    apiKey: ProbeApiKeyRef,
    uuid: string,
    payload: ProbePushPayload,
    now: Date,
    columns: ProbeOptionalColumns,
  ): Promise<{ ok: true; probe: ProbeRow } | { ok: false; failure: ProbePushFailure }> {
    const tenantId = apiKey.tenant_id;
    // The new probe is bound to the key it registered with (probeAuth.service
    // refuses any other key for this UUID from now on).
    const boundKeyId = apiKey.id;

    const row: Record<string, unknown> = {
      uuid,
      hostname: payload.hostname,
      ip: null,
      mac: payload.probeMac,
      ips: payload.probeIPs ? JSON.stringify(payload.probeIPs) : null,
      os_info: payload.osInfo ? JSON.stringify(payload.osInfo) : null,
      probe_version: payload.probeVersion,
      api_key_id: boundKeyId,
      status: 'pending',
      tenant_id: tenantId,
      site_id: null,
      name: payload.hostname.slice(0, 128),
      scan_interval_seconds: 300,
      scan_config: JSON.stringify({ excludedSubnets: [], extraSubnets: [] }),
      // New probes follow the scan settings of their site / group chain.
      scan_config_override: false,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    };
    if (columns.capabilities && payload.capabilities !== null) row.capabilities = JSON.stringify(payload.capabilities);
    if (columns.serverScheme && payload.serverScheme) row.server_scheme = payload.serverScheme;
    if (columns.scanTelemetry) Object.assign(row, scanTelemetryColumns(payload, now));

    // The pending count and the insert run under a per-key advisory lock:
    // concurrent registrations of one key (many fresh UUIDs at once) cannot
    // overshoot the cap.
    let registered: { probe: ProbeRow } | { pending: number };
    try {
      registered = await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`oblimap:probe-register:${boundKeyId}`]);
        const [{ count }] = await trx('probes')
          .where({ api_key_id: boundKeyId, tenant_id: tenantId, status: 'pending' })
          .count<{ count: string | number }[]>('id as count');
        if (Number(count) >= MAX_PENDING_PROBES_PER_KEY) return { pending: Number(count) };
        const [inserted] = await trx('probes').insert(row).returning('*') as ProbeRow[];
        return { probe: inserted };
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      // probes.uuid is globally unique: registered concurrently, here or in another tenant.
      if (code === '23505') return { ok: false, failure: pushFailure(409, 'uuid_conflict') };
      // The API key was deleted meanwhile (probes.api_key_id foreign key).
      if (code === '23503') return { ok: false, failure: pushFailure(401, 'invalid_key') };
      throw err;
    }
    if (!('probe' in registered)) {
      if (warnOnce(`pending-limit:${boundKeyId}`)) {
        logger.warn({ tenantId, keyId: boundKeyId, pending: registered.pending },
          `Probe registration refused: ${MAX_PENDING_PROBES_PER_KEY} probes of this API key are already pending approval`);
      }
      return { ok: false, failure: pushFailure(409, 'pending_limit') };
    }
    const probe = registered.probe;

    _io
      ?.to(tenantAdminEventRooms(tenantId, 'probes.manage'))
      .emit(SOCKET_EVENTS.PROBE_STATUS_CHANGED, {
        probeId: probe.id,
        status: 'pending',
        uuid,
      });

    logger.info(
      { uuid, hostname: payload.hostname, tenantId },
      'New probe registered (pending)',
    );
    return { ok: true, probe };
  }

  /**
   * WS hello of a connected, registered probe (identity from its connection,
   * authenticated at the upgrade): stores the capabilities and server scheme
   * it announces and returns the config_update answering it — its effective
   * config, Device Checks assignment included when it advertises the
   * capability. Null when the probe no longer exists in that tenant, is
   * refused / suspended or is bound to another API key.
   */
  async handleHello(
    tenantId: number,
    probeId: number,
    apiKeyId: number,
    hello: ProbeHello,
  ): Promise<ProbeHelloReply | null> {
    const columns = await probeOptionalColumns();
    const updates: Record<string, unknown> = {};
    if (columns.capabilities) updates.capabilities = JSON.stringify(hello.capabilities);
    if (columns.serverScheme && hello.serverScheme) updates.server_scheme = hello.serverScheme;

    const scope = () => db('probes')
      .where({ id: probeId, tenant_id: tenantId, api_key_id: apiKeyId })
      .whereNotIn('status', ['refused', 'suspended']);
    let row: Record<string, unknown> | undefined;
    if (Object.keys(updates).length > 0) {
      [row] = await scope().update(updates).returning('*') as Record<string, unknown>[];
    } else {
      row = await scope().first() as Record<string, unknown> | undefined;
    }
    if (!row) return null;

    const config = await this.buildEffectiveConfig(tenantId, probeId, { probeRow: row });
    if (!config) return null;
    return {
      status: String(row.status),
      config,
      latestVersion: await this.latestVersionFor(tenantId, row),
      command: null,
    };
  }

  /**
   * latestVersion for a probe's push response, hello reply or config_update:
   * the server's probe version when the probe is approved, runs an older
   * version and its update policy is 'auto' (shouldAnnounceLatestVersion);
   * null otherwise. Probes ignore a null / missing latestVersion. The policy
   * is resolved only when there is something to install. Never throws.
   */
  async latestVersionFor(
    tenantId: number,
    row: { status?: unknown; probe_version?: unknown; site_id?: unknown },
  ): Promise<string | null> {
    if (row.status !== 'approved') return null;
    const latest = this.getProbeVersion().version;
    if (!isProbeVersionOutdated(row.probe_version, latest)) return null;
    const { policy } = await resolveProbeUpdatePolicy(tenantId, row.site_id);
    return shouldAnnounceLatestVersion(row.status, policy) ? latest : null;
  }

  // ── API Keys ──────────────────────────────────────────────────────────────

  /** The tenant's keys with their probe count and default site (name in the tenant only). */
  async getApiKeys(tenantId: number): Promise<ProbeApiKey[]> {
    const withDefaultSite = await hasKeyDefaultSiteColumn();
    const probeCount = db('probes')
      .count('*')
      .whereRaw('probes.api_key_id = k.id')
      .andWhere('probes.tenant_id', tenantId)
      .as('probe_count');
    const query = db('probe_api_keys as k')
      .where('k.tenant_id', tenantId)
      .orderBy('k.created_at', 'asc')
      .select('k.*', probeCount);
    if (withDefaultSite) {
      query
        .leftJoin('sites as ds', function () {
          this.on('ds.id', '=', 'k.default_site_id').andOn('ds.tenant_id', '=', 'k.tenant_id');
        })
        .select('ds.name as default_site_name');
    }
    const rows = await query as Array<Record<string, unknown>>;
    // A default site outside the tenant (never written by these routes) is ignored.
    return rows.map((r) => rowToApiKey(r.default_site_name == null ? { ...r, default_site_id: null } : r));
  }

  private async getApiKey(tenantId: number, id: number): Promise<ProbeApiKey | null> {
    return (await this.getApiKeys(tenantId)).find((k) => k.id === id) ?? null;
  }

  /** A site id of this tenant, or 404. */
  private async requireTenantSite(tenantId: number, siteId: number): Promise<number> {
    const site = await db('sites').where({ id: siteId, tenant_id: tenantId }).first('id');
    if (!site) throw new AppError(404, 'Site not found');
    return Number(site.id);
  }

  /** The default site must be a site of the tenant (404). */
  async createApiKey(
    tenantId: number,
    name: string,
    createdBy: number,
    defaultSiteId: number | null = null,
  ): Promise<ProbeApiKey> {
    const row: Record<string, unknown> = { name, tenant_id: tenantId, created_by: createdBy };
    if (defaultSiteId != null) {
      if (!(await hasKeyDefaultSiteColumn())) throw new AppError(503, 'Database migration pending (default site)');
      row.default_site_id = await this.requireTenantSite(tenantId, defaultSiteId);
    }
    const { randomUUID } = await import('node:crypto');
    row.key = randomUUID();
    const [inserted] = await db('probe_api_keys').insert(row).returning('id');
    const id = Number((inserted as { id: number }).id ?? inserted);
    const key = await this.getApiKey(tenantId, id);
    if (!key) throw new AppError(500, 'API key creation failed');
    return key;
  }

  /**
   * Renames a key and / or sets its default site (a site of the tenant, 404;
   * null clears it). Null when the key is not in that tenant.
   */
  async updateApiKey(
    tenantId: number,
    id: number,
    updates: { name?: string; defaultSiteId?: number | null },
  ): Promise<{ key: ProbeApiKey; previous: { name: string; defaultSiteId: number | null } } | null> {
    const withDefaultSite = await hasKeyDefaultSiteColumn();
    const existing = await db('probe_api_keys').where({ id, tenant_id: tenantId }).first() as Record<string, unknown> | undefined;
    if (!existing) return null;
    const patch: Record<string, unknown> = {};
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.defaultSiteId !== undefined) {
      if (!withDefaultSite) throw new AppError(503, 'Database migration pending (default site)');
      patch.default_site_id = updates.defaultSiteId === null
        ? null
        : await this.requireTenantSite(tenantId, updates.defaultSiteId);
    }
    if (Object.keys(patch).length > 0) {
      await db('probe_api_keys').where({ id, tenant_id: tenantId }).update(patch);
    }
    const key = await this.getApiKey(tenantId, id);
    if (!key) return null;
    return {
      key,
      previous: { name: String(existing.name), defaultSiteId: toDbId(existing.default_site_id) ?? null },
    };
  }

  /**
   * Deletes a key and cuts off every probe using it (their api_key_id
   * becomes NULL; they are refused until reinstalled with another key).
   * Returns null when the key is not in that tenant.
   */
  async deleteApiKey(tenantId: number, id: number): Promise<{ name: string; disconnected: number } | null> {
    const key = await db('probe_api_keys').where({ id, tenant_id: tenantId }).first('id', 'name');
    if (!key) return null;
    const boundProbeIds = await db('probes')
      .where({ api_key_id: id, tenant_id: tenantId })
      .pluck('id') as number[];
    const deleted = await db('probe_api_keys').where({ id, tenant_id: tenantId }).delete();
    if (!deleted) return null;
    const disconnected = await closeProbeConnections(boundProbeIds, { apiKeyId: id, tenantId });
    return { name: key.name as string, disconnected };
  }

  // ── Probe CRUD ────────────────────────────────────────────────────────────

  /** Probe rows of the tenant with the name of their API key (key of the same tenant only). */
  private probeRows(tenantId: number) {
    return db('probes as p')
      .leftJoin('probe_api_keys as k', function () {
        this.on('k.id', '=', 'p.api_key_id').andOn('k.tenant_id', '=', 'p.tenant_id');
      })
      .where('p.tenant_id', tenantId)
      .select('p.*', 'k.name as api_key_name');
  }

  async getProbes(tenantId: number): Promise<Probe[]> {
    const rows = await this.probeRows(tenantId).orderBy('p.created_at', 'asc') as Array<Record<string, unknown>>;
    return rows.map((r) => rowToProbe(r, isProbeWsConnected(r.id as number)));
  }

  async getProbe(tenantId: number, id: number): Promise<Probe | null> {
    const row = await this.probeRows(tenantId).where('p.id', id).first() as Record<string, unknown> | undefined;
    return row ? rowToProbe(row, isProbeWsConnected(id)) : null;
  }

  /** PROBE_DEVICE_UPDATED {probeId} per probe to the tenant's probes.manage holders (ids only). */
  private emitProbesUpdated(tenantId: number, ids: Iterable<number>): void {
    if (!_io) return;
    const rooms = tenantAdminEventRooms(tenantId, 'probes.manage');
    for (const probeId of new Set(ids)) {
      _io.to(rooms).emit(SOCKET_EVENTS.PROBE_DEVICE_UPDATED, { probeId });
    }
  }

  /** PROBE_DEVICE_DELETED {probeId} per probe to the tenant's probes.manage holders. */
  private emitProbesDeleted(tenantId: number, ids: Iterable<number>): void {
    if (!_io) return;
    const rooms = tenantAdminEventRooms(tenantId, 'probes.manage');
    for (const probeId of new Set(ids)) {
      _io.to(rooms).emit(SOCKET_EVENTS.PROBE_DEVICE_DELETED, { probeId });
    }
  }

  /**
   * The primary failover rule (primaryNeedsFailover) applied to the current
   * primary of a site, its threshold resolved like the probe-offline job's
   * (settings resolved only when its silence could exceed one).
   */
  private async primaryFailoverDue(
    primary: Record<string, unknown>,
    tenantId: number,
    siteId: number,
    siteGroupId: number | null,
    now: number,
  ): Promise<boolean> {
    const primaryId = Number(primary.id);
    const wsConnected = isProbeWsConnected(primaryId);
    const silenceMs = probeSilenceMs(primary.last_seen_at, now, livenessEpochFor(primaryId));
    let thresholdMs = Number.POSITIVE_INFINITY;
    if (primary.status === 'approved' && activeOfflineSince(primary) === null && !wsConnected && silenceMs >= PROBE_SILENCE_MIN_MS) {
      const settings = await livenessSettings({ id: primaryId, tenant_id: tenantId, site_row_id: siteId, site_group_id: siteGroupId });
      thresholdMs = probeSilenceThresholdMs({
        scan_interval_seconds: (primary.scan_interval_seconds as number | null) ?? null,
        scan_config_override: (primary.scan_config_override as boolean | null) ?? null,
      }, settings);
    }
    return primaryNeedsFailover(primary, wsConnected, silenceMs, thresholdMs);
  }

  /**
   * Sets is_primary on an approved probe only while its site has no primary
   * (guards concurrent elections). True when the row was promoted.
   */
  private async promoteIfSiteHasNoPrimary(tenantId: number, probeId: number, siteId: number): Promise<boolean> {
    const promoted = await db('probes')
      .where({ id: probeId, tenant_id: tenantId, site_id: siteId, status: 'approved' })
      .whereNotExists(function () {
        this.select(db.raw('1')).from('probes as other')
          .where('other.site_id', siteId)
          .andWhere('other.tenant_id', tenantId)
          .andWhere('other.is_primary', true);
      })
      .update({ is_primary: true });
    return promoted > 0;
  }

  /**
   * Gives a site without a primary one (after an approval, suspension or
   * reactivation): its approved probe connected over the WebSocket, else the
   * one not reported offline, most recently seen first. Nothing when the
   * site has a primary or no approved probe. Returns the promoted id.
   */
  private async electPrimaryIfNone(tenantId: number, siteId: number | null | undefined): Promise<number | null> {
    const sid = toDbId(siteId);
    if (sid === null) return null;
    const existing = await db('probes').where({ site_id: sid, tenant_id: tenantId, is_primary: true }).first('id');
    if (existing) return null;
    const candidates = await db('probes')
      .where({ site_id: sid, tenant_id: tenantId, status: 'approved' })
      .select('id', 'offline_alerted_at', 'last_seen_at') as Array<{ id: number; offline_alerted_at: unknown; last_seen_at: unknown }>;
    if (candidates.length === 0) return null;
    const rank = (c: typeof candidates[number]): number =>
      (isProbeWsConnected(c.id) ? 2 : 0) + (activeOfflineSince(c) === null && c.last_seen_at != null ? 1 : 0);
    const seenAt = (c: typeof candidates[number]): number => {
      const t = c.last_seen_at == null ? NaN : new Date(c.last_seen_at as string | Date).getTime();
      return Number.isFinite(t) ? t : 0;
    };
    candidates.sort((a, b) => rank(b) - rank(a) || seenAt(b) - seenAt(a) || a.id - b.id);
    const chosen = candidates[0].id;
    // Only while the site still has no primary (a concurrent push may have elected one).
    if (!await this.promoteIfSiteHasNoPrimary(tenantId, chosen, sid)) return null;
    logger.info({ probeId: chosen, siteId: sid }, 'Elected probe as primary of its site');
    void auditService.log({
      tenantId,
      probeId: chosen,
      action: 'probe.primary_promoted',
      resourceType: 'probe',
      resourceId: chosen,
      details: { siteId: sid, from: null, to: chosen, reason: 'election' },
    });
    return chosen;
  }

  /**
   * After a probe got (or lost) a site or its approval: elects a primary where
   * none is left, re-sends the Device Checks assignments of these sites and
   * the probe's own config when it is connected (as updateProbe does).
   */
  private async afterProbeAssignmentChange(tenantId: number, probeIds: number[], siteIds: Array<number | null | undefined>): Promise<void> {
    const sites = [...new Set(siteIds.map((s) => toDbId(s)).filter((s): s is number => s !== null))];
    const elected: number[] = [];
    for (const sid of sites) {
      try {
        const id = await this.electPrimaryIfNone(tenantId, sid);
        if (id !== null) elected.push(id);
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, tenantId, siteId: sid }, 'Primary election failed');
      }
    }
    const { lastConfigUpdateSeq } = await import('./probeHub.service');
    const before = new Map(probeIds.map((id) => [id, lastConfigUpdateSeq(id)]));
    await this.refreshDeviceCheckAssignments(tenantId, sites);
    const uncovered = probeIds.filter((id) => lastConfigUpdateSeq(id) === before.get(id));
    if (uncovered.length > 0) await this.pushConfigToProbes(tenantId, uncovered);
    if (elected.length > 0) this.emitProbesUpdated(tenantId, elected);
  }

  /** `updates` is validated by updateProbeSchema. The site must be in the tenant (404). */
  async updateProbe(
    tenantId: number,
    id: number,
    updates: UpdateProbeInput,
  ): Promise<Probe | null> {
    const existing = await db('probes').where({ id, tenant_id: tenantId }).first('id', 'site_id', 'is_primary', 'scan_config');
    if (!existing) return null;

    // Extra subnets wider than /16: refused when new, kept when already stored.
    if (updates.scanConfig !== undefined
      && newTooWideExtraSubnet(updates.scanConfig.extraSubnets, existing.scan_config) >= 0) {
      throw new AppError(400, 'subnet_too_wide');
    }

    if (updates.siteId != null) {
      const site = await db('sites').where({ id: updates.siteId, tenant_id: tenantId }).first('id');
      if (!site) throw new AppError(404, 'Site not found');
    }

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.siteId !== undefined) patch.site_id = updates.siteId;
    if (updates.scanIntervalSeconds !== undefined)
      patch.scan_interval_seconds = updates.scanIntervalSeconds;
    if (updates.scanConfig !== undefined)
      patch.scan_config = JSON.stringify(updates.scanConfig);
    if (updates.scanConfigOverride !== undefined)
      patch.scan_config_override = updates.scanConfigOverride;
    if (updates.isPrimary !== undefined) {
      patch.is_primary = updates.isPrimary;
      // If promoting to primary, demote any existing primary on the (new) site
      const targetSiteId = updates.siteId !== undefined ? updates.siteId : (existing.site_id as number | null);
      if (updates.isPrimary && targetSiteId) {
        await db('probes')
          .where({ site_id: targetSiteId, tenant_id: tenantId, is_primary: true })
          .whereNot({ id })
          .update({ is_primary: false });
      }
    }

    await db('probes').where({ id, tenant_id: tenantId }).update(patch);

    // A new site or primary changes which probe executes the device checks
    // of the old and new sites (the demoted primary included). That push also
    // sends this probe its config when it is connected, approved and capable.
    const oldSiteId = toDbId(existing.site_id);
    const newSiteId = updates.siteId !== undefined ? updates.siteId : oldSiteId;
    const executorsChanged = (updates.siteId !== undefined && updates.siteId !== oldSiteId)
      || (updates.isPrimary !== undefined && updates.isPrimary !== Boolean(existing.is_primary));
    const { lastConfigUpdateSeq } = await import('./probeHub.service');
    const configSeqBefore = lastConfigUpdateSeq(id);
    if (executorsChanged) await this.refreshDeviceCheckAssignments(tenantId, [oldSiteId, newSiteId]);

    // If probe is WS-connected, push config update immediately — unless the
    // device checks push above delivered one (it skips this probe when it is
    // not capable, and may fail).
    const coveredByChecksPush = executorsChanged && lastConfigUpdateSeq(id) !== configSeqBefore;
    if (!coveredByChecksPush) await this.pushConfigToProbes(tenantId, [id]);

    this.emitProbesUpdated(tenantId, [id]);
    return this.getProbe(tenantId, id);
  }

  /**
   * Sends a fresh config_update — the full effective config, with the Device
   * Checks assignment for capable probes — to those of these probes of the
   * tenant that are WS-connected. Also for probes no longer attached to a
   * site (site deleted, probe detached), which pushConfigToAffectedProbes,
   * selecting probes by site, does not reach. Probes in HTTP mode get their
   * config with their next push. Returns how many were sent one; never throws.
   */
  async pushConfigToProbes(tenantId: number, probeIds: number[]): Promise<number> {
    let sent = 0;
    try {
      const { isProbeConnected, sendToProbe } = await import('./probeHub.service');
      const ids = [...new Set(validDbIds(probeIds))].filter((pid) => isProbeConnected(pid));
      if (ids.length === 0) return 0;
      const rows = await db('probes').where({ tenant_id: tenantId }).whereIn('id', ids).select('*') as Array<Record<string, unknown>>;
      for (const row of rows) {
        const probeId = Number(row.id);
        try {
          const effectiveConfig = await this.buildEffectiveConfig(tenantId, probeId, { probeRow: row });
          if (!effectiveConfig) continue;
          const delivered = sendToProbe(probeId, {
            type: 'config_update',
            status: row.status,
            config: effectiveConfig,
            latestVersion: await this.latestVersionFor(tenantId, row),
            command: null,
          });
          if (delivered) sent++;
        } catch (err) {
          logger.warn({ err: (err as Error)?.message, probeId, tenantId }, 'Probe config push failed');
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, tenantId }, 'Probe config push failed');
    }
    return sent;
  }

  /**
   * Re-sends the Device Checks assignment to the connected probes of these
   * sites after a change of which probes may execute their checks (site
   * move, primary, approval, refusal, deletion). Probes in HTTP mode get it
   * with their next push. Never throws.
   */
  private async refreshDeviceCheckAssignments(tenantId: number, siteIds: Array<number | null | undefined>): Promise<void> {
    const ids = [...new Set(siteIds.filter((s): s is number => typeof s === 'number' && s > 0))];
    if (ids.length === 0) return;
    try {
      await pushConfigToAffectedProbes(tenantId, ids);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, tenantId, siteIds: ids }, 'Device checks config push after a probe change failed');
    }
  }

  /**
   * The probe's Device Checks assignment (undefined for a probe without the
   * capability). A failed build leaves the field out — the probe then stops
   * its checks until the next config — instead of failing the whole config:
   * scan settings and commands must keep flowing.
   */
  private async deviceChecksConfigFor(
    tenantId: number,
    probe: Record<string, unknown>,
    siteRow: Record<string, unknown> | null,
  ): Promise<ProbeDeviceChecksConfig | undefined> {
    try {
      return await buildProbeChecksConfig(tenantId, probe, siteRow);
    } catch (err) {
      if (warnOnce(`device-checks-config:${String(probe.id)}`)) {
        logger.warn({ err: (err as Error)?.message, probeId: probe.id, tenantId },
          'Device checks assignment could not be built — config sent without it');
      }
      return undefined;
    }
  }

  /**
   * Build the effective config for a probe (used by the HTTP push, the WS
   * config_update after a scan or a hello, and the Device Checks config
   * pushes). `probeRow` avoids re-reading a row the caller holds;
   * `siteGroupId` a site lookup the caller already did (tenant-scoped).
   * `deviceChecks` is appended only for probes that advertise the capability.
   */
  async buildEffectiveConfig(
    tenantId: number,
    probeId: number,
    opts: { probeRow?: Record<string, unknown>; siteGroupId?: number | null } = {},
  ): Promise<ProbeEffectiveConfig | null> {
    const probe = opts.probeRow ?? await db('probes').where({ id: probeId, tenant_id: tenantId }).first();
    if (!probe) return null;

    const config = await this.buildScanConfig(tenantId, probeId, probe, opts.siteGroupId);
    const deviceChecks = await this.deviceChecksConfigFor(tenantId, probe, config.siteRow);
    return deviceChecks ? { ...config.effective, deviceChecks } : config.effective;
  }

  /**
   * Scan settings of the effective config (computeScanConfig). Also returns
   * the probe's site in its tenant ({id, group_id}) when it was looked up or
   * given — null when it is unknown or not in the tenant — the source of
   * each value and, when it was resolved (inheriting probes, or
   * `alwaysResolve`), the settings chain of the probe.
   */
  private async buildScanConfig(
    tenantId: number,
    probeId: number,
    probe: Record<string, unknown>,
    knownSiteGroupId: number | null | undefined,
    opts: { alwaysResolve?: boolean } = {},
  ): Promise<ScanConfigResolution & { siteRow: Record<string, unknown> | null; resolved: ResolvedSettings | null }> {
    const siteId = (probe.site_id as number | null) ?? null;
    // Given by the caller only for a site it verified in the tenant.
    let siteRow: Record<string, unknown> | null = siteId !== null && knownSiteGroupId !== undefined
      ? { id: siteId, group_id: knownSiteGroupId }
      : null;

    // flowAnalysisEnabled is always resolved from the settings chain (site/group level),
    // never from the probe's own scan_config — it's a site-level feature toggle.
    let flow: SettingValue | null = null;
    if (siteId) {
      try {
        const siteSettings = await settingsService.resolveForSite(tenantId, siteId);
        flow = siteSettings.flowAnalysisEnabled ?? null;
      } catch { /* ignore */ }
    }

    const useScanConfigOverride = (probe.scan_config_override as boolean | undefined) ?? true;
    let resolved: ResolvedSettings | null = null;
    if (!useScanConfigOverride || opts.alwaysResolve) {
      let siteGroupId: number | null = null;
      if (siteRow) {
        siteGroupId = (siteRow.group_id as number | null) ?? null;
      } else if (siteId) {
        const site = await db('sites').where({ id: siteId, tenant_id: tenantId }).first('id', 'group_id') as
          { id: number; group_id: number | null } | undefined;
        siteRow = site ? { id: site.id, group_id: site.group_id ?? null } : null;
        siteGroupId = site?.group_id ?? null;
      }
      // A site outside the tenant is ignored (as for scan data).
      resolved = await settingsService.resolveForProbe(tenantId, probeId, siteRow ? siteId : null, siteGroupId);
    }

    return { ...computeScanConfig(probe, resolved, flow), siteRow, resolved };
  }

  /**
   * GET /probe/devices/:id/effective-config: the scan config exactly as the
   * probe receives it (same computation as its pushes / config_update), with
   * the source of each value, plus the settings chain resolved for the probe
   * (what a probe-level settings panel edits). The Device Checks assignment
   * is summarised (never its targets or credentials). Null when the probe is
   * not in the tenant.
   */
  async describeEffectiveConfig(tenantId: number, probeId: number): Promise<{
    scanConfigOverride: boolean;
    config: Omit<ProbeEffectiveConfig, 'deviceChecks'>;
    sources: ScanConfigResolution['sources'];
    resolved: ResolvedSettings;
    deviceChecks: { rev: string; rules: number; targets: number } | null;
    /** probeUpdatePolicy in effect for the probe (its site chain) and where it comes from. */
    updatePolicy: ProbeUpdatePolicyResolution;
  } | null> {
    const probe = await db('probes').where({ id: probeId, tenant_id: tenantId }).first() as Record<string, unknown> | undefined;
    if (!probe) return null;
    const scan = await this.buildScanConfig(tenantId, probeId, probe, undefined, { alwaysResolve: true });
    const checks = await this.deviceChecksConfigFor(tenantId, probe, scan.siteRow);
    return {
      scanConfigOverride: (probe.scan_config_override as boolean | undefined) ?? true,
      config: scan.effective,
      sources: scan.sources,
      resolved: scan.resolved!,
      deviceChecks: checks ? summarizeChecksConfig(checks) : null,
      updatePolicy: await resolveProbeUpdatePolicy(tenantId, scan.siteRow ? probe.site_id : null),
    };
  }

  /**
   * Default site of an API key, when it is a site of the tenant (null when
   * none, or before migration 045).
   */
  private async keyDefaultSiteId(tenantId: number, apiKeyId: unknown): Promise<number | null> {
    const keyId = toDbId(apiKeyId);
    if (keyId === null || !(await hasKeyDefaultSiteColumn())) return null;
    const row = await db('probe_api_keys as k')
      .join('sites as s', function () {
        this.on('s.id', '=', 'k.default_site_id').andOn('s.tenant_id', '=', 'k.tenant_id');
      })
      .where({ 'k.id': keyId, 'k.tenant_id': tenantId })
      .first('s.id as site_id') as { site_id: number } | undefined;
    return row ? Number(row.site_id) : null;
  }

  /**
   * Site a probe being approved lands on: `requested` (a site of the tenant,
   * else 404), else — when the probe has none (or one outside its tenant) —
   * the default site of its API key. Undefined: the site is left as it is.
   */
  private async approvalSite(
    tenantId: number,
    row: { site_id: unknown; api_key_id: unknown },
    requested: number | undefined,
  ): Promise<number | undefined> {
    if (requested !== undefined) return this.requireTenantSite(tenantId, requested);
    const current = toDbId(row.site_id);
    if (current !== null) {
      const inTenant = await db('sites').where({ id: current, tenant_id: tenantId }).first('id');
      if (inTenant) return undefined;
    }
    return (await this.keyDefaultSiteId(tenantId, row.api_key_id)) ?? undefined;
  }

  /**
   * Approves a probe (pending, refused or already approved — the single
   * action re-approves). `siteId` assigns that site of the tenant (404
   * otherwise); without it a probe that has no site gets its API key's
   * default site. A site change drops a stale primary role; a primary is
   * then elected where none is left and the Device Checks assignments and
   * the probe's config are re-sent. Null when the probe is not in the tenant.
   */
  async approveProbe(tenantId: number, id: number, approvedBy: number, siteId?: number): Promise<Probe | null> {
    const row = await db('probes').where({ id, tenant_id: tenantId }).first('id', 'site_id', 'api_key_id') as
      { id: number; site_id: number | null; api_key_id: number | null } | undefined;
    if (!row) return null;
    const targetSite = await this.approvalSite(tenantId, row, siteId);
    const oldSiteId = toDbId(row.site_id);
    const siteChanged = targetSite !== undefined && targetSite !== oldSiteId;

    const now = new Date();
    markProbesReactivated([id], now.getTime());
    const updated = await db('probes').where({ id, tenant_id: tenantId }).update({
      status: 'approved',
      approved_by: approvedBy,
      approved_at: now,
      updated_at: now,
      ...(siteChanged ? { site_id: targetSite, is_primary: false } : {}),
    });
    if (!updated) return null;
    _io
      ?.to(tenantAdminEventRooms(tenantId, 'probes.manage'))
      .emit(SOCKET_EVENTS.PROBE_APPROVED, { probeId: id });
    // An approved probe may now execute device checks of its site (and be its primary).
    await this.afterProbeAssignmentChange(tenantId, [id], [oldSiteId, siteChanged ? targetSite : oldSiteId]);
    return this.getProbe(tenantId, id);
  }

  /**
   * Creates (or reuses, by exact name, case-insensitive) one site per entry
   * and attaches its probes: the chosen one primary, the others secondary.
   * Every probe must be of the tenant, unassigned (no site) and pending or
   * approved; pending ones are approved when approvePending (else refused).
   * All or nothing (one transaction); the device-check / config pushes follow.
   */
  async createSitesFromProbes(
    tenantId: number,
    userId: number,
    input: { groupId: number | null; approvePending: boolean; sites: Array<{ name: string; probeIds: number[]; primaryProbeId: number }> },
  ): Promise<{ sites: Array<{ siteId: number; name: string; created: boolean; probeIds: number[]; primaryProbeId: number }> }> {
    if (input.groupId !== null) {
      const group = await db('monitor_groups').where({ id: input.groupId, tenant_id: tenantId }).first('id');
      if (!group) throw new AppError(400, 'Group not found');
    }
    const allIds = input.sites.flatMap((s) => s.probeIds);
    const now = new Date();
    const result = await db.transaction(async (trx) => {
      const rows = await trx('probes').where({ tenant_id: tenantId }).whereIn('id', allIds).forUpdate()
        .select('id', 'site_id', 'status') as Array<{ id: number; site_id: number | null; status: string }>;
      const byId = new Map(rows.map((r) => [Number(r.id), r]));
      for (const id of allIds) {
        const row = byId.get(id);
        if (!row) throw new AppError(404, `Probe #${id} not found`);
        if (row.site_id !== null) throw new AppError(409, `Probe #${id} is already assigned to a site`);
        if (row.status !== 'approved' && row.status !== 'pending') throw new AppError(409, `Probe #${id} is ${row.status}`);
        if (row.status === 'pending' && !input.approvePending) throw new AppError(409, `Probe #${id} is pending approval`);
      }
      const out: Array<{ siteId: number; name: string; created: boolean; probeIds: number[]; primaryProbeId: number }> = [];
      for (const s of input.sites) {
        const name = s.name.trim();
        const existing = await trx('sites').where({ tenant_id: tenantId }).whereRaw('lower(name) = lower(?)', [name])
          .orderBy('id').first('id', 'name') as { id: number; name: string } | undefined;
        let siteId: number;
        if (existing) {
          siteId = Number(existing.id);
        } else {
          const [created] = await trx('sites')
            .insert({ name, description: null, group_id: input.groupId, tenant_id: tenantId })
            .returning('id') as Array<{ id: number }>;
          siteId = Number(created.id);
        }
        // An existing site keeps its primary: the new probes join as secondaries.
        const hasPrimary = existing
          ? !!(await trx('probes').where({ tenant_id: tenantId, site_id: siteId, is_primary: true }).first('id'))
          : false;
        for (const pid of s.probeIds) {
          const pending = byId.get(pid)!.status === 'pending';
          await trx('probes').where({ id: pid, tenant_id: tenantId }).update({
            site_id: siteId,
            is_primary: !hasPrimary && pid === s.primaryProbeId,
            updated_at: now,
            ...(pending ? { status: 'approved', approved_by: userId, approved_at: now } : {}),
          });
        }
        out.push({ siteId, name: existing ? existing.name : name, created: !existing, probeIds: s.probeIds, primaryProbeId: hasPrimary ? 0 : s.primaryProbeId });
      }
      return out;
    });

    const approvedNow = allIds;
    markProbesReactivated(approvedNow, now.getTime());
    const rooms = tenantAdminEventRooms(tenantId, 'probes.manage');
    for (const probeId of approvedNow) _io?.to(rooms).emit(SOCKET_EVENTS.PROBE_APPROVED, { probeId });
    await this.afterProbeAssignmentChange(tenantId, approvedNow, result.map((s) => s.siteId));
    this.emitProbesUpdated(tenantId, approvedNow);
    return { sites: result };
  }

  /** Refuses a probe and closes its live connections. Null when not in that tenant. */
  async refuseProbe(tenantId: number, id: number): Promise<{ uuid: string; hostname: string } | null> {
    const [row] = await db('probes').where({ id, tenant_id: tenantId }).update({
      status: 'refused',
      // A refused probe cannot stay its site's primary.
      is_primary: false,
      // Nor be reported offline (the probe-offline job only watches approved probes).
      offline_alerted_at: null,
      updated_at: new Date(),
    }).returning(['uuid', 'hostname', 'site_id']) as { uuid: string; hostname: string; site_id: number | null }[];
    if (!row) return null;
    await closeProbeConnections([id]);
    await this.resolveProbeOfflineAlerts(tenantId, [id]);
    // Its device checks (and primary role) move to another probe of the site.
    await this.afterProbeAssignmentChange(tenantId, [], [row.site_id]);
    this.emitProbesUpdated(tenantId, [id]);
    return { uuid: row.uuid, hostname: row.hostname };
  }

  /**
   * Suspends an approved probe: it is refused at its next contact (its live
   * connections are closed now) but keeps its site, name and config.
   * Loses its primary role (another probe of the site is elected), is no
   * longer watched by the probe-offline job (its alert is resolved), and its
   * device checks move to another probe. 'not_approved' for a probe that is
   * not approved; null when not in the tenant.
   */
  async suspendProbe(tenantId: number, id: number): Promise<{ uuid: string; hostname: string } | 'not_approved' | null> {
    const [row] = await db('probes').where({ id, tenant_id: tenantId, status: 'approved' }).update({
      status: 'suspended',
      is_primary: false,
      offline_alerted_at: null,
      updated_at: new Date(),
    }).returning(['uuid', 'hostname', 'site_id']) as { uuid: string; hostname: string; site_id: number | null }[];
    if (!row) {
      const exists = await db('probes').where({ id, tenant_id: tenantId }).first('id');
      return exists ? 'not_approved' : null;
    }
    await closeProbeConnections([id]);
    await this.resolveProbeOfflineAlerts(tenantId, [id]);
    await this.afterProbeAssignmentChange(tenantId, [], [row.site_id]);
    this.emitProbesUpdated(tenantId, [id]);
    return { uuid: row.uuid, hostname: row.hostname };
  }

  /**
   * Reactivates a suspended probe (approved again, approval stamp kept): it
   * is accepted at its next contact. 'not_suspended' for a probe in another
   * state; null when not in the tenant.
   */
  async unsuspendProbe(tenantId: number, id: number): Promise<{ uuid: string; hostname: string } | 'not_suspended' | null> {
    // Its silence while suspended is not counted (grace until it reconnects).
    markProbesReactivated([id]);
    const [row] = await db('probes').where({ id, tenant_id: tenantId, status: 'suspended' }).update({
      status: 'approved',
      offline_alerted_at: null,
      updated_at: new Date(),
    }).returning(['uuid', 'hostname', 'site_id']) as { uuid: string; hostname: string; site_id: number | null }[];
    if (!row) {
      const exists = await db('probes').where({ id, tenant_id: tenantId }).first('id');
      return exists ? 'not_suspended' : null;
    }
    await this.afterProbeAssignmentChange(tenantId, [id], [row.site_id]);
    this.emitProbesUpdated(tenantId, [id]);
    return { uuid: row.uuid, hostname: row.hostname };
  }

  /**
   * Queues a command (HTTP fallback) and delivers it at once over the WS when
   * connected; the queued copy is cleared only when that send succeeded.
   * 'not_approved' for a refused / suspended probe (it is refused at every
   * contact, the command could never reach it); null when not in the tenant.
   */
  async sendCommand(tenantId: number, id: number, command: ProbeCommand): Promise<{ delivered: boolean } | 'not_approved' | null> {
    const queued = await db('probes')
      .where({ id, tenant_id: tenantId })
      .whereNotIn('status', ['refused', 'suspended'])
      .update({
        pending_command: command,
        updated_at: new Date(),
      });
    if (!queued) {
      const exists = await db('probes').where({ id, tenant_id: tenantId }).first('id');
      return exists ? 'not_approved' : null;
    }
    const delivered = await this.deliverCommand(tenantId, id, command);
    this.emitProbesUpdated(tenantId, [id]);
    return { delivered };
  }

  /**
   * Cancels a queued command (not yet delivered). Cancelling an uninstall
   * also clears uninstall_commanded_at, so the cleanup job no longer deletes
   * the probe. Returns the cancelled command (null when nothing was queued
   * or pending); undefined when the probe is not in the tenant.
   */
  async cancelCommand(tenantId: number, id: number): Promise<{ cancelled: string | null; uninstallCleared: boolean } | undefined> {
    const row = await db('probes').where({ id, tenant_id: tenantId })
      .first('id', 'pending_command', 'uninstall_commanded_at') as
      { id: number; pending_command: string | null; uninstall_commanded_at: unknown } | undefined;
    if (!row) return undefined;
    const cancelled = row.pending_command ?? null;
    const clearUninstall = cancelled === 'uninstall' || (cancelled === null && row.uninstall_commanded_at != null);
    if (cancelled === null && !clearUninstall) return { cancelled: null, uninstallCleared: false };
    // Only the state that was read: a command queued by someone else, or a
    // queued uninstall delivered in the meantime (uninstall_commanded_at
    // set), is never dropped by this cancel.
    const changed = await db('probes')
      .where({ id, tenant_id: tenantId })
      .where((qb) => {
        if (cancelled === null) qb.whereNull('pending_command').whereNotNull('uninstall_commanded_at');
        else qb.where('pending_command', cancelled);
      })
      .update({
        pending_command: null,
        ...(clearUninstall ? { uninstall_commanded_at: null } : {}),
        updated_at: new Date(),
      });
    if (!changed) return { cancelled: null, uninstallCleared: false };
    this.emitProbesUpdated(tenantId, [id]);
    return { cancelled, uninstallCleared: clearUninstall };
  }

  /** WS delivery of a queued command; clears pending_command only when sent. */
  private async deliverCommand(tenantId: number, id: number, command: ProbeCommand): Promise<boolean> {
    const { sendToProbe } = await import('./probeHub.service');
    if (!sendToProbe(id, { type: 'command', command })) return false;
    const now = new Date();
    const updateStarts = command === 'update' && (await probeOptionalColumns()).updateState;
    await db('probes').where({ id, tenant_id: tenantId }).update({
      pending_command: null,
      ...(command === 'uninstall' ? { uninstall_commanded_at: now } : {}),
      ...(command === 'update' ? { updating_since: now } : {}),
      ...(updateStarts ? UPDATE_ERROR_CLEARED : {}),
    });
    return true;
  }

  /** Deletes a probe and closes its live connections. Null when not in that tenant. */
  async deleteProbe(tenantId: number, id: number): Promise<{ uuid: string; hostname: string } | null> {
    const row = await db.transaction(async (trx) => {
      const [deleted] = await trx('probes').where({ id, tenant_id: tenantId }).delete()
        .returning(['uuid', 'hostname', 'site_id']) as { uuid: string; hostname: string; site_id: number | null }[];
      if (deleted) await deleteProbeSettings(trx, tenantId, [id]);
      return deleted;
    });
    if (!row) return null;
    await closeProbeConnections([id]);
    await this.resolveProbeOfflineAlerts(tenantId, [id]);
    // Its device checks (and primary role) move to another probe of the site.
    await this.afterProbeAssignmentChange(tenantId, [], [row.site_id]);
    this.emitProbesDeleted(tenantId, [id]);
    return { uuid: row.uuid, hostname: row.hostname };
  }

  /**
   * Clears a probe's identity token (reinstalled probe): it gets a new one on
   * its next contact. Its live WebSockets are closed so that this contact is
   * immediate — a connected probe would otherwise keep a connection that is
   * never re-authenticated, leaving the row tokenless (key + UUID accepted)
   * until it reconnects. It reconnects at once and is issued the new token
   * on its own connection.
   */
  async resetIdentityToken(tenantId: number, id: number): Promise<boolean> {
    const reset = await resetProbeToken(id, tenantId);
    if (reset) {
      try {
        const { disconnectProbe } = await import('./probeHub.service');
        disconnectProbe(id, 4000, 'token reset');
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, probeId: id }, 'Failed to close the connections of a probe after a token reset');
      }
      this.emitProbesUpdated(tenantId, [id]);
    }
    return reset;
  }

  // ── Bulk Operations ───────────────────────────────────────────────────────
  // Each acts only on the ids that belong to the tenant and returns them.

  private async ownedProbeIds(tenantId: number, ids: number[]): Promise<number[]> {
    return (await this.ownedProbes(tenantId, ids)).map((p) => p.id);
  }

  /** The tenant's probes among `ids`, with their site. */
  private async ownedProbes(tenantId: number, ids: number[]): Promise<Array<{ id: number; site_id: number | null }>> {
    if (ids.length === 0) return [];
    return await db('probes')
      .where({ tenant_id: tenantId })
      .whereIn('id', ids)
      .select('id', 'site_id') as Array<{ id: number; site_id: number | null }>;
  }

  /**
   * Approves the pending / refused probes among `ids` (already approved and
   * suspended ones are left untouched: approved_by / approved_at kept). A
   * probe without a site (or with one outside the tenant) gets its API key's
   * default site, as with the single approve (approvalSite). Returns the ids
   * actually approved.
   */
  async bulkApprove(tenantId: number, ids: number[], approvedBy: number): Promise<number[]> {
    if (ids.length === 0) return [];
    const rows = await db('probes')
      .where({ tenant_id: tenantId })
      .whereIn('id', ids)
      .whereIn('status', ['pending', 'refused'])
      .select('id', 'site_id', 'api_key_id') as Array<{ id: number; site_id: number | null; api_key_id: number | null }>;
    if (rows.length === 0) return [];
    const now = new Date();
    markProbesReactivated(rows.map((r) => r.id), now.getTime());
    const approved: number[] = [];
    const sites: Array<number | null> = [];
    for (const row of rows) {
      // Same site rule as the single approve (no site, or one outside the
      // tenant → the key's default site).
      const siteId = await this.approvalSite(tenantId, row, undefined);
      const current = toDbId(row.site_id);
      const siteChanged = siteId !== undefined && siteId !== current;
      const updated = await db('probes')
        .where({ id: row.id, tenant_id: tenantId })
        .whereIn('status', ['pending', 'refused'])
        .update({
          status: 'approved',
          approved_by: approvedBy,
          approved_at: now,
          updated_at: now,
          ...(siteChanged ? { site_id: siteId, is_primary: false } : {}),
        });
      if (!updated) continue;
      approved.push(row.id);
      sites.push(current);
      if (siteChanged) sites.push(siteId);
    }
    if (approved.length === 0) return [];
    const rooms = tenantAdminEventRooms(tenantId, 'probes.manage');
    for (const probeId of approved) _io?.to(rooms).emit(SOCKET_EVENTS.PROBE_APPROVED, { probeId });
    await this.afterProbeAssignmentChange(tenantId, approved, sites);
    return approved;
  }

  async bulkDelete(tenantId: number, ids: number[]): Promise<number[]> {
    const owned = await this.ownedProbes(tenantId, ids);
    if (owned.length === 0) return [];
    const ownedIds = owned.map((p) => p.id);
    const deleted = await db.transaction(async (trx) => {
      const rows = await trx('probes').where({ tenant_id: tenantId }).whereIn('id', ownedIds).delete()
        .returning(['id', 'site_id']) as Array<{ id: number; site_id: number | null }>;
      await deleteProbeSettings(trx, tenantId, rows.map((r) => r.id));
      return rows;
    });
    if (deleted.length === 0) return [];
    const deletedIds = deleted.map((r) => r.id);
    await closeProbeConnections(deletedIds);
    await this.resolveProbeOfflineAlerts(tenantId, deletedIds);
    await this.afterProbeAssignmentChange(tenantId, [], deleted.map((p) => p.site_id));
    this.emitProbesDeleted(tenantId, deletedIds);
    return deletedIds;
  }

  /** Suspends the approved probes among `ids` (suspendProbe each); returns those suspended. */
  async bulkSuspend(tenantId: number, ids: number[]): Promise<number[]> {
    const done: number[] = [];
    for (const id of await this.ownedProbeIds(tenantId, ids)) {
      const res = await this.suspendProbe(tenantId, id);
      if (res && typeof res === 'object') done.push(id);
    }
    return done;
  }

  /** Reactivates the suspended probes among `ids`; returns those reactivated. */
  async bulkUnsuspend(tenantId: number, ids: number[]): Promise<number[]> {
    const done: number[] = [];
    for (const id of await this.ownedProbeIds(tenantId, ids)) {
      const res = await this.unsuspendProbe(tenantId, id);
      if (res && typeof res === 'object') done.push(id);
    }
    return done;
  }

  /** A refused / deleted probe's offline alert is over (never throws). */
  private async resolveProbeOfflineAlerts(tenantId: number, probeIds: number[]): Promise<void> {
    if (probeIds.length === 0) return;
    await liveAlertService.resolve(tenantId, probeIds.map(probeOfflineKey))
      .catch((err) => logger.warn({ err: (err as Error)?.message, tenantId }, 'Probe offline alert resolution failed'));
  }

  /**
   * Queues (and delivers over the WS when connected) a command to the
   * tenant's probes among `ids` that are not refused / suspended — those are
   * refused at every contact and skipped. Returns the ids it was queued for.
   */
  async bulkCommand(tenantId: number, ids: number[], command: ProbeCommand): Promise<number[]> {
    if (ids.length === 0) return [];
    const owned = await db('probes')
      .where({ tenant_id: tenantId })
      .whereIn('id', ids)
      .whereNotIn('status', ['refused', 'suspended'])
      .update({ pending_command: command, updated_at: new Date() })
      .returning('id') as Array<{ id: number }>;
    const queued = owned.map((r) => r.id);
    if (queued.length === 0) return [];

    // Deliver instantly to WS-connected probes (of this tenant only)
    for (const id of queued) {
      await this.deliverCommand(tenantId, id, command);
    }
    this.emitProbesUpdated(tenantId, queued);
    return queued;
  }

  // ── Cleanup Jobs ──────────────────────────────────────────────────────────

  /**
   * Deletes the probes whose uninstall was delivered more than 10 min ago.
   * A probe still heard from more than 2 min after the command did not
   * uninstall itself (failed, or reinstalled): it is kept, its uninstall
   * mark is cleared and the tenant gets an "Uninstall not confirmed" alert.
   */
  async cleanupUninstalledProbes(): Promise<void> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);
    const aliveAfter = "uninstall_commanded_at + interval '2 minutes'";

    const survivors = await db('probes')
      .whereNotNull('uninstall_commanded_at')
      .where('uninstall_commanded_at', '<', cutoff)
      .whereNotNull('last_seen_at')
      .whereRaw(`last_seen_at > ${aliveAfter}`)
      .update({ uninstall_commanded_at: null, updated_at: new Date() })
      .returning(['id', 'tenant_id', 'name', 'hostname', 'last_seen_at']) as Array<{
        id: number; tenant_id: number; name: string | null; hostname: string | null; last_seen_at: Date | string;
      }>;
    for (const row of survivors) {
      const label = probeLabel(row);
      logger.warn({ probeId: row.id, tenantId: row.tenant_id }, 'Probe still active after its uninstall command — kept');
      await liveAlertService.add(row.tenant_id, {
        severity: 'warning',
        title: `Uninstall not confirmed: ${label}`.slice(0, 255),
        message: `Probe "${label}" was sent the uninstall command but is still contacting the server `
          + `(last seen ${new Date(row.last_seen_at).toISOString()}). It was kept; uninstall it on the host or delete it.`,
        navigateTo: `/manage/probes/${row.id}`,
        stableKey: `probe-uninstall-unconfirmed:${row.id}`,
      }).catch((err) => logger.warn({ err: (err as Error)?.message, probeId: row.id }, 'Uninstall-not-confirmed live alert failed'));
      this.emitProbesUpdated(row.tenant_id, [row.id]);
    }

    const deleted = await db.transaction(async (trx) => {
      const rows = await trx('probes')
        .whereNotNull('uninstall_commanded_at')
        .where('uninstall_commanded_at', '<', cutoff)
        .where(function () {
          this.whereNull('last_seen_at').orWhereRaw(`last_seen_at <= ${aliveAfter}`);
        })
        .delete()
        .returning(['id', 'tenant_id', 'site_id']) as Array<{ id: number; tenant_id: number; site_id: number | null }>;
      const byTenant = new Map<number, number[]>();
      for (const r of rows) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r.id]);
      for (const [tenantId, probeIds] of byTenant) await deleteProbeSettings(trx, tenantId, probeIds);
      return rows;
    });
    if (deleted.length > 0) {
      logger.info({ count: deleted.length }, 'Cleaned up uninstalled probes');
      const byTenant = new Map<number, Array<{ id: number; site_id: number | null }>>();
      for (const r of deleted) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r]);
      for (const [tenantId, rows] of byTenant) {
        const probeIds = rows.map((r) => r.id);
        await closeProbeConnections(probeIds);
        await this.resolveProbeOfflineAlerts(tenantId, probeIds);
        await this.afterProbeAssignmentChange(tenantId, [], rows.map((r) => r.site_id))
          .catch((err) => logger.warn({ err: (err as Error)?.message, tenantId }, 'Post-uninstall reassignment failed'));
        this.emitProbesDeleted(tenantId, probeIds);
      }
    }
  }

  async cleanupStuckUpdating(): Promise<void> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);
    const count = await db('probes')
      .whereNotNull('updating_since')
      .where('updating_since', '<', cutoff)
      .update({ updating_since: null });
    if (count > 0) {
      logger.info({ count }, 'Cleared stuck-updating probes');
    }
  }

  /**
   * Probe-offline job (index.ts, every 60 s). last_seen_at is written by
   * every push and, over the WebSocket, by the heartbeats.
   *  - An approved probe silent for longer than
   *    max(offlineThresholdMultiplier × its scan interval, probeOfflineGraceMinutes)
   *    (its settings chain: site, group chain, probe overrides) is offline:
   *    offline_alerted_at is set, PROBE_STATUS_CHANGED 'offline' goes to the
   *    tenant admin room and, when notifyProbeOffline is on, a live alert
   *    (probe-offline:<id>) and a notification. The silence is counted from
   *    the server start at the earliest: probes are not reported for the
   *    time the server itself was down. Probes being uninstalled or updated
   *    are skipped.
   *  - A probe seen again after that (last_seen_at > offline_alerted_at):
   *    offline_alerted_at is cleared, the alert resolved,
   *    PROBE_STATUS_CHANGED 'online' sent and, when notifyProbeOffline is on,
   *    a "back online" notification.
   * Each transition is claimed by a conditional update (a probe seen in the
   * meantime is not reported). Never throws for one probe.
   */
  async checkProbeLiveness(): Promise<{ offline: number; online: number }> {
    const now = Date.now();
    const rows = await db('probes as p')
      .leftJoin('sites as s', function () {
        this.on('s.id', '=', 'p.site_id').andOn('s.tenant_id', '=', 'p.tenant_id');
      })
      .where('p.status', 'approved')
      .whereNotNull('p.last_seen_at')
      .where(function () {
        this.where(function () {
          this.whereNull('p.offline_alerted_at')
            .whereNull('p.uninstall_commanded_at')
            .whereNull('p.updating_since')
            .where('p.last_seen_at', '<', new Date(now - PROBE_SILENCE_MIN_MS));
        }).orWhere(function () {
          this.whereNotNull('p.offline_alerted_at').whereRaw('p.last_seen_at > p.offline_alerted_at');
        });
      })
      .select(
        'p.id', 'p.tenant_id', 'p.site_id', 'p.name', 'p.hostname', 'p.ip', 'p.last_seen_at', 'p.offline_alerted_at',
        'p.scan_interval_seconds', 'p.scan_config_override',
        's.id as site_row_id', 's.name as site_name', 's.group_id as site_group_id',
      ) as LivenessRow[];

    let offline = 0;
    let online = 0;
    for (const row of rows) {
      try {
        if (row.offline_alerted_at == null) {
          if (await this.probeWentOffline(row, now)) offline++;
        } else if (await this.probeBackOnline(row, now)) {
          online++;
        }
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, probeId: row.id, tenantId: row.tenant_id }, 'Probe liveness check failed');
      }
    }
    if (offline > 0 || online > 0) logger.info({ offline, online }, 'Probe liveness: status changes');
    return { offline, online };
  }

  private async probeWentOffline(row: LivenessRow, now: number): Promise<boolean> {
    const lastSeen = new Date(row.last_seen_at).getTime();
    if (!Number.isFinite(lastSeen)) return false;
    const reactivatedAt = livenessReactivatedAt.get(row.id);
    if (reactivatedAt !== undefined && lastSeen >= reactivatedAt) livenessReactivatedAt.delete(row.id); // seen since
    const settings = await livenessSettings(row);
    const thresholdMs = probeSilenceThresholdMs(row, settings);
    if (probeSilenceMs(lastSeen, now, livenessEpochFor(row.id)) < thresholdMs) return false;

    // Claim: still approved, not reported, and not seen since this read.
    const claimed = await db('probes')
      .where({ id: row.id, tenant_id: row.tenant_id, status: 'approved' })
      .whereNull('offline_alerted_at')
      .where('last_seen_at', '<', new Date(lastSeen + 1))
      .update({ offline_alerted_at: new Date(now) })
      .returning('id') as Array<{ id: number }>;
    if (claimed.length === 0) return false;

    const label = probeLabel(row);
    const lastSeenIso = new Date(lastSeen).toISOString();
    logger.warn({ probeId: row.id, tenantId: row.tenant_id, lastSeenAt: lastSeenIso }, 'Probe offline');
    _io?.to(tenantAdminEventRooms(row.tenant_id, 'probes.manage')).emit(SOCKET_EVENTS.PROBE_STATUS_CHANGED, {
      probeId: row.id,
      status: 'offline',
      lastSeenAt: lastSeenIso,
    });

    if (!alertsEnabled(settings, 'notifyProbeOffline')) return true;
    const siteId = row.site_row_id ?? null;
    // Maintenance window: offline_alerted_at is set above (the UI
    // shows the probe offline), but no live alert nor notification.
    if (await maintenanceService.isSiteInMaintenance(row.tenant_id, siteId, new Date(now))) return true;
    const minutes = Math.max(1, Math.round((now - lastSeen) / 60_000));
    const message = `Probe "${label}"${row.site_name ? ` (site "${row.site_name}")` : ''} has not contacted the server for ${minutes} min (last seen ${lastSeenIso}). `
      + 'Devices of its subnets are no longer scanned.';
    await liveAlertService.add(row.tenant_id, {
      severity: 'down',
      title: `Probe offline: ${label}`.slice(0, 255),
      message,
      // A site alert also reaches the members who may read the site: link to
      // the site (the probe page needs probes.manage). Tenant-wide alerts
      // (probe without a site) link to the probe page, so they only reach the
      // members who may open it (liveAlert.service alertRequiredCapability).
      navigateTo: siteId ? `/sites/${siteId}` : `/manage/probes/${row.id}`,
      stableKey: probeOfflineKey(row.id),
      siteId,
      kind: 'probe_offline',
      params: { name: label, siteName: row.site_name ?? null, minutes, lastSeenAt: lastSeenIso },
    }).catch((err) => logger.warn({ err, probeId: row.id }, 'Probe offline live alert failed'));
    void notificationService.sendForSite(row.tenant_id, row.site_group_id ?? null, {
      monitorName: `Probe offline: ${label}`,
      oldStatus: 'online',
      newStatus: 'offline',
      message,
      timestamp: new Date(now).toISOString(),
      isIpamNotification: true,
      ...(row.site_name && siteId ? { siteName: row.site_name, siteId } : {}),
      deviceIp: row.ip ?? undefined,
      deviceName: label,
    }, siteId).catch((err) => logger.warn({ err, probeId: row.id }, 'Probe offline notification failed'));
    return true;
  }

  private async probeBackOnline(row: LivenessRow, now: number): Promise<boolean> {
    const claimed = await db('probes')
      .where({ id: row.id, tenant_id: row.tenant_id })
      .whereNotNull('offline_alerted_at')
      .update({ offline_alerted_at: null })
      .returning('id') as Array<{ id: number }>;
    if (claimed.length === 0) return false;

    const label = probeLabel(row);
    logger.info({ probeId: row.id, tenantId: row.tenant_id }, 'Probe back online');
    await liveAlertService.resolve(row.tenant_id, probeOfflineKey(row.id))
      .catch((err) => logger.warn({ err, probeId: row.id }, 'Probe offline alert resolution failed'));
    _io?.to(tenantAdminEventRooms(row.tenant_id, 'probes.manage')).emit(SOCKET_EVENTS.PROBE_STATUS_CHANGED, {
      probeId: row.id,
      status: 'online',
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
    });

    const settings = await livenessSettings(row);
    if (!alertsEnabled(settings, 'notifyProbeOffline')) return true;
    const siteId = row.site_row_id ?? null;
    // Maintenance window: resolved above, no "back online" notification.
    if (await maintenanceService.isSiteInMaintenance(row.tenant_id, siteId, new Date(now))) return true;
    const since = row.offline_alerted_at ? new Date(row.offline_alerted_at).toISOString() : null;
    void notificationService.sendForSite(row.tenant_id, row.site_group_id ?? null, {
      monitorName: `Probe back online: ${label}`,
      oldStatus: 'offline',
      newStatus: 'online',
      message: `Probe "${label}"${row.site_name ? ` (site "${row.site_name}")` : ''} is back online${since ? ` (reported offline at ${since})` : ''}.`,
      timestamp: new Date(now).toISOString(),
      isIpamNotification: true,
      ...(row.site_name && siteId ? { siteName: row.site_name, siteId } : {}),
      deviceIp: row.ip ?? undefined,
      deviceName: label,
    }, siteId).catch((err) => logger.warn({ err, probeId: row.id }, 'Probe back-online notification failed'));
    return true;
  }

  /**
   * Self-healing (index.ts, with the probe-offline job): resolves the active
   * device-offline / probe-offline alerts whose problem is over although no
   * recovery resolved them — the device is no longer offline or was
   * deleted, the probe was refused, deleted or is no longer reported
   * offline (a recovery racing the alert insert, a path that does not
   * resolve). IP takeover / instability alerts have no recovery event: they
   * are resolved IP_CONFLICT_ALERT_TTL_HOURS after they were raised (an
   * instability that still lasts is raised again by the next push).
   * Returns how many were resolved.
   */
  async resolveStaleOfflineAlerts(): Promise<number> {
    // The CASE keeps the ::int cast away from keys of another shape.
    const res = await db.raw(`
      (SELECT la.id FROM live_alerts la
        WHERE la.resolved_at IS NULL
          AND la.stable_key LIKE 'device-offline:%'
          AND NOT EXISTS (
            SELECT 1 FROM site_items si
             WHERE si.id = (CASE WHEN la.stable_key ~ '^device-offline:[0-9]{1,9}:[0-9]{1,9}$'
                                 THEN split_part(la.stable_key, ':', 3)::int END)
               AND si.tenant_id = la.tenant_id
               AND si.status = 'offline')
        LIMIT 500)
      UNION ALL
      (SELECT la.id FROM live_alerts la
        WHERE la.resolved_at IS NULL
          AND la.stable_key LIKE 'probe-offline:%'
          AND NOT EXISTS (
            SELECT 1 FROM probes p
             WHERE p.id = (CASE WHEN la.stable_key ~ '^probe-offline:[0-9]{1,9}$'
                                THEN split_part(la.stable_key, ':', 2)::int END)
               AND p.tenant_id = la.tenant_id
               AND p.status = 'approved'
               AND p.offline_alerted_at IS NOT NULL)
        LIMIT 500)
      UNION ALL
      (SELECT la.id FROM live_alerts la
        WHERE la.resolved_at IS NULL
          AND (la.stable_key LIKE 'ip-takeover:%' OR la.stable_key LIKE 'ip-instability:%')
          AND la.created_at < NOW() - make_interval(hours => ?)
        LIMIT 500)
    `, [IP_CONFLICT_ALERT_TTL_HOURS]) as { rows?: Array<{ id: number | string }> };
    const ids = (res.rows ?? []).map((r) => Number(r.id));
    if (ids.length === 0) return 0;
    const resolved = await liveAlertService.resolveByIds(ids);
    if (resolved.length > 0) logger.info({ count: resolved.length }, 'Resolved stale offline alerts');
    return resolved.length;
  }

  // ── Version + installer helpers ──────────────────────────────────────────

  getProbeVersion(): { version: string } {
    // 1. Try probe/VERSION (plain text "X.Y.Z\n") — present in prod Docker image
    try {
      const versionFilePath = path.resolve(__dirname, '../../../../probe/VERSION');
      const v = fs.readFileSync(versionFilePath, 'utf-8').trim();
      if (v) return { version: v };
    } catch { /* not found, try next */ }

    // 2. Dev fallback: parse `var ProbeVersion = "x.y.z"` from probe/main.go
    try {
      const mainGoPath = path.resolve(__dirname, '../../../../probe/main.go');
      const content = fs.readFileSync(mainGoPath, 'utf-8');
      const match = content.match(/var\s+ProbeVersion\s*=\s*"([^"]+)"/);
      if (match?.[1] && match[1] !== 'dev') return { version: match[1] };
    } catch { /* not found */ }

    return { version: '0.0.0' };
  }

  /**
   * Mark a probe as "updating" — called when the (authenticated) probe
   * notifies us it is about to self-update. Sets updating_since to NOW().
   */
  async setProbeUpdating(tenantId: number, probeId: number): Promise<void> {
    const columns = await probeOptionalColumns();
    await db('probes')
      .where({ id: probeId, tenant_id: tenantId })
      .update({ updating_since: new Date(), updated_at: new Date(), ...(columns.updateState ? UPDATE_ERROR_CLEARED : {}) });
    logger.info({ probeId }, 'Probe is self-updating');
  }

  /**
   * An authenticated probe reports that an update was not applied
   * (update_aborted over the WS, POST /api/probe/agent/update-aborted over
   * HTTP): clears updating_since, stores the reason and the target version
   * (migration 058), refreshes the probe pages and, at most once per probe
   * and reason per 10 min, audits 'probe.update_aborted' (and raises a live
   * alert for a checksum mismatch). Probe-supplied values are validated
   * short codes ('unknown' / null otherwise).
   */
  async recordUpdateAborted(
    tenantId: number,
    probeId: number,
    report: { reason?: unknown; version?: unknown; targetVersion?: unknown; ip?: string | null; via: 'ws' | 'http' },
  ): Promise<void> {
    const reason = shortCode(report.reason, UPDATE_REASON_RE) ?? 'unknown';
    const version = shortCode(report.version, UPDATE_VERSION_RE);
    const targetVersion = shortCode(report.targetVersion, UPDATE_VERSION_RE);
    const now = new Date();
    const columns = await probeOptionalColumns();

    // The probe did not update: drop the "updating" state set when the update
    // command was delivered (or by notifying-update), keep the reason, except
    // same_version / not_newer: the probe is already current, nothing failed
    // (still audited below).
    const changed = await db('probes')
      .where({ id: probeId, tenant_id: tenantId })
      .update({
        updating_since: null,
        updated_at: now,
        ...(columns.updateState && !HARMLESS_UPDATE_ABORTS.has(reason)
          ? { last_update_error: reason, last_update_error_at: now, last_update_target: targetVersion }
          : {}),
      });
    if (!changed) return;
    this.emitProbesUpdated(tenantId, [probeId]);

    if (!allowUpdateAbortEvent(`${probeId}:${reason}`)) return;
    logger.warn({ probeId, reason, version, targetVersion, via: report.via }, 'Probe reported an aborted update');
    void auditService.log({
      tenantId,
      probeId,
      action: 'probe.update_aborted',
      resourceType: 'probe',
      resourceId: probeId,
      details: { reason, version, targetVersion, via: report.via },
      ipAddress: report.ip ?? null,
    });
    if (reason === 'checksum_mismatch') {
      // The downloaded binary did not match the checksum the server announced:
      // tampering on the path between the probe and the server, or a corrupt file.
      await liveAlertService.add(tenantId, {
        severity: 'warning',
        stableKey: `probe-update-checksum:${probeId}`,
        title: 'Probe update refused: checksum mismatch',
        message: `Probe #${probeId} downloaded an update whose SHA-256 did not match the one announced by the server, and refused to install it. `
          + 'Check the network path between the probe and the server (proxy, TLS interception) and the probe files on the server.',
        navigateTo: `/manage/probes/${probeId}`,
      }).catch((err: unknown) => logger.warn({ err: (err as Error)?.message }, 'Probe update checksum live alert failed'));
    }
  }

  // ── Fleet versions / "Update outdated probes" ───────────────────

  /**
   * Version distribution of the tenant's approved probes, newest first:
   * {version, count, outdated} ('unknown' for probes that never reported one).
   */
  async getVersionDistribution(tenantId: number): Promise<{
    latestVersion: string | null;
    total: number;
    outdated: number;
    versions: Array<{ version: string; count: number; outdated: boolean }>;
    rollout: { remaining: number; perMinute: number } | null;
  }> {
    const latest = this.getProbeVersion().version;
    const latestVersion = latest && latest !== '0.0.0' ? latest : null;
    const rows = await db('probes')
      .where({ tenant_id: tenantId, status: 'approved' })
      .groupBy('probe_version')
      .select('probe_version')
      .count<Array<{ probe_version: string | null; count: string | number }>>('id as count');
    const byVersion = new Map<string, number>();
    for (const r of rows) {
      const v = typeof r.probe_version === 'string' && r.probe_version.trim() !== '' ? r.probe_version.trim() : 'unknown';
      byVersion.set(v, (byVersion.get(v) ?? 0) + (Number(r.count) || 0));
    }
    const versions = [...byVersion.entries()]
      .map(([version, count]) => ({
        version,
        count,
        outdated: version !== 'unknown' && isProbeVersionOutdated(version, latestVersion),
      }))
      .sort((a, b) => compareProbeVersions(b.version === 'unknown' ? null : b.version, a.version === 'unknown' ? null : a.version)
        || a.version.localeCompare(b.version));
    return {
      latestVersion,
      total: versions.reduce((n, v) => n + v.count, 0),
      outdated: versions.reduce((n, v) => n + (v.outdated ? v.count : 0), 0),
      versions,
      rollout: fleetUpdateQueue.status(tenantId),
    };
  }

  /**
   * The probes "Update outdated probes" would update: approved, an older
   * version than the server's, not being updated or uninstalled, no
   * uninstall queued, and their scope's policy not 'frozen' (those are
   * counted in `frozen`). Sorted by name.
   */
  async outdatedProbes(tenantId: number): Promise<{
    latestVersion: string | null;
    probes: Array<{ id: number; name: string; probeVersion: string | null; siteId: number | null; wsConnected: boolean }>;
    frozen: number;
  }> {
    const latest = this.getProbeVersion().version;
    const latestVersion = latest && latest !== '0.0.0' ? latest : null;
    if (!latestVersion) return { latestVersion: null, probes: [], frozen: 0 };
    const rows = await db('probes')
      .where({ tenant_id: tenantId, status: 'approved' })
      .whereNull('updating_since')
      .whereNull('uninstall_commanded_at')
      .where((qb) => { qb.whereNull('pending_command').orWhereNot('pending_command', 'uninstall'); })
      .select('id', 'name', 'hostname', 'probe_version', 'site_id') as Array<{
        id: number; name: string | null; hostname: string | null; probe_version: string | null; site_id: number | null;
      }>;
    const candidates = rows.filter((r) => isProbeVersionOutdated(r.probe_version, latestVersion));
    // One policy resolution per site.
    const policyBySite = new Map<number, ProbeUpdatePolicy>();
    const probes: Array<{ id: number; name: string; probeVersion: string | null; siteId: number | null; wsConnected: boolean }> = [];
    let frozen = 0;
    for (const r of candidates) {
      const siteKey = toDbId(r.site_id) ?? 0;
      let policy = policyBySite.get(siteKey);
      if (policy === undefined) {
        policy = (await resolveProbeUpdatePolicy(tenantId, siteKey)).policy;
        policyBySite.set(siteKey, policy);
      }
      if (!fleetUpdateAllowed(policy)) {
        frozen++;
        continue;
      }
      probes.push({
        id: r.id,
        name: r.name || r.hostname || `#${r.id}`,
        probeVersion: r.probe_version,
        siteId: r.site_id,
        wsConnected: isProbeWsConnected(r.id),
      });
    }
    probes.sort((a, b) => a.name.localeCompare(b.name));
    return { latestVersion, probes, frozen };
  }

  /** Queues the given probes for the paced fleet update; returns how many were added. */
  startFleetUpdate(tenantId: number, probeIds: number[], perMinute: number): number {
    return fleetUpdateQueue.enqueue(tenantId, probeIds, perMinute);
  }

  /** Stops the tenant's paced fleet update; returns how many probes were still waiting. */
  cancelFleetUpdate(tenantId: number): number {
    return fleetUpdateQueue.cancel(tenantId);
  }

  /**
   * One step of the fleet update: the 'update' command for a probe that is
   * still eligible at its turn (approved, outdated, idle, not frozen).
   */
  async sendFleetUpdate(tenantId: number, probeId: number): Promise<boolean> {
    const latest = this.getProbeVersion().version;
    const row = await db('probes')
      .where({ id: probeId, tenant_id: tenantId, status: 'approved' })
      .whereNull('updating_since')
      .whereNull('uninstall_commanded_at')
      .first('id', 'probe_version', 'site_id', 'pending_command') as
      { id: number; probe_version: string | null; site_id: number | null; pending_command: string | null } | undefined;
    // Another queued command (an uninstall, a rescan) is never replaced: the
    // probe is skipped at this turn.
    if (!row || (row.pending_command !== null && row.pending_command !== 'update')
      || !isProbeVersionOutdated(row.probe_version, latest)) return false;
    const { policy } = await resolveProbeUpdatePolicy(tenantId, row.site_id);
    if (!fleetUpdateAllowed(policy)) return false;
    // Conditional write: an uninstall / another command queued since the read
    // above, or an update / uninstall started meanwhile, wins over the fleet step.
    const queued = await db('probes')
      .where({ id: probeId, tenant_id: tenantId, status: 'approved' })
      .whereNull('updating_since')
      .whereNull('uninstall_commanded_at')
      .where((qb) => { qb.whereNull('pending_command').orWhere('pending_command', 'update'); })
      .update({ pending_command: 'update', updated_at: new Date() });
    if (!queued) return false;
    await this.deliverCommand(tenantId, probeId, 'update');
    this.emitProbesUpdated(tenantId, [probeId]);
    return true;
  }
}

export const probeService = new ProbeService();

const fleetUpdateQueue = new FleetUpdateQueue((tenantId, probeId) => probeService.sendFleetUpdate(tenantId, probeId));
