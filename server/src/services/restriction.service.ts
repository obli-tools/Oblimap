import { db } from '../db';
import { toDbId } from '../utils/dbId';

// ── Per-tenant action restrictions ────────────────────────
//
// Ported from Obliance services/restriction.service.ts, stage 1 only: each
// tenant maps an action key to 'none' (default) or 'sensitive' (a fresh 2FA
// step-up is required, middleware/stepUp.ts). Obliance's 'restricted' level
// (two-person approval) and its device / group scopes are not ported yet.
//
// Stored in tenants.action_restrictions (migration 057) as
//   { "tunnel.open": "sensitive", ... }
// Only 'sensitive' entries are written; any other value reads as 'none'. The
// Obliance full form { level: 'sensitive', scope } is read as 'sensitive' too
// (forward compatibility), its scope ignored.

/** The actions a tenant can mark sensitive, in display order. */
export const ACTION_KEYS = [
  'tunnel.open',
  'device_check.credentials_set',
  'device_check.rule_enable',
  'probe.command.uninstall',
  'probe.delete',
  'probe.key_create',
  'probe.key_delete',
  'site.delete',
  'site.subnet_delete',
  'group.delete',
  'team.permissions_set',
] as const;

export type ActionKey = typeof ACTION_KEYS[number];
export type RestrictionLevel = 'none' | 'sensitive';
export type RestrictionMap = Record<ActionKey, RestrictionLevel>;

export const RESTRICTION_LEVELS: readonly RestrictionLevel[] = ['none', 'sensitive'];

const ACTION_KEY_SET: ReadonlySet<string> = new Set(ACTION_KEYS);

export function isActionKey(key: unknown): key is ActionKey {
  return typeof key === 'string' && ACTION_KEY_SET.has(key);
}

/** One stored entry → its level ('sensitive' only when explicitly so). */
function entryLevel(raw: unknown): RestrictionLevel {
  if (raw === 'sensitive') return 'sensitive';
  if (raw && typeof raw === 'object' && (raw as { level?: unknown }).level === 'sensitive') return 'sensitive';
  return 'none';
}

/** The stored JSON (object, or a string from an older driver) → a full map over ACTION_KEYS. */
export function normaliseRestrictions(raw: unknown): RestrictionMap {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const out = {} as RestrictionMap;
  for (const key of ACTION_KEYS) out[key] = entryLevel(src[key]);
  return out;
}

/** What is stored: the 'sensitive' entries only (an all-none map is {}). */
export function compactRestrictions(map: Partial<Record<ActionKey, RestrictionLevel>>): Partial<Record<ActionKey, 'sensitive'>> {
  const out: Partial<Record<ActionKey, 'sensitive'>> = {};
  for (const key of ACTION_KEYS) if (map[key] === 'sensitive') out[key] = 'sensitive';
  return out;
}

// ── Cache (30 s per tenant) ─────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;
const MAX_CACHED_TENANTS = 10_000;
const cache = new Map<number, { map: RestrictionMap; expires: number }>();

/** Drops the cached map of one tenant (or of every tenant). */
export function invalidateRestrictionCache(tenantId?: number): void {
  if (tenantId === undefined) cache.clear();
  else cache.delete(tenantId);
}

/** Undefined column (migration 057 not applied yet): nothing is restricted. */
function isMissingColumn(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '42703';
}

async function loadMap(tenantId: number): Promise<RestrictionMap> {
  try {
    const row = await db('tenants').where({ id: tenantId }).first('action_restrictions') as
      { action_restrictions: unknown } | undefined;
    return normaliseRestrictions(row?.action_restrictions);
  } catch (err) {
    if (isMissingColumn(err)) return normaliseRestrictions(null);
    throw err;
  }
}

export const restrictionService = {
  /** The tenant's full map (every ACTION_KEYS entry), cached 30 s. */
  async getRestrictions(tenantId: number): Promise<RestrictionMap> {
    const id = toDbId(tenantId);
    if (id === null) return normaliseRestrictions(null);
    const now = Date.now();
    const hit = cache.get(id);
    if (hit && hit.expires > now) return hit.map;
    const map = await loadMap(id);
    if (!cache.has(id) && cache.size >= MAX_CACHED_TENANTS) cache.clear();
    cache.set(id, { map, expires: now + CACHE_TTL_MS });
    return map;
  },

  /** Level of one action in a tenant ('none' for an unknown key). */
  async levelFor(tenantId: number, key: ActionKey): Promise<RestrictionLevel> {
    if (!isActionKey(key)) return 'none';
    return (await restrictionService.getRestrictions(tenantId))[key];
  },

  /**
   * Replaces the tenant's map (keys left out become 'none'). Answers the map
   * before and after the change; false when the tenant does not exist.
   */
  async setRestrictions(
    tenantId: number,
    levels: Partial<Record<ActionKey, RestrictionLevel>>,
  ): Promise<{ before: RestrictionMap; after: RestrictionMap } | false> {
    const id = toDbId(tenantId);
    if (id === null) return false;
    const stored = compactRestrictions(levels);
    const result = await db.transaction(async (trx) => {
      const row = await trx('tenants').where({ id }).forUpdate().first('action_restrictions') as
        { action_restrictions: unknown } | undefined;
      if (!row) return false as const;
      await trx('tenants').where({ id }).update({ action_restrictions: JSON.stringify(stored) });
      return { before: normaliseRestrictions(row.action_restrictions), after: normaliseRestrictions(stored) };
    });
    invalidateRestrictionCache(id);
    return result;
  },
};

/** Keys whose level differs between two maps ({ key: { from, to } }). */
export function diffRestrictions(
  before: RestrictionMap,
  after: RestrictionMap,
): Partial<Record<ActionKey, { from: RestrictionLevel; to: RestrictionLevel }>> {
  const changes: Partial<Record<ActionKey, { from: RestrictionLevel; to: RestrictionLevel }>> = {};
  for (const key of ACTION_KEYS) {
    if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
  }
  return changes;
}
