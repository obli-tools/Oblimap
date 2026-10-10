import type { Knex } from 'knex';
import { db } from '../db';
import type { SettingsScope, ResolvedSettings, SettingValue } from '@oblimap/shared';
import type { SettingsKey, SettingDefinition } from '@oblimap/shared';
import { SETTINGS_KEYS, HARDCODED_DEFAULTS, SETTINGS_DEFINITIONS } from '@oblimap/shared';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { parseBusinessHours } from '../utils/businessHours';

interface SettingsRow {
  id: number;
  tenant_id: number;
  scope: string;
  scope_id: number | null;
  key: string;
  value: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface SettingOverride {
  key: SettingsKey;
  value: unknown;
}

// ── Value validation ──
//
// Every write goes through normalizeSettingValue(): the per-key validator
// (when there is one), then the type / min / max of the shared definition.
// Values are stored JSON-encoded in settings.value (text).

const MAX_SUBNETS = 64;
const MAX_PORTS = 1024;

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
/** a.b.c.d/n — no leading zeros (Go's net.ParseCIDR on the probe refuses them). */
const IPV4_CIDR_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}/(3[0-2]|[12]?\\d)$`);

function invalidValue(key: string, message: string): never {
  throw new AppError(400, `Invalid value for ${key}: ${message}`);
}

function definitionOf(key: string): SettingDefinition | undefined {
  return SETTINGS_DEFINITIONS.find((d: SettingDefinition) => d.key === key);
}

/** A list given as an array, a JSON array string, or a comma / space separated string. */
function toList(key: string, v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return [];
    if (s.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(s);
      } catch {
        invalidValue(key, 'not a valid JSON array');
      }
      if (!Array.isArray(parsed)) invalidValue(key, 'must be a list');
      return parsed;
    }
    return s.split(/[\s,;]+/).filter(Boolean);
  }
  invalidValue(key, 'must be a list');
}

function integerInRange(key: string, v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) invalidValue(key, `must be an integer between ${min} and ${max}`);
  return n;
}

/** IPv4 CIDR list (excludedSubnets / extraSubnets): trimmed, deduplicated, at most 64 entries. */
function cidrList(key: string, v: unknown): string[] {
  const list = toList(key, v);
  if (list.length > MAX_SUBNETS) invalidValue(key, `at most ${MAX_SUBNETS} subnets`);
  const out: string[] = [];
  for (const item of list) {
    const s = typeof item === 'string' ? item.trim() : '';
    if (!IPV4_CIDR_RE.test(s)) {
      invalidValue(key, `"${String(item).slice(0, 40)}" is not an IPv4 CIDR (e.g. 192.168.1.0/24)`);
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Port list (portScanPorts): integers 1-65535, deduplicated, at most 1024.
 * Entries may be numbers or digit strings; a string entry may hold several
 * ports ("80, 443" as typed in the tag editor).
 */
function portList(key: string, v: unknown, lenient = false): number[] {
  const list = toList(key, v);
  if (list.length > MAX_PORTS && !lenient) invalidValue(key, `at most ${MAX_PORTS} ports`);
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    const tokens = typeof item === 'string' ? item.split(/[\s,;]+/).filter(Boolean) : [item];
    for (const token of tokens) {
      const n = typeof token === 'number' ? token : typeof token === 'string' && /^\d{1,5}$/.test(token) ? Number(token) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        if (lenient) continue;
        invalidValue(key, `"${String(token).slice(0, 20)}" is not a port (1-65535)`);
      }
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  if (out.length > MAX_PORTS) {
    if (lenient) return out.slice(0, MAX_PORTS);
    invalidValue(key, `at most ${MAX_PORTS} ports`);
  }
  return out;
}

/**
 * Per-key validators: return the normalised value, or throw AppError(400).
 * The shared definition's type / min / max are checked afterwards as well.
 * scanIntervalSeconds uses the definition's 60-86400 range (the UI's bounds).
 */
const validators: Partial<Record<SettingsKey, (v: unknown) => unknown>> = {
  businessHours: (v) => parseBusinessHours(v),
  scanIntervalSeconds: (v) => integerInRange('scanIntervalSeconds', v, 60, 86400),
  excludedSubnets: (v) => cidrList('excludedSubnets', v),
  extraSubnets: (v) => cidrList('extraSubnets', v),
  portScanPorts: (v) => portList('portScanPorts', v),
};

/** Type / range check from the shared definition. */
function checkDefinition(def: SettingDefinition, v: unknown): unknown {
  switch (def.type) {
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : NaN;
      if (!Number.isFinite(n)) invalidValue(def.key, 'must be a number');
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        throw new AppError(400, `Value for ${def.key} must be between ${def.min} and ${def.max}`);
      }
      return n;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true') return true;
      if (v === 'false') return false;
      return invalidValue(def.key, 'must be true or false');
    case 'json':
      return toList(def.key, v);
    case 'schedule':
      return parseBusinessHours(v);
    case 'select':
      if (typeof v === 'string' && (def.options ?? []).includes(v)) return v;
      return invalidValue(def.key, `must be one of ${(def.options ?? []).join(', ')}`);
    default:
      return v;
  }
}

/**
 * Validates and normalises a value about to be stored for `key`. Throws
 * AppError(400) on an unknown key or an invalid value. Exported for tests.
 */
export function normalizeSettingValue(key: string, value: unknown): unknown {
  const def = definitionOf(key);
  if (!def) throw new AppError(400, `Unknown setting key: ${String(key).slice(0, 64)}`);
  const validator = validators[def.key];
  return checkDefinition(def, validator ? validator(value) : value);
}

/**
 * Stored text → typed value. Values are written JSON-encoded ('300', 'true',
 * '["10.0.0.0/8"]', '{"tz":…}'); older rows and imports may hold raw or
 * double-encoded strings. Numbers and booleans come back typed, lists as
 * arrays (ports as numbers), businessHours as a validated object: the string
 * and the object form are both accepted. Throws when a businessHours value is
 * invalid (the caller treats the override as absent). Exported for tests.
 */
export function decodeSettingValue(key: string, raw: unknown): unknown {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { /* keep the raw string */ }
  }
  const def = definitionOf(key);
  if (!def) return v;
  switch (def.type) {
    case 'number':
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      return v;
    case 'boolean':
      if (v === 'true') return true;
      if (v === 'false') return false;
      return v;
    case 'json':
      if (typeof v === 'string' && v.trim().startsWith('[')) {
        try { v = JSON.parse(v); } catch { /* keep the raw string */ }
      }
      // The probe decodes ports as integers: never hand it strings.
      if (def.key === 'portScanPorts' && Array.isArray(v)) return portList(def.key, v, true);
      return v;
    case 'schedule':
      return parseBusinessHours(v);
    default:
      return v;
  }
}

/** One warning per stored value that cannot be decoded (not one per scan cycle). */
const warnedRows = new Set<string>();

// ── Scope ownership ──

const SCOPE_TABLES: Record<Exclude<SettingsScope, 'global'>, { table: string; label: string }> = {
  group: { table: 'monitor_groups', label: 'Group' },
  site: { table: 'sites', label: 'Site' },
  // Probe-level overrides (read by resolveForProbe) keep their historical scope name.
  monitor: { table: 'probes', label: 'Probe' },
};

/** Throws 400 on a malformed scope, 404 when the group / site / probe is not in the tenant. */
async function assertScopeInTenant(conn: Knex, tenantId: number, scope: SettingsScope, scopeId: number | null): Promise<void> {
  if (scope === 'global') {
    if (scopeId !== null) throw new AppError(400, 'Invalid scope ID');
    return;
  }
  const target = SCOPE_TABLES[scope];
  if (!target) throw new AppError(400, 'Invalid scope');
  if (scopeId === null) throw new AppError(400, 'Invalid scope ID');
  const row = await conn(target.table).where({ id: scopeId, tenant_id: tenantId }).first('id');
  if (!row) throw new AppError(404, `${target.label} not found`);
}

// ── Resolution helpers ──

function hardcodedDefaults(): ResolvedSettings {
  const resolved = {} as ResolvedSettings;
  for (const key of SETTINGS_KEYS) {
    resolved[key] = {
      value: HARDCODED_DEFAULTS[key],
      source: 'default',
      sourceId: null,
      sourceName: 'Default',
    };
  }
  return resolved;
}

function applyOverrides(
  resolved: ResolvedSettings,
  overrides: Record<string, unknown>,
  source: SettingValue['source'],
  sourceId: number | null,
  sourceName: string,
): void {
  for (const key of SETTINGS_KEYS) {
    if (overrides[key] !== undefined) {
      resolved[key] = {
        value: overrides[key] as SettingValue['value'],
        source,
        sourceId,
        sourceName,
      };
    }
  }
}

/** The tenant's groups from the root down to `groupId` (inclusive unless includeSelf is false). */
async function groupChain(tenantId: number, groupId: number, includeSelf: boolean): Promise<Array<{ id: number; name: string }>> {
  const q = db('group_closure')
    .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
    .where('group_closure.descendant_id', groupId)
    .where('monitor_groups.tenant_id', tenantId);
  if (!includeSelf) q.where('group_closure.depth', '>', 0);
  const rows = await q
    .orderBy('group_closure.depth', 'desc') // root first → direct parent last
    .select('monitor_groups.id', 'monitor_groups.name');
  return rows as Array<{ id: number; name: string }>;
}

export const settingsService = {
  // ── Raw CRUD ──

  /** The tenant's overrides stored at one scope, decoded. */
  async getByScope(tenantId: number, scope: SettingsScope, scopeId: number | null): Promise<Record<string, unknown>> {
    const rows = await db<SettingsRow>('settings')
      .where({ tenant_id: tenantId, scope, scope_id: scopeId })
      .orderBy('id', 'asc') // duplicates left by the pre-034 constraint: the newest row wins
      .select('id', 'key', 'value');

    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.key] = decodeSettingValue(row.key, row.value);
      } catch {
        delete result[row.key];
        const ref = `${tenantId}:${scope}:${scopeId ?? ''}:${row.key}`;
        if (!warnedRows.has(ref)) {
          if (warnedRows.size >= 1000) warnedRows.clear();
          warnedRows.add(ref);
          logger.warn({ tenantId, scope, scopeId, key: row.key }, 'Invalid stored setting value ignored');
        }
      }
    }
    return result;
  },

  /** Throws 404 unless the group / site / probe of the scope belongs to the tenant. */
  async assertScope(tenantId: number, scope: SettingsScope, scopeId: number | null): Promise<void> {
    await assertScopeInTenant(db, tenantId, scope, scopeId);
  },

  /** Validates, then stores one override. Returns the normalised value stored. */
  async set(tenantId: number, scope: SettingsScope, scopeId: number | null, key: SettingsKey, value: unknown): Promise<unknown> {
    const [stored] = await this.setBulk(tenantId, scope, scopeId, [{ key, value }]);
    return stored.value;
  },

  /**
   * Validates every override first (one bad value rejects the whole batch),
   * then writes them in one transaction. Returns the normalised overrides.
   */
  async setBulk(tenantId: number, scope: SettingsScope, scopeId: number | null, overrides: SettingOverride[]): Promise<SettingOverride[]> {
    const normalized = overrides.map(({ key, value }) => ({ key, value: normalizeSettingValue(key, value) }));

    await db.transaction(async (trx) => {
      await assertScopeInTenant(trx, tenantId, scope, scopeId);
      for (const { key, value } of normalized) {
        const serialized = JSON.stringify(value);
        const now = new Date();
        // Delete first: removes duplicates of this key (global rows written
        // before migration 034, or on PostgreSQL < 15 where the unique index
        // cannot treat NULL scope_id as equal). The upsert then targets the
        // (scope, scope_id, key, tenant_id) unique index, so two concurrent
        // saves of the same key merge instead of failing.
        await trx('settings').where({ tenant_id: tenantId, scope, scope_id: scopeId, key }).del();
        await trx('settings')
          .insert({
            scope,
            scope_id: scopeId,
            key,
            value: serialized,
            tenant_id: tenantId,
            updated_at: now,
          })
          .onConflict(['scope', 'scope_id', 'key', 'tenant_id'])
          .merge({ value: serialized, updated_at: now });
      }
    });

    return normalized;
  },

  /** Deletes the tenant's override (reset to inherited). */
  async remove(tenantId: number, scope: SettingsScope, scopeId: number | null, key: string): Promise<boolean> {
    if (!definitionOf(key)) throw new AppError(400, `Unknown setting key: ${String(key).slice(0, 64)}`);
    await assertScopeInTenant(db, tenantId, scope, scopeId);
    const count = await db('settings')
      .where({ tenant_id: tenantId, scope, scope_id: scopeId, key })
      .del();
    return count > 0;
  },

  // ── Inheritance Resolution ──
  //
  // Hardcoded defaults → Global → Group chain (root→leaf) → Site → Probe.
  // Every layer is read for the given tenant only.

  /**
   * Resolve settings for a group level (for display in group settings UI).
   * Chain: Hardcoded → Global → Ancestor groups (root→parent)
   * Does NOT include the group's own overrides as resolved — returns them separately.
   */
  async resolveForGroup(tenantId: number, groupId: number): Promise<{ resolved: ResolvedSettings; overrides: Record<string, unknown> }> {
    const group = await db('monitor_groups').where({ id: groupId, tenant_id: tenantId }).first('id');
    if (!group) throw new AppError(404, 'Group not found');

    const resolved = hardcodedDefaults();
    applyOverrides(resolved, await this.getByScope(tenantId, 'global', null), 'global', null, 'Global');

    for (const ancestor of await groupChain(tenantId, groupId, false)) {
      applyOverrides(resolved, await this.getByScope(tenantId, 'group', ancestor.id), 'group', ancestor.id, ancestor.name);
    }

    // This group's own overrides (separate, not merged into resolved)
    const overrides = await this.getByScope(tenantId, 'group', groupId);

    return { resolved, overrides };
  },

  /**
   * Resolve for global scope (just hardcoded defaults + the tenant's global overrides)
   */
  async resolveGlobal(tenantId: number): Promise<{ resolved: ResolvedSettings; overrides: Record<string, unknown> }> {
    const resolved = hardcodedDefaults();
    const overrides = await this.getByScope(tenantId, 'global', null);
    return { resolved, overrides };
  },

  /**
   * Effective settings of a site. A site outside the tenant gets the
   * tenant's defaults + global overrides only.
   */
  async resolveForSite(tenantId: number, siteId: number): Promise<ResolvedSettings> {
    const site = await db('sites').where({ id: siteId, tenant_id: tenantId }).first('group_id');

    const resolved = hardcodedDefaults();
    applyOverrides(resolved, await this.getByScope(tenantId, 'global', null), 'global', null, 'Global');
    if (!site) return resolved;

    if (site.group_id) {
      for (const ancestor of await groupChain(tenantId, site.group_id as number, true)) {
        applyOverrides(resolved, await this.getByScope(tenantId, 'group', ancestor.id), 'group', ancestor.id, ancestor.name);
      }
    }

    applyOverrides(resolved, await this.getByScope(tenantId, 'site', siteId), 'site', siteId, 'This site');

    return resolved;
  },

  /** Effective settings of a probe: the site chain, then probe-level overrides. */
  async resolveForProbe(tenantId: number, probeId: number, siteId: number | null, groupId: number | null): Promise<ResolvedSettings> {
    const resolved = hardcodedDefaults();
    applyOverrides(resolved, await this.getByScope(tenantId, 'global', null), 'global', null, 'Global');

    if (groupId !== null) {
      for (const ancestor of await groupChain(tenantId, groupId, true)) {
        applyOverrides(resolved, await this.getByScope(tenantId, 'group', ancestor.id), 'group', ancestor.id, ancestor.name);
      }
    }

    if (siteId !== null) {
      applyOverrides(resolved, await this.getByScope(tenantId, 'site', siteId), 'site', siteId, 'This site');
    }

    // Probe-level overrides are stored under the historical 'monitor' scope.
    applyOverrides(resolved, await this.getByScope(tenantId, 'monitor', probeId), 'monitor', probeId, 'This probe');

    return resolved;
  },
};
