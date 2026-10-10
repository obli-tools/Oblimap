import crypto from 'crypto';
import type { Server as SocketIOServer } from 'socket.io';
import {
  DEVICE_CHECKS_CAPABILITY,
  DEVICE_CHECKS_PLAINTEXT_SECRETS_CAPABILITY,
  DEVICE_CHECK_LIMITS,
  SOCKET_EVENTS,
} from '@oblimap/shared';
import type {
  DeviceCheckField,
  DeviceCheckSpec,
  ProbeCheckRule,
  ProbeCheckTarget,
  ProbeDeviceChecksConfig,
} from '@oblimap/shared';
import { db } from '../../db';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { toDbId } from '../../utils/dbId';
import * as secretBox from '../../utils/secretBox';
import { appConfigService, type DeviceChecksPolicy } from '../appConfig.service';
import { settingsService } from '../settings.service';
import { permissionService } from '../permission.service';
import { liveAlertService } from '../liveAlert.service';
import { auditService } from '../audit.service';
import { tenantAdminEventRooms } from '../tenant.service';
import { deviceCheckSpecSchema, specUsesBasicAuth } from '../../validators/deviceCheck.schema';
import { normalizeMacAddress } from '../../validators/probe.schema';
import { matchesItem, prefilterQuery, selectExecutorProbe, type ExecutorCandidate } from './match';

// Per-probe Device Checks assignment: which rules and targets a
// probe runs, delivered as config.deviceChecks on the push response, on
// config_update and on the reply to hello. Assignments are not persisted:
// they are recomputed at every config build (every scan cycle) and cached in
// memory, where ingestion checks that a result comes from the executor of a
// current rule:item assignment at the current rule revision.
//
// Secrets: the plaintext credentials of a target are decrypted here, only
// for a probe allowed to receive them, and are never part of `rev`, of the
// cache, of a log line or of an event.

// ── Socket.io (set by index.ts, shared by the Device Checks services) ───────

let _io: SocketIOServer | null = null;

export function setDeviceChecksIO(io: SocketIOServer): void {
  _io = io;
}

export function deviceChecksIO(): SocketIOServer | null {
  return _io;
}

/** DEVICE_CHECK_RULES_CHANGED to the tenant's admins and deviceChecks.manage holders. */
export function emitRulesChanged(tenantId: number, ruleId: number): void {
  _io?.to(tenantAdminEventRooms(tenantId, 'deviceChecks.manage')).emit(SOCKET_EVENTS.DEVICE_CHECK_RULES_CHANGED, { ruleId });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Concurrent HTTP requests per probe (the probe caps it at 4 and its local policy may lower it). */
export const PROBE_MAX_CONCURRENCY = 4;

const CACHE_TTL_MS = 60_000;
const ASSIGNMENT_TTL_MS = 15 * 60_000;
const MAX_CACHE_ENTRIES = 10_000;

const WARN_WINDOW_MS = 60 * 60_000;
const lastWarnAt = new Map<string, number>();

/** true at most once an hour per key (warnings a build would repeat every scan). */
function warnOnce(key: string): boolean {
  const now = Date.now();
  const last = lastWarnAt.get(key);
  if (last !== undefined && now - last < WARN_WINDOW_MS) return false;
  if (lastWarnAt.size >= MAX_CACHE_ENTRIES) lastWarnAt.clear();
  lastWarnAt.set(key, now);
  return true;
}

/** JSON with object keys sorted at every level (stable hashes). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Short fingerprint of a spec (audit details: old / new spec hash). */
export function specHash(spec: unknown): string {
  return sha256Hex(canonicalJson(spec)).slice(0, 16);
}

/** probes.capabilities (jsonb, or its JSON text) → string list. */
export function parseCapabilities(v: unknown): string[] {
  let parsed = v;
  if (typeof v === 'string') {
    try { parsed = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
}

export function isChecksCapable(probeRow: { capabilities?: unknown }): boolean {
  return parseCapabilities(probeRow.capabilities).includes(DEVICE_CHECKS_CAPABILITY);
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}

/** A site's probes as executor selection sees them. */
export function toExecutorCandidates(rows: Array<Record<string, unknown>>): ExecutorCandidate[] {
  return rows.map((p) => ({
    id: Number(p.id),
    status: String(p.status ?? ''),
    capable: isChecksCapable(p),
    isPrimary: p.is_primary === true,
    lastSeenAt: asDate(p.last_seen_at),
  }));
}

export async function loadSiteProbes(tenantId: number, siteId: number): Promise<ExecutorCandidate[]> {
  const rows = await db('probes')
    .where({ tenant_id: tenantId, site_id: siteId })
    .select('id', 'status', 'capabilities', 'is_primary', 'last_seen_at') as Array<Record<string, unknown>>;
  return toExecutorCandidates(rows);
}

// ── Rules ────────────────────────────────────────────────────────────────────

export interface RuleRecord {
  id: number;
  tenantId: number;
  name: string;
  enabled: boolean;
  suspendedReason: string | null;
  groupId: number | null;
  siteId: number | null;
  spec: DeviceCheckSpec;
  revision: number;
  createdBy: number | null;
  updatedBy: number | null;
}

/** device_check_rules row → RuleRecord; null when the stored spec no longer validates. */
export function rowToRuleRecord(row: Record<string, unknown>): RuleRecord | null {
  let raw = row.spec;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  const parsed = deviceCheckSpecSchema.safeParse(raw);
  if (!parsed.success) {
    if (warnOnce(`spec-invalid:${String(row.id)}`)) {
      logger.warn({ ruleId: row.id, issues: parsed.error.issues.slice(0, 3).map((i) => i.path.join('.')) },
        'Device check rule skipped: its stored spec does not validate');
    }
    return null;
  }
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    name: String(row.name ?? ''),
    enabled: row.enabled === true,
    suspendedReason: (row.suspended_reason as string | null) ?? null,
    groupId: toDbId(row.group_id),
    siteId: toDbId(row.site_id),
    spec: parsed.data,
    revision: Number(row.revision) || 1,
    createdBy: toDbId(row.created_by),
    updatedBy: toDbId(row.updated_by),
  };
}

// Enabled, non-suspended rules per tenant, cached 60 s (dropped on any rule change).
const rulesCache = new Map<number, { at: number; rules: RuleRecord[] }>();

async function activeRulesOfTenant(tenantId: number): Promise<RuleRecord[]> {
  const hit = rulesCache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rules;
  const generation = tenantGeneration(tenantId);
  const rows = await db('device_check_rules')
    .where({ tenant_id: tenantId, enabled: true })
    .whereNull('suspended_reason')
    .orderBy('id', 'asc') as Array<Record<string, unknown>>;
  const rules = rows.map(rowToRuleRecord).filter((r): r is RuleRecord => r !== null);
  if (generation === tenantGeneration(tenantId)) {
    if (rulesCache.size >= MAX_CACHE_ENTRIES) rulesCache.clear();
    rulesCache.set(tenantId, { at: Date.now(), rules });
  }
  return rules;
}

/** Group ids whose rules cover a site of group `groupId` (the group and its ancestors). */
async function coveringGroupIds(tenantId: number, groupId: number | null): Promise<Set<number>> {
  if (!groupId) return new Set();
  const rows = await db('group_closure as gc')
    .join('monitor_groups as g', 'g.id', 'gc.ancestor_id')
    .where('gc.descendant_id', groupId)
    .where('g.tenant_id', tenantId)
    .select('gc.ancestor_id') as Array<{ ancestor_id: number }>;
  return new Set(rows.map((r) => Number(r.ancestor_id)));
}

/** Sites a rule scope covers: the site, the sites of the group's subtree, or 'all' (tenant-wide). */
export async function scopeSiteIds(
  tenantId: number,
  scope: { groupId: number | null; siteId: number | null },
): Promise<number[] | 'all'> {
  if (scope.siteId) return [scope.siteId];
  if (!scope.groupId) return 'all';
  const rows = await db('sites')
    .where('tenant_id', tenantId)
    .whereIn('group_id', db('group_closure').where('ancestor_id', scope.groupId).select('descendant_id'))
    .select('id') as Array<{ id: number }>;
  return rows.map((r) => Number(r.id));
}

export function mergeSiteScopes(a: number[] | 'all', b: number[] | 'all'): number[] | 'all' {
  if (a === 'all' || b === 'all') return 'all';
  return [...new Set([...a, ...b])];
}

// ── Accountability gate ────────────────────────────────────────

/** Keyed `${userId}:${tenantId}:${groupId}:${siteId}`: the verdict depends on the rule's tenant and scope. */
const accountableCache = new Map<string, { at: number; ok: boolean }>();

/**
 * The user accountable for a rule must still exist, be active and either hold
 * the platform admin role or the tenant capability deviceChecks.manage in the
 * rule's tenant (tenant admins hold every capability) — and, without full
 * access, still write the rule's group / site (canStillAuthorScope).
 * Verdicts cached 60 s.
 *
 * The accountable user is the last saver (updated_by), which create, update
 * and enable always set. It never falls back to the creator: users are
 * hard-deleted with ON DELETE SET NULL, so updated_by NULL means the author
 * of the current content was deleted and the rule is suspended.
 */
async function isAccountableUserValid(
  userId: number | null,
  tenantId: number,
  scope: { groupId: number | null; siteId: number | null },
): Promise<boolean> {
  if (!userId) return false;
  const key = `${userId}:${tenantId}:${scope.groupId ?? ''}:${scope.siteId ?? ''}`;
  const hit = accountableCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ok;
  const user = await db('users').where({ id: userId }).first('id', 'is_active', 'role') as
    { id: number; is_active: boolean; role: string } | undefined;
  const ok = !!user && user.is_active !== false
    && (user.role === 'admin'
      || (await permissionService.userHasTenantCapability(userId, tenantId, 'deviceChecks.manage')
        && await canStillAuthorScope(userId, tenantId, scope)));
  if (accountableCache.size >= MAX_CACHE_ENTRIES) accountableCache.clear();
  accountableCache.set(key, { at: Date.now(), ok });
  return ok;
}

/**
 * Authoring is bounded by team scope without full access (rule.service
 * assertAuthoringScope): the accountable user must still be able to write
 * the rule's group / site; a tenant-wide rule needs full access. Otherwise a
 * scoped author who lost rw on the scope would leave the rule running under
 * their name.
 */
async function canStillAuthorScope(
  userId: number,
  tenantId: number,
  scope: { groupId: number | null; siteId: number | null },
): Promise<boolean> {
  if (await permissionService.isFullAccess(userId, tenantId, false)) return true;
  if (scope.siteId !== null) {
    return await permissionService.getSitePermission(userId, scope.siteId, tenantId, false) === 'rw';
  }
  if (scope.groupId !== null) {
    return await permissionService.getGroupPermission(userId, scope.groupId, tenantId, false) === 'rw';
  }
  return false;
}

/** Drops cached accountability verdicts (a user's role / status / membership changed). */
export function invalidateAccountableCache(userId?: number): void {
  if (userId === undefined) {
    accountableCache.clear();
    return;
  }
  const prefix = `${userId}:`;
  for (const key of accountableCache.keys()) {
    if (key.startsWith(prefix)) accountableCache.delete(key);
  }
}

/**
 * Suspends a rule whose accountable user is no longer valid: it stops being
 * delivered until an admin saves or re-enables it. One event and one live
 * alert per suspension.
 */
async function suspendRule(rule: RuleRecord, reason: string): Promise<void> {
  const updated = await db('device_check_rules')
    .where({ id: rule.id, tenant_id: rule.tenantId })
    .whereNull('suspended_reason')
    .update({ suspended_reason: reason, updated_at: new Date() });
  invalidateTenantCaches(rule.tenantId);
  if (!updated) return;
  const accountable = rule.updatedBy;
  logger.warn({ ruleId: rule.id, tenantId: rule.tenantId, reason }, 'Device check rule suspended');
  await db('device_check_events').insert({
    tenant_id: rule.tenantId,
    rule_id: rule.id,
    kind: 'rule_suspended',
    details: JSON.stringify({ reason, accountableUserId: accountable }),
  }).catch((err: unknown) => logger.warn({ err: (err as Error)?.message, ruleId: rule.id }, 'rule_suspended event not written'));
  void auditService.log({
    tenantId: rule.tenantId,
    userId: null,
    action: 'device_check.rule_suspended',
    resourceType: 'device_check_rule',
    resourceId: rule.id,
    details: { reason, accountableUserId: accountable },
  });
  await liveAlertService.add(rule.tenantId, {
    severity: 'warning',
    title: `Device check suspended: ${rule.name.slice(0, 100)}`,
    message: 'The administrator accountable for this device check (the last one who saved it) no longer exists, '
      + 'is inactive or is no longer an administrator, so the check stopped running. '
      + 'An administrator must review the rule and save or re-enable it.',
    navigateTo: `/manage/device-checks/${rule.id}`,
    stableKey: `devcheck-suspended:${rule.id}`,
  }).catch((err: unknown) => logger.warn({ err: (err as Error)?.message, ruleId: rule.id }, 'Suspension live alert failed'));
  emitRulesChanged(rule.tenantId, rule.id);
}

// ── Site settings (deviceChecksEnabled, businessHours) ───────────────────────

export interface SiteCheckSettings {
  enabled: boolean;
  /** BusinessHours object or its JSON text ('{}' = always open). */
  businessHours: unknown;
  /** The site's notificationEnabled master switch (channel notifications). */
  notificationsEnabled: boolean;
}

const siteSettingsCache = new Map<string, { at: number; value: SiteCheckSettings }>();

/** Device Checks settings of a site through the settings chain, cached 60 s. */
export async function getSiteCheckSettings(tenantId: number, siteId: number): Promise<SiteCheckSettings> {
  const key = `${tenantId}:${siteId}`;
  const hit = siteSettingsCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const resolved = await settingsService.resolveForSite(tenantId, siteId);
  const enabledRaw = resolved.deviceChecksEnabled?.value;
  const notifRaw = resolved.notificationEnabled?.value;
  const value: SiteCheckSettings = {
    enabled: !(enabledRaw === false || enabledRaw === 'false'),
    businessHours: resolved.businessHours?.value ?? '{}',
    notificationsEnabled: !(notifRaw === false || notifRaw === 'false'),
  };
  if (siteSettingsCache.size >= MAX_CACHE_ENTRIES) siteSettingsCache.clear();
  siteSettingsCache.set(key, { at: Date.now(), value });
  return value;
}

/** Drops cached site settings of a tenant: the given sites, or all of them. */
export function invalidateSiteCheckSettings(tenantId: number, siteIds?: number[]): void {
  if (siteIds) {
    for (const siteId of siteIds) siteSettingsCache.delete(`${tenantId}:${siteId}`);
    return;
  }
  const prefix = `${tenantId}:`;
  for (const key of siteSettingsCache.keys()) {
    if (key.startsWith(prefix)) siteSettingsCache.delete(key);
  }
}

// ── Credentials ────────────────────────────────────────────────

export interface CredentialRow {
  id: number;
  tenant_id: number;
  rule_id: number;
  site_id: number | null;
  username_masked: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_id: string;
  secret_version: number;
}

/** AAD binding a stored credential to its tenant, rule, site and version. */
export function credentialAad(tenantId: number, ruleId: number, siteId: number | null, secretVersion: number): string {
  return `oblimap|t:${tenantId}|rule:${ruleId}|site:${siteId ?? 0}|v${secretVersion}`;
}

/** The probe columns the credential-delivery decision reads. */
export interface SecretsTransportProbe {
  server_scheme?: unknown;
  capabilities?: unknown;
}

/**
 * Credentials may travel to this probe: the deployment declares TLS
 * (FORCE_HTTPS) and the probe reports an https server URL — or both sides
 * opted in to plaintext: ALLOW_PLAINTEXT_PROBE_SECRETS on the server AND the
 * probe advertises DEVICE_CHECKS_PLAINTEXT_SECRETS_CAPABILITY (its local
 * deviceChecks.allowPlaintextSecrets; without it the probe discards them, so
 * they are never sent in clear for nothing). Never decided from request headers.
 */
export function secretsTransportAllowed(probe: SecretsTransportProbe): boolean {
  if (config.forceHttps && probe.server_scheme === 'https') return true;
  return config.allowPlaintextProbeSecrets
    && parseCapabilities(probe.capabilities).includes(DEVICE_CHECKS_PLAINTEXT_SECRETS_CAPABILITY);
}

/** The site override of a rule's credentials, else its default (site_id NULL). */
export async function loadRuleCredential(tenantId: number, ruleId: number, siteId: number | null): Promise<CredentialRow | null> {
  const rows = await db('device_check_credentials')
    .where({ tenant_id: tenantId, rule_id: ruleId })
    .where((q) => {
      q.whereNull('site_id');
      if (siteId) q.orWhere('site_id', siteId);
    }) as CredentialRow[];
  return rows.find((r) => siteId !== null && r.site_id === siteId) ?? rows.find((r) => r.site_id === null) ?? null;
}

/** Decrypts a stored credential. Throws (SecretBoxError / 409) on a wrong key, AAD or tampering. */
export function decryptCredential(tenantId: number, row: CredentialRow): { username: string; password: string } {
  const plain = secretBox.decryptJson<{ u?: unknown; p?: unknown }>(
    { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyId: row.key_id },
    credentialAad(tenantId, row.rule_id, row.site_id, row.secret_version),
  );
  if (typeof plain?.u !== 'string' || typeof plain?.p !== 'string') throw new secretBox.SecretBoxError('Malformed credential');
  return { username: plain.u, password: plain.p };
}

export type AuthBlocked = NonNullable<ProbeCheckTarget['authBlocked']>;

export interface ResolvedCredentials {
  credentials?: { username: string; password: string };
  authBlocked?: AuthBlocked;
  /** "<credential id>:<secret_version>" for the config rev (never the secret). */
  credVersion: string | null;
}

/** The stored credentials `probe` may receive for (rule, site). */
export async function resolveStoredCredentials(
  tenantId: number,
  ruleId: number,
  siteId: number | null,
  probe: SecretsTransportProbe,
): Promise<ResolvedCredentials> {
  if (!secretBox.isAvailable()) return { authBlocked: 'no_key', credVersion: null };
  if (!secretsTransportAllowed(probe)) return { authBlocked: 'insecure_transport', credVersion: null };
  const row = await loadRuleCredential(tenantId, ruleId, siteId);
  if (!row) return { authBlocked: 'missing', credVersion: null };
  const credVersion = `${row.id}:${row.secret_version}`;
  try {
    return { credentials: decryptCredential(tenantId, row), credVersion };
  } catch {
    if (warnOnce(`cred-decrypt:${row.id}`)) {
      logger.warn({ ruleId, credentialId: row.id, keyId: row.key_id }, 'Device check credential cannot be decrypted (wrong DATA_ENCRYPTION_KEY?)');
    }
    return { authBlocked: 'no_key', credVersion };
  }
}

// ── Wire rule ──────────────────────────────────────────────────

type WireField = ProbeCheckRule['fields'][number] & { enumValues?: Array<{ value: string }> };

function wireField(f: DeviceCheckField): WireField {
  return {
    key: f.key,
    valueType: f.valueType,
    ...(f.maxLength !== undefined ? { maxLength: f.maxLength } : {}),
    // The probe enforces enum membership too when the values are sent (regex
    // tests then run on the same value the server stores).
    ...(f.valueType === 'enum' && f.enumValues ? { enumValues: f.enumValues.map((ev) => ({ value: ev.value })) } : {}),
  };
}

/**
 * The rule as the probe receives it: no labels, display, alerting or
 * server-side assertions; matches / notMatches become regexTests. Variants
 * whose port the platform policy no longer allows are left out and the
 * interval is raised to the policy minimum. Null when no variant is left.
 */
export function buildWireRule(id: number, revision: number, spec: DeviceCheckSpec, policy: DeviceChecksPolicy): ProbeCheckRule | null {
  const allowed = new Set(policy.allowedPorts);
  const variants = spec.variants
    .filter((v) => allowed.has(v.request.port))
    .map((v) => ({ id: v.id, request: { ...v.request }, extract: v.extract }));
  if (variants.length === 0) return null;
  return {
    id,
    rev: revision,
    schedule: {
      intervalSeconds: Math.min(
        DEVICE_CHECK_LIMITS.maxIntervalSeconds,
        Math.max(spec.schedule.intervalSeconds, policy.minIntervalSeconds, DEVICE_CHECK_LIMITS.minIntervalSeconds),
      ),
      jitterSeconds: spec.schedule.jitterSeconds,
      timeoutMs: spec.schedule.timeoutMs,
    },
    requireMac: spec.match.requireMac || specUsesBasicAuth(spec),
    fields: spec.fields.map(wireField),
    variants,
    regexTests: spec.assertions
      .filter((a) => a.enabled && (a.op === 'matches' || a.op === 'notMatches') && typeof a.pattern === 'string')
      .map((a) => ({ id: a.id, field: a.field, pattern: a.pattern as string })),
  };
}

// ── Assignment cache ─────────────────────────────────────────────────────────

export interface Assignment {
  ruleId: number;
  itemId: number;
  siteId: number;
  ip: string;
  mac: string | null;
  revision: number;
  rule: RuleRecord;
}

export interface AssignmentSet {
  tenantId: number;
  probeId: number;
  siteId: number | null;
  rev: string;
  /** "ruleId:itemId" → assignment */
  byKey: Map<string, Assignment>;
  builtAt: number;
}

const assignments = new Map<number, AssignmentSet>();
const building = new Map<number, Promise<AssignmentSet>>();
// Bumped by every invalidation: a build that started before it does not cache its (stale) result.
const generations = new Map<number, number>();

function tenantGeneration(tenantId: number): number {
  return generations.get(tenantId) ?? 0;
}

function emptySet(tenantId: number, probeId: number, siteId: number | null): AssignmentSet {
  return { tenantId, probeId, siteId, rev: 'empty', byKey: new Map(), builtAt: Date.now() };
}

/** Drops the tenant's cached rules and assignments (rule / credential / policy change). */
export function invalidateTenantCaches(tenantId: number): void {
  generations.set(tenantId, tenantGeneration(tenantId) + 1);
  rulesCache.delete(tenantId);
  invalidateSiteCheckSettings(tenantId);
  for (const [probeId, set] of assignments) {
    if (set.tenantId === tenantId) assignments.delete(probeId);
  }
}

export const assignmentCache = {
  get(probeId: number): AssignmentSet | undefined {
    return assignments.get(probeId);
  },

  set(set: AssignmentSet, generation?: number): void {
    if (generation !== undefined && generation !== tenantGeneration(set.tenantId)) return;
    if (!assignments.has(set.probeId) && assignments.size >= MAX_CACHE_ENTRIES) assignments.clear();
    assignments.set(set.probeId, set);
  },

  delete(probeId: number): void {
    assignments.delete(probeId);
  },

  invalidateTenant(tenantId: number): void {
    invalidateTenantCaches(tenantId);
  },

  /**
   * The probe's current assignment: the cached one (built at its last config
   * build, at most 15 min old), else built now — once, even for concurrent
   * callers (e.g. results arriving right after a server restart).
   */
  async getOrBuild(probeRow: Record<string, unknown>): Promise<AssignmentSet> {
    const probeId = Number(probeRow.id);
    const tenantId = Number(probeRow.tenant_id);
    const hit = assignments.get(probeId);
    if (hit && hit.tenantId === tenantId && Date.now() - hit.builtAt < ASSIGNMENT_TTL_MS) return hit;
    let pending = building.get(probeId);
    if (!pending) {
      pending = (async () => {
        // The set this build computed — not a cache re-read: the build does
        // not cache it when an invalidation raced it (rule edit, config push,
        // a suspension by the build itself), and the batch must not then be
        // rejected as "not assigned". ingest re-checks each rule's state and
        // revision under lock anyway.
        const built = await buildAssignment(tenantId, probeRow, null);
        return built && built.set.tenantId === tenantId ? built.set : emptySet(tenantId, probeId, toDbId(probeRow.site_id));
      })().finally(() => building.delete(probeId));
      building.set(probeId, pending);
    }
    return pending;
  },
};

// ── Config build ──────────────────────────────────────────────────────

interface ItemRow {
  id: number;
  ip: string;
  mac: string | null;
  vendor: string | null;
  device_type: string;
  discovered_by_probe_id: number | null;
}

function emptyConfig(): ProbeDeviceChecksConfig {
  return { v: 1, rev: 'empty', maxConcurrency: PROBE_MAX_CONCURRENCY, rules: [], targets: [] };
}

/**
 * The Device Checks assignment of a probe (config.deviceChecks):
 *  - undefined when the probe does not advertise DEVICE_CHECKS_CAPABILITY
 *    (the field is then omitted — old probes never see it);
 *  - empty ({rev:'empty'}) when the probe is not approved, has no site, or
 *    deviceChecksEnabled resolves to false for its site;
 *  - otherwise the enabled rules covering the site whose matching items this
 *    probe executes (capped at policy.maxTargetsPerProbe), with credentials
 *    only where this probe may receive them.
 * `siteRow` (id, group_id) avoids a lookup when the caller has it.
 */
export async function buildProbeChecksConfig(
  tenantId: number,
  probeRow: Record<string, unknown>,
  siteRow: Record<string, unknown> | null,
): Promise<ProbeDeviceChecksConfig | undefined> {
  return (await buildAssignment(tenantId, probeRow, siteRow))?.config;
}

interface BuiltAssignment {
  config: ProbeDeviceChecksConfig | undefined;
  set: AssignmentSet;
}

/**
 * buildProbeChecksConfig with the assignment set it computed (null for a
 * probe row without a valid id). The set is cached only when no
 * invalidation of the tenant happened during the build.
 */
async function buildAssignment(
  tenantId: number,
  probeRow: Record<string, unknown>,
  siteRow: Record<string, unknown> | null,
): Promise<BuiltAssignment | null> {
  const probeId = toDbId(probeRow?.id);
  if (probeId === null) return null;
  const generation = tenantGeneration(tenantId);
  const siteId = toDbId(probeRow.site_id);

  const done = (set: AssignmentSet, config: ProbeDeviceChecksConfig | undefined): BuiltAssignment => {
    assignmentCache.set(set, generation);
    return { config, set };
  };

  if (!isChecksCapable(probeRow)) return done(emptySet(tenantId, probeId, siteId), undefined);

  const empty = (): BuiltAssignment => done(emptySet(tenantId, probeId, siteId), emptyConfig());

  if (probeRow.status !== 'approved' || siteId === null || Number(probeRow.tenant_id) !== tenantId) return empty();

  let site: Record<string, unknown> | null =
    siteRow && toDbId(siteRow.id) === siteId && 'group_id' in siteRow ? siteRow : null;
  if (!site) {
    const row = await db('sites').where({ id: siteId, tenant_id: tenantId }).first('id', 'group_id') as Record<string, unknown> | undefined;
    site = row ?? null;
  }
  if (!site) return empty();

  const settings = await getSiteCheckSettings(tenantId, siteId);
  if (!settings.enabled) return empty();

  const tenantRules = await activeRulesOfTenant(tenantId);
  if (tenantRules.length === 0) return empty();
  const [policy, groups] = await Promise.all([
    appConfigService.getDeviceChecksPolicy(),
    coveringGroupIds(tenantId, toDbId(site.group_id)),
  ]);

  // 1. Rules covering the site  2. accountability gate  5. wire form
  const rules: Array<{ rule: RuleRecord; wire: ProbeCheckRule }> = [];
  for (const rule of tenantRules) {
    const covers = rule.siteId === siteId
      || (rule.groupId !== null && groups.has(rule.groupId))
      || (rule.groupId === null && rule.siteId === null);
    if (!covers) continue;
    if (!(await isAccountableUserValid(rule.updatedBy, rule.tenantId, { groupId: rule.groupId, siteId: rule.siteId }))) {
      await suspendRule(rule, 'accountable_user_invalid').catch((err: unknown) =>
        logger.warn({ err: (err as Error)?.message, ruleId: rule.id }, 'Device check rule suspension failed'));
      continue;
    }
    const wire = buildWireRule(rule.id, rule.revision, rule.spec, policy);
    if (!wire) {
      if (warnOnce(`no-variant:${rule.id}`)) {
        logger.warn({ ruleId: rule.id }, 'Device check rule skipped: none of its ports is allowed by the platform policy');
      }
      continue;
    }
    rules.push({ rule, wire });
  }
  if (rules.length === 0) return empty();

  // 3. Items of the site matching the rules, executed by this probe
  const itemRows = await db('site_items')
    .where({ site_id: siteId, tenant_id: tenantId })
    .where((w) => {
      for (const { rule } of rules) w.orWhere((sub) => { prefilterQuery(sub, rule.spec.match); });
    })
    .select('id', 'ip', 'mac', 'vendor', 'device_type', 'discovered_by_probe_id')
    .orderBy('id', 'asc') as ItemRow[];
  const candidates = await loadSiteProbes(tenantId, siteId);
  const now = new Date();
  const executorOf = new Map<number, number | null>();
  const executor = (item: ItemRow): number | null => {
    if (!executorOf.has(item.id)) executorOf.set(item.id, selectExecutorProbe(item, candidates, now));
    return executorOf.get(item.id) ?? null;
  };

  const planned: Array<{ rule: RuleRecord; item: ItemRow }> = [];
  for (const { rule, wire } of rules) {
    const match = { ...rule.spec.match, requireMac: wire.requireMac };
    for (const item of itemRows) {
      if (matchesItem(match, item) && executor(item) === probeId) planned.push({ rule, item });
    }
  }
  const cap = Math.min(policy.maxTargetsPerProbe, DEVICE_CHECK_LIMITS.maxTargetsPerProbe);
  if (planned.length > cap && warnOnce(`cap:${probeId}`)) {
    logger.warn({ probeId, tenantId, targets: planned.length, cap }, 'Device checks: targets above maxTargetsPerProbe — the extra ones are not checked');
  }
  const kept = planned.slice(0, cap); // rule id, then item id order

  // 4. Credentials, once per rule for this site
  const creds = new Map<number, ResolvedCredentials>();
  for (const { rule } of kept) {
    if (creds.has(rule.id) || !specUsesBasicAuth(rule.spec)) continue;
    creds.set(rule.id, await resolveStoredCredentials(tenantId, rule.id, siteId, probeRow));
  }

  const targets: ProbeCheckTarget[] = [];
  const hashTargets: unknown[] = [];
  const byKey = new Map<string, Assignment>();
  for (const { rule, item } of kept) {
    const c = creds.get(rule.id);
    // "AA:BB:CC:DD:EE:FF" (manual items may hold another spelling); the probe
    // checks it against its ARP table before sending anything.
    const mac = normalizeMacAddress(item.mac);
    const target: ProbeCheckTarget = {
      ruleId: rule.id,
      itemId: item.id,
      ip: item.ip,
      mac,
      ...(c?.credentials ? { credentials: { ...c.credentials } } : {}),
      ...(c?.authBlocked ? { authBlocked: c.authBlocked } : {}),
    };
    targets.push(target);
    hashTargets.push([rule.id, item.id, item.ip, mac, c?.credVersion ?? null, c?.authBlocked ?? null]);
    byKey.set(`${rule.id}:${item.id}`, {
      ruleId: rule.id, itemId: item.id, siteId, ip: item.ip, mac, revision: rule.revision, rule,
    });
  }
  if (targets.length === 0) return empty();

  const usedRules = new Set(kept.map((k) => k.rule.id));
  const wireRules = rules.filter((r) => usedRules.has(r.rule.id)).map((r) => r.wire);

  // 6. rev: rules + targets without secrets (credential id + version only)
  const rev = `sha256:${sha256Hex(canonicalJson({ v: 1, rules: wireRules, targets: hashTargets, maxConcurrency: PROBE_MAX_CONCURRENCY }))}`;

  // 7. cache
  return done(
    { tenantId, probeId, siteId, rev, byKey, builtAt: Date.now() },
    { v: 1, rev, maxConcurrency: PROBE_MAX_CONCURRENCY, rules: wireRules, targets },
  );
}

// ── Pushing changes to connected probes ──────────────────────────────────────

/**
 * Sends a fresh config_update — the probe's full effective config with its
 * deviceChecks assignment — to every WS-connected, approved, capable probe of
 * the given sites ('all' = the whole tenant). Probes in HTTP mode get it with
 * their next push. Returns how many probes were sent an update.
 */
export async function pushConfigToAffectedProbes(tenantId: number, siteIds: number[] | 'all'): Promise<number> {
  invalidateTenantCaches(tenantId);

  const q = db('probes').where({ tenant_id: tenantId, status: 'approved' }).whereNotNull('site_id');
  if (siteIds !== 'all') {
    const ids = [...new Set(siteIds.map((s) => toDbId(s)).filter((s): s is number => s !== null))];
    if (ids.length === 0) return 0;
    q.whereIn('site_id', ids);
  }
  const rows = await q.select('*') as Array<Record<string, unknown>>;
  if (rows.length === 0) return 0;

  // Lazy imports: probe.service and probeHub import this module.
  const hub = await import('../probeHub.service');
  const { probeService } = await import('../probe.service');

  let sent = 0;
  for (const row of rows) {
    const probeId = Number(row.id);
    if (!hub.isProbeConnected(probeId) || !isChecksCapable(row)) continue;
    try {
      const effective = await probeService.buildEffectiveConfig(tenantId, probeId, { probeRow: row });
      if (!effective) continue;
      const cfg = effective as typeof effective & { deviceChecks?: ProbeDeviceChecksConfig };
      if (cfg.deviceChecks === undefined) {
        const deviceChecks = await buildProbeChecksConfig(tenantId, row, null);
        if (deviceChecks) cfg.deviceChecks = deviceChecks;
      }
      const delivered = hub.sendToProbe(probeId, {
        type: 'config_update',
        status: row.status,
        config: cfg,
        // Only for approved probes whose update policy is 'auto' (probe.service).
        latestVersion: await probeService.latestVersionFor(tenantId, row),
        command: null,
      });
      if (delivered) sent++;
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, probeId }, 'Device checks config push failed');
    }
  }
  return sent;
}

/** pushConfigToAffectedProbes for every tenant that has enabled rules (platform policy change). */
export async function pushConfigToAllTenants(): Promise<void> {
  const rows = await db('device_check_rules').where({ enabled: true }).distinct('tenant_id') as Array<{ tenant_id: number }>;
  for (const r of rows) {
    await pushConfigToAffectedProbes(Number(r.tenant_id), 'all').catch((err: unknown) =>
      logger.warn({ err: (err as Error)?.message, tenantId: r.tenant_id }, 'Device checks config push failed'));
  }
}
