import { db } from '../db';
import { logger } from '../utils/logger';
import { appConfigService } from './appConfig.service';
import { auditService } from './audit.service';

// IEEE MAC address registries: MA-L (24-bit OUI), MA-M (28-bit)
// and MA-S (36-bit) blocks, stored in mac_vendors as upper-case hex with ':'
// separators truncated to the nibble length ('AA:BB:CC' 24 bits,
// 'AA:BB:CC:D' 28 bits, 'AA:BB:CC:DD:E' 36 bits, migration 051). A MAC
// resolves to its longest registered prefix: MA-M / MA-S blocks are carved
// out of MA-L blocks registered to the "IEEE Registration Authority".

// ─── Registries ──────────────────────────────────────────────────────────────

export type PrefixBits = 24 | 28 | 36;

export interface OuiRegistry {
  key: 'MA-L' | 'MA-M' | 'MA-S';
  bits: PrefixBits;
  url: string;
}

export const OUI_REGISTRIES: readonly OuiRegistry[] = [
  { key: 'MA-L', bits: 24, url: 'https://standards-oui.ieee.org/oui/oui.csv' },
  { key: 'MA-M', bits: 28, url: 'https://standards-oui.ieee.org/oui28/mam.csv' },
  { key: 'MA-S', bits: 36, url: 'https://standards-oui.ieee.org/oui36/oui36.csv' },
];

/** app_config key: ISO date of the last complete download of the three registries. */
export const OUI_LAST_SEEDED_KEY = 'oui_last_seeded';

/** Below this many rows the table is considered empty (fresh install). */
const MIN_ROWS = 1000;
/** Registries are downloaded again after this age. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Rows per INSERT (4 bindings each, far below Postgres' 65 535 limit). */
const BATCH_SIZE = 500;

const BITS_BY_HEX_LENGTH: Readonly<Record<number, PrefixBits>> = { 6: 24, 7: 28, 9: 36 };

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** 'AABBCCD' → 'AA:BB:CC:D' (pairs, then the odd trailing nibble). */
function formatHex(hex: string): string {
  const parts: string[] = [];
  for (let i = 0; i < hex.length; i += 2) parts.push(hex.slice(i, i + 2));
  return parts.join(':');
}

/**
 * An IEEE assignment ('001BC5', '70B3D51', '70B3D5000', any case, with or
 * without separators) → the stored prefix and its length in bits; null when
 * it is not a 24, 28 or 36-bit assignment.
 */
export function normalizeOuiPrefix(raw: string): { prefix: string; bits: PrefixBits } | null {
  if (typeof raw !== 'string') return null;
  const hex = raw.toUpperCase().replace(/[^0-9A-F]/g, '');
  const bits = BITS_BY_HEX_LENGTH[hex.length];
  if (!bits) return null;
  return { prefix: formatHex(hex), bits };
}

/**
 * The prefixes a MAC may be registered under, longest first (36, 28, 24
 * bits); empty when the MAC is not 12 hex digits ('AA:BB:…', 'AA-BB-…',
 * 'AABB.CC…' or bare).
 */
export function macLookupPrefixes(mac: string | null | undefined): Array<{ prefix: string; bits: PrefixBits }> {
  if (typeof mac !== 'string') return [];
  const hex = mac.trim().toUpperCase().replace(/[:\-.\s]/g, '');
  if (!/^[0-9A-F]{12}$/.test(hex)) return [];
  return [
    { prefix: formatHex(hex.slice(0, 9)), bits: 36 },
    { prefix: formatHex(hex.slice(0, 7)), bits: 28 },
    { prefix: formatHex(hex.slice(0, 6)), bits: 24 },
  ];
}

/** Minimal RFC 4180 parser: quoted fields, embedded commas / quotes / line breaks. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  const len = text.length;
  while (i < len) {
    const fields: string[] = [];
    while (i < len && text[i] !== '\r' && text[i] !== '\n') {
      if (text[i] === '"') {
        i++;
        let val = '';
        while (i < len) {
          if (text[i] === '"' && text[i + 1] === '"') { val += '"'; i += 2; }
          else if (text[i] === '"') { i++; break; }
          else { val += text[i++]; }
        }
        fields.push(val);
        // Anything between the closing quote and the next separator is dropped.
        while (i < len && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') i++;
        if (i < len && text[i] === ',') {
          i++;
          if (i >= len || text[i] === '\r' || text[i] === '\n') fields.push('');
        }
      } else {
        const start = i;
        while (i < len && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') i++;
        fields.push(text.slice(start, i));
        if (i < len && text[i] === ',') {
          i++;
          if (i >= len || text[i] === '\r' || text[i] === '\n') fields.push('');
        }
      }
    }
    if (i < len && text[i] === '\r') i++;
    if (i < len && text[i] === '\n') i++;
    if (fields.length > 0) rows.push(fields);
  }
  return rows;
}

export interface OuiRow {
  prefix: string;
  prefix_bits: PrefixBits;
  vendor_name: string;
}

/**
 * One IEEE registry CSV (Registry,Assignment,Organization Name,Organization
 * Address — the same layout for oui.csv, mam.csv and oui36.csv) → rows.
 * The header, malformed assignments and rows without an organisation are
 * skipped; a repeated prefix keeps its last row. `expectedBits` (optional)
 * drops assignments of another length.
 */
export function parseRegistryCsv(text: string, expectedBits?: PrefixBits): OuiRow[] {
  const byPrefix = new Map<string, OuiRow>();
  const rows = parseCsvRows(text);
  for (let r = 0; r < rows.length; r++) {
    const fields = rows[r];
    if (fields.length < 3) continue;
    if (r === 0 && /^registry$/i.test(fields[0].trim())) continue;
    const norm = normalizeOuiPrefix(fields[1].trim());
    if (!norm) continue;
    if (expectedBits !== undefined && norm.bits !== expectedBits) continue;
    const vendor = fields[2].replace(/\s+/g, ' ').trim().slice(0, 255);
    if (!vendor) continue;
    byPrefix.set(norm.prefix, { prefix: norm.prefix, prefix_bits: norm.bits, vendor_name: vendor });
  }
  return [...byPrefix.values()];
}

export interface VendorPrefixRow {
  prefix: string;
  vendor_name?: string | null;
  custom_name?: string | null;
}

/** custom_name ?? vendor_name of the longest prefix among `rows`; null when none. */
export function pickLongestPrefixVendor(rows: readonly VendorPrefixRow[]): string | null {
  let best: VendorPrefixRow | null = null;
  for (const row of rows) {
    if (!row || typeof row.prefix !== 'string') continue;
    if (!best || row.prefix.length > best.prefix.length) best = row;
  }
  if (!best) return null;
  const custom = typeof best.custom_name === 'string' && best.custom_name.trim() ? best.custom_name : null;
  const vendor = typeof best.vendor_name === 'string' && best.vendor_name.trim() ? best.vendor_name : null;
  return custom ?? vendor;
}

// ─── Lookup (5-minute cache) ─────────────────────────────────────────────────

export type PrefixRowsFetcher = (prefixes: string[]) => Promise<VendorPrefixRow[]>;

export interface VendorLookup {
  lookup(mac: string | null | undefined): Promise<string | null>;
  clear(): void;
}

/**
 * MAC → vendor through the longest registered prefix (36, then 28, then 24
 * bits), cached per 36-bit prefix for `ttlMs`. A lookup error is not cached
 * (null is returned, the next call queries again).
 */
export function createVendorLookup(
  fetchRows: PrefixRowsFetcher,
  ttlMs = 5 * 60 * 1000,
  maxEntries = 20_000,
): VendorLookup {
  const cache = new Map<string, { at: number; value: string | null }>();
  return {
    async lookup(mac) {
      const prefixes = macLookupPrefixes(mac);
      if (prefixes.length === 0) return null;
      const key = prefixes[0].prefix;
      const now = Date.now();
      const hit = cache.get(key);
      if (hit && now - hit.at < ttlMs) return hit.value;
      const rows = await fetchRows(prefixes.map((p) => p.prefix));
      const value = pickLongestPrefixVendor(rows);
      if (cache.size >= maxEntries) cache.clear();
      cache.set(key, { at: now, value });
      return value;
    },
    clear() { cache.clear(); },
  };
}

const defaultLookup = createVendorLookup(async (prefixes) =>
  await db('mac_vendors')
    .whereIn('prefix', prefixes)
    .select('prefix', 'vendor_name', 'custom_name') as VendorPrefixRow[]);

/**
 * Vendor of a MAC (admin override first, then the IEEE name) from its
 * longest registered prefix; null when unknown or on a database error.
 */
export async function lookupVendorByMac(mac: string | null | undefined): Promise<string | null> {
  try {
    return await defaultLookup.lookup(mac);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'MAC vendor lookup failed');
    return null;
  }
}

/** Drops the lookup cache (after an override change or a registry refresh). */
export function clearVendorLookupCache(): void {
  defaultLookup.clear();
}

// ─── Registry download / upsert ──────────────────────────────────────────────

/**
 * Upserts registry rows. Only vendor_name, prefix_bits and updated_at are
 * written on conflict: an admin override (custom_name) is never touched.
 * Returns the number of rows sent.
 */
export async function upsertRegistry(rows: readonly OuiRow[]): Promise<number> {
  let sent = 0;
  const now = new Date();
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE).map((r) => ({
      prefix: r.prefix,
      prefix_bits: r.prefix_bits,
      vendor_name: r.vendor_name,
      updated_at: now,
    }));
    await db('mac_vendors')
      .insert(batch)
      .onConflict('prefix')
      .merge(['vendor_name', 'prefix_bits', 'updated_at']);
    sent += batch.length;
  }
  if (sent > 0) clearVendorLookupCache();
  return sent;
}

/** GET with the standard fetch (redirects followed), 30 s for the whole download. */
async function downloadText(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { 'User-Agent': 'Oblimap-OUI-Updater/1.0', Accept: 'text/csv,text/plain,*/*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return await res.text();
}

export interface RegistrySeedResult {
  key: OuiRegistry['key'];
  bits: PrefixBits;
  rows: number;
  error?: string;
}

export interface SeedResult {
  /** false when nothing was needed (fresh enough) or a seed was already running. */
  ran: boolean;
  /** Rows upserted, all registries together. */
  inserted: number;
  /** Every registry downloaded and stored. */
  complete: boolean;
  registries: RegistrySeedResult[];
  reason?: 'fresh' | 'busy';
}

export interface SeedOptions {
  /** Download even when the table is filled and recent (admin "Refresh registry"). */
  force?: boolean;
  /** Who asked (admin action), for the audit entry; omitted = the server itself. */
  actor?: { userId: number | null; ipAddress: string | null };
}

let running: Promise<SeedResult> | null = null;

/** Rows in mac_vendors and the last complete seed (null when never / unparsable). */
async function seedState(): Promise<{ count: number; lastSeededAt: Date | null }> {
  const row = await db('mac_vendors').count<{ n: string | number }[]>('* as n').first() as { n: string | number } | undefined;
  const count = Number(row?.n ?? 0) || 0;
  const raw = await appConfigService.get(OUI_LAST_SEEDED_KEY);
  const at = raw ? new Date(raw) : null;
  return { count, lastSeededAt: at && Number.isFinite(at.getTime()) ? at : null };
}

/** ISO date of the last complete registry download, or null. */
export async function getLastSeededAt(): Promise<string | null> {
  const raw = await appConfigService.get(OUI_LAST_SEEDED_KEY);
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

async function runSeed(opts: SeedOptions): Promise<SeedResult> {
  if (!opts.force) {
    const { count, lastSeededAt } = await seedState();
    const stale = !lastSeededAt || Date.now() - lastSeededAt.getTime() > MAX_AGE_MS;
    if (count >= MIN_ROWS && !stale) {
      return { ran: false, inserted: 0, complete: true, registries: [], reason: 'fresh' };
    }
  }

  const registries: RegistrySeedResult[] = [];
  let inserted = 0;
  // The three downloads run in parallel (each capped at 30 s), so a forced
  // refresh answers well within a reverse proxy's 60 s read timeout; the
  // upserts stay sequential.
  const downloads = await Promise.allSettled(OUI_REGISTRIES.map((reg) => downloadText(reg.url)));
  for (const [i, reg] of OUI_REGISTRIES.entries()) {
    try {
      const dl = downloads[i];
      if (dl.status === 'rejected') throw dl.reason;
      const rows = parseRegistryCsv(dl.value, reg.bits);
      if (rows.length === 0) throw new Error('no rows parsed');
      const sent = await upsertRegistry(rows);
      inserted += sent;
      registries.push({ key: reg.key, bits: reg.bits, rows: sent });
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      logger.warn({ registry: reg.key, err: message }, 'IEEE MAC registry download failed (retried at the next check)');
      registries.push({ key: reg.key, bits: reg.bits, rows: 0, error: message.slice(0, 200) });
    }
  }

  const complete = registries.every((r) => !r.error);
  // Only a complete download postpones the next one by 30 days: a partial
  // one is retried at the next (daily) check.
  if (complete) await appConfigService.set(OUI_LAST_SEEDED_KEY, new Date().toISOString());

  if (inserted > 0) {
    await auditService.log({
      tenantId: null,
      userId: opts.actor?.userId ?? null,
      ipAddress: opts.actor?.ipAddress ?? null,
      action: 'mac_vendor.seeded',
      resourceType: 'mac_vendor',
      resourceId: null,
      details: {
        upserted: inserted,
        complete,
        trigger: opts.actor ? 'manual' : 'automatic',
        registries: registries.map((r) => ({ registry: r.key, rows: r.rows, failed: Boolean(r.error) })),
      },
    });
  }
  logger.info({ inserted, complete }, 'IEEE MAC registries seeded');
  return { ran: true, inserted, complete, registries };
}

/**
 * Downloads the three IEEE registries when mac_vendors holds fewer than 1000
 * rows or the last complete download is older than 30 days (always with
 * `force`), upserts them (overrides kept), records app_config
 * 'oui_last_seeded' and audits 'mac_vendor.seeded' (platform event). One run
 * at a time. Never throws: a failure is logged and retried at the next check.
 */
export async function seedIfNeeded(opts: SeedOptions = {}): Promise<SeedResult> {
  if (running && !opts.force) {
    return { ran: false, inserted: 0, complete: false, registries: [], reason: 'busy' };
  }
  // A forced refresh waits for the running seed, then runs its own.
  for (let current = running; current; current = running) {
    await current.catch(() => undefined);
  }
  const p = runSeed(opts).catch((err: unknown) => {
    logger.warn({ err: (err as Error)?.message }, 'IEEE MAC registry seed failed (retried at the next check)');
    return { ran: true, inserted: 0, complete: false, registries: [] } as SeedResult;
  });
  running = p;
  try {
    return await p;
  } finally {
    if (running === p) running = null;
  }
}

export interface RegistryStats {
  lastSeededAt: string | null;
  byPrefixBits: Record<'24' | '28' | '36', number>;
}

/** Rows per prefix length, and the last complete download. */
export async function registryStats(): Promise<RegistryStats> {
  const rows = await db('mac_vendors')
    .select('prefix_bits')
    .count<{ prefix_bits: number | string; n: string | number }[]>('* as n')
    .groupBy('prefix_bits') as Array<{ prefix_bits: number | string; n: string | number }>;
  const byPrefixBits: Record<'24' | '28' | '36', number> = { 24: 0, 28: 0, 36: 0 };
  for (const r of rows) {
    const bits = String(Number(r.prefix_bits)) as '24' | '28' | '36';
    if (bits in byPrefixBits) byPrefixBits[bits] = Number(r.n) || 0;
  }
  return { lastSeededAt: await getLastSeededAt(), byPrefixBits };
}

export const ouiRegistryService = {
  seedIfNeeded,
  upsertRegistry,
  lookupVendorByMac,
  clearVendorLookupCache,
  registryStats,
  getLastSeededAt,
};
