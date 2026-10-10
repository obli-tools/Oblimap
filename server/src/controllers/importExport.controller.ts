import type { Request, Response, NextFunction } from 'express';
import type { Knex } from 'knex';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { db } from '../db';
import { getPlugin } from '../notifications/registry';
import { AppError } from '../middleware/errorHandler';
import {
  REDACTED,
  parseChannelConfig,
  redactChannelConfig,
  redactedSecretsRetargeted,
  restoreRedactedConfig,
} from '../services/notification.service';
import { DEVICE_TYPES, DEVICE_TYPE_LABELS, ITEM_ALERT_MODES, type DeviceType } from '@oblimap/shared';
import { auditService } from '../services/audit.service';
import { lockTenantTree } from '../services/group.service';
import { decodeSettingValue, normalizeSettingValue } from '../services/settings.service';
import { permissionService, invalidateTenantCapabilityCache } from '../services/permission.service';
import {
  LEGACY_MEMBER_ROLE,
  PERMISSION_SET_SLUG_RE,
  TENANT_ADMIN_ROLE,
  parseStoredCapabilities,
} from '../services/permissionSet.service';
import { clearVendorLookupCache } from '../services/ouiRegistry.service';
import { emitPermissionsChanged, emitSiteUpdated } from '../services/realtime.service';
import { pushConfigToAffectedProbes } from '../services/deviceChecks/config.service';
import { recordBatch as recordItemEvents, type ItemEventInput } from '../services/itemEvents.service';
import { isLocallyAdministered } from '../services/deviceClassification';
import {
  SITE_SUBNET_MAX_PREFIX,
  SITE_SUBNET_MIN_PREFIX,
  formatCidr,
  isHostOf,
  parseSubnet,
} from '../services/siteSubnet.service';
import { firstTooWideSubnet } from '../validators/settings.schema';
import { isIPv4, normalizeMacAddress } from '../validators/probe.schema';
import { CsvParseError, parseCsv, unneutralizeCell } from '../utils/csv';
import { toDbId } from '../utils/dbId';
import { logger } from '../utils/logger';


const EXPORT_SECTIONS = [
  'siteGroups',
  'sites',
  'settings',
  'notificationChannels',
  'teams',
  // IPAM data
  'siteSubnets',
  'reservations',
  'siteItems',
  'vendorRules',
  'macVendorOverrides',
  'permissionSets',
] as const;
type ExportSection = typeof EXPORT_SECTIONS[number];

/**
 * Sections only platform admins export / import: the MAC-vendor table and the
 * permission sets are platform-wide (shared by every tenant), only platform
 * admins change them (macVendors / permissionSets routes).
 */
const PLATFORM_ADMIN_SECTIONS: readonly ExportSection[] = ['macVendorOverrides', 'permissionSets'];
/** Sections whose import needs an extra tenant capability (same gate as their own routes). */
const SECTION_EXTRA_CAPABILITY: Partial<Record<ExportSection, 'deviceChecks.manage'>> = {
  // vendor-rule mutations: sites.manage (import gate) + deviceChecks.manage
  vendorRules: 'deviceChecks.manage',
};

/**
 * What to do when an imported item's UUID already exists in the database.
 *  - update      : overwrite the existing record with the imported data (default)
 *  - generateNew : create a brand-new copy with a fresh UUID
 *  - ignore      : skip the item entirely
 */
export type ConflictStrategy = 'update' | 'generateNew' | 'ignore';

// ── Import payload validation ────────────────────────────────────────────────
// Every section is validated before anything is written. Names are bounded by
// their column sizes; authorization data (team permission scope / level) and
// channel types are closed lists. An item with an empty name is skipped, as
// before.

const MAX_ITEMS = 10_000;

// Any RFC 4122 layout (hand-written ids such as aaaaaaaa-0000-… are accepted by PostgreSQL too).
const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID');
const optUuid = uuidSchema.nullish();
const nameSchema = z.string().trim().max(128).nullish();
const descriptionSchema = z.string().max(10_000).nullish();

const channelConfigSchema = z.union([
  z.record(z.unknown()),
  // Older files may carry the config as a JSON string.
  z.string().max(65_536).transform((s, ctx) => {
    try {
      const parsed: unknown = JSON.parse(s);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* reported below */ }
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'config must be a JSON object' });
    return z.NEVER;
  }),
]);

const siteGroupSchema = z.object({
  uuid: optUuid,
  name: nameSchema,
  description: descriptionSchema,
  parentUuid: optUuid,
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000).nullish(),
  isGeneral: z.boolean().nullish(),
  groupNotifications: z.boolean().nullish(),
});

const siteSchema = z.object({
  uuid: optUuid,
  name: nameSchema,
  description: descriptionSchema,
  groupUuid: optUuid,
});

const settingSchema = z.object({
  scope: z.enum(['global', 'group', 'site']),
  scopeUuid: optUuid,
  key: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, 'Invalid setting key'),
  value: z.unknown().refine((v) => v !== undefined && v !== null, 'value is required'),
});

const bindingSchema = z.object({
  scope: z.enum(['global', 'group', 'site']),
  scopeUuid: optUuid,
  overrideMode: z.enum(['merge', 'replace', 'exclude']).nullish(),
});

const channelSchema = z.object({
  uuid: optUuid,
  name: nameSchema,
  type: z.string().max(64).refine((t) => !!getPlugin(t), 'Unknown notification type'),
  config: channelConfigSchema.nullish(),
  isEnabled: z.boolean().nullish(),
  bindings: z.array(bindingSchema).max(MAX_ITEMS).nullish(),
});

const teamPermissionSchema = z.object({
  scope: z.enum(['group', 'site']),
  scopeUuid: optUuid,
  level: z.enum(['ro', 'rw']).nullish(),
});

const teamSchema = z.object({
  uuid: optUuid,
  name: nameSchema,
  description: descriptionSchema,
  canCreate: z.boolean().nullish(),
  permissions: z.array(teamPermissionSchema).max(MAX_ITEMS).nullish(),
});

// ── IPAM sections ──────────────────────────────────────────────────
// Rows of a site are keyed by the site's UUID (resolved in req.tenantId only)
// plus their natural key: the MAC (else the IP) for devices, the IP for
// reservations, the CIDR for subnets.

/** Many IPAM rows per site: a larger cap than the other sections. */
const MAX_IPAM_ROWS = 100_000;

const ipv4Field = z.string().trim().max(15).refine(isIPv4, 'Invalid IPv4 address');

/** "aa-bb-cc-dd-ee-ff" / "aabbccddeeff" → "AA:BB:CC:DD:EE:FF"; '' / null → null. */
export function normalizeImportedMac(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (s === '') return null;
  const bare = /^[0-9A-Fa-f]{12}$/.test(s) ? s.match(/../g)!.join(':') : s;
  return normalizeMacAddress(bare) ?? undefined;
}

const macField = z.string().max(32).nullish().transform((v, ctx) => {
  const mac = normalizeImportedMac(v);
  if (mac === undefined && v !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid MAC address (expected AA:BB:CC:DD:EE:FF)' });
    return z.NEVER;
  }
  return mac ?? null;
});

const deviceTypeField = z.enum(DEVICE_TYPES);

const siteItemSchema = z.object({
  siteUuid: uuidSchema,
  ip: ipv4Field,
  mac: macField,
  /** Manual device (created when missing); otherwise only the metadata of a discovered device. */
  isManual: z.boolean().nullish(),
  customName: z.string().trim().max(255).nullish(),
  /** null on a discovered device: its type stays the classified one. */
  deviceType: deviceTypeField.nullish(),
  notes: z.string().max(10_000).nullish(),
  alertMode: z.enum(ITEM_ALERT_MODES).nullish(),
});

const reservationSchema = z.object({
  siteUuid: uuidSchema,
  ip: ipv4Field,
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2000).nullish(),
  deviceType: deviceTypeField.nullish(),
  reservedMac: macField,
});

const siteSubnetSchema = z.object({
  siteUuid: uuidSchema,
  cidr: z.string().trim().max(18),
  name: z.string().trim().max(100).nullish(),
  vlan: z.number().int().min(1).max(4094).nullish(),
  gateway: z.union([z.literal(''), ipv4Field]).nullish(),
  description: z.string().max(1000).nullish(),
});

const vendorRuleSchema = z.object({
  /** null = a tenant-wide rule. */
  groupUuid: optUuid,
  vendorPattern: z.string().trim().min(2).max(128),
  deviceType: deviceTypeField,
  label: z.string().trim().max(64).nullish(),
  priority: z.number().int().min(-1000).max(1000).nullish(),
});

/** 'AA:BB:CC' (24 bits), 'AA:BB:CC:D' (28) or 'AA:BB:CC:DD:E' (36), as mac_vendors stores them. */
export const MAC_VENDOR_PREFIX_RE = /^[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}(?::[0-9A-F](?:[0-9A-F]:[0-9A-F])?)?$/;

const macVendorOverrideSchema = z.object({
  prefix: z.string().trim().toUpperCase().regex(MAC_VENDOR_PREFIX_RE, 'Invalid OUI prefix'),
  customName: z.string().trim().min(1).max(255),
});

const permissionSetSchema = z.object({
  slug: z.string().trim().toLowerCase()
    .regex(PERMISSION_SET_SLUG_RE, 'Invalid slug')
    .refine((s) => s !== LEGACY_MEMBER_ROLE && s !== TENANT_ADMIN_ROLE, 'Reserved slug'),
  name: z.string().trim().min(1).max(64),
  // Unknown capabilities (another version of the app) are dropped on import.
  capabilities: z.array(z.string().max(64)).max(64).nullish(),
});

const sectionSchemas = {
  siteGroups: z.array(siteGroupSchema).max(MAX_ITEMS),
  sites: z.array(siteSchema).max(MAX_ITEMS),
  settings: z.array(settingSchema).max(MAX_ITEMS),
  notificationChannels: z.array(channelSchema).max(MAX_ITEMS),
  teams: z.array(teamSchema).max(MAX_ITEMS),
  siteSubnets: z.array(siteSubnetSchema).max(MAX_IPAM_ROWS),
  reservations: z.array(reservationSchema).max(MAX_IPAM_ROWS),
  siteItems: z.array(siteItemSchema).max(MAX_IPAM_ROWS),
  vendorRules: z.array(vendorRuleSchema).max(MAX_ITEMS),
  macVendorOverrides: z.array(macVendorOverrideSchema).max(MAX_IPAM_ROWS),
  permissionSets: z.array(permissionSetSchema).max(MAX_ITEMS),
} satisfies Record<ExportSection, z.ZodTypeAny>;

/** Exported for tests (the shipped import template must pass them). */
export const importSectionSchemas = sectionSchemas;

type ImportData = { [K in ExportSection]?: z.infer<typeof sectionSchemas[K]> };
type SiteGroupInput = z.infer<typeof siteGroupSchema>;

const importRequestSchema = z.object({
  sections: z.array(z.enum(EXPORT_SECTIONS)).min(1, 'sections array is required'),
  data: z.record(z.unknown()),
  conflictStrategy: z.enum(['update', 'generateNew', 'ignore']).default('update'),
});

interface ValidationIssue { path: string; message: string }

function toIssues(error: z.ZodError, prefix: string): ValidationIssue[] {
  return error.issues.map((i) => ({ path: [prefix, ...i.path].filter((p) => p !== '').join('.'), message: i.message }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function ensureUniqueSlugTrx(trx: Knex.Transaction, slug: string, tenantId: number): Promise<string> {
  let candidate = slug;
  let i = 1;
  for (;;) {
    const exists = await trx('monitor_groups').where({ slug: candidate, tenant_id: tenantId }).first();
    if (!exists) return candidate;
    candidate = `${slug}-${i++}`;
  }
}

/** Topological sort — parents before children. Cycles are silently ignored. */
function topoSortGroups(items: SiteGroupInput[]): SiteGroupInput[] {
  const byUuid = new Map<string, SiteGroupInput>(
    items.filter((i) => i.uuid).map((i) => [i.uuid as string, i]),
  );
  const sorted: SiteGroupInput[] = [];
  const visited = new Set<SiteGroupInput>();

  function visit(item: SiteGroupInput) {
    if (visited.has(item)) return;
    visited.add(item);
    if (item.parentUuid) {
      const parent = byUuid.get(item.parentUuid);
      if (parent) visit(parent);
    }
    sorted.push(item);
  }

  for (const item of items) visit(item);
  return sorted;
}

/** Insert closure-table entries for a newly created group */
async function insertGroupClosure(
  trx: Knex.Transaction,
  groupId: number,
  parentId: number | null,
): Promise<void> {
  await trx('group_closure').insert({ ancestor_id: groupId, descendant_id: groupId, depth: 0 });
  if (parentId !== null) {
    await trx.raw(
      `INSERT INTO group_closure (ancestor_id, descendant_id, depth)
       SELECT gc.ancestor_id, ?, gc.depth + 1
       FROM   group_closure gc
       WHERE  gc.descendant_id = ?`,
      [groupId, parentId],
    );
  }
}

/**
 * Re-parents an existing group inside the import transaction, keeping the
 * closure table (used by settings / notification / permission inheritance)
 * consistent — same steps as groupService.move. Returns false, leaving the
 * group where it is, when the new parent is the group itself or one of its
 * descendants.
 */
async function moveGroupTrx(trx: Knex.Transaction, groupId: number, newParentId: number | null): Promise<boolean> {
  if (newParentId !== null) {
    const isDescendant = await trx('group_closure').where({ ancestor_id: groupId, descendant_id: newParentId }).first();
    if (isDescendant) return false;
  }
  const descIds = (await trx('group_closure').where({ ancestor_id: groupId }).select('descendant_id'))
    .map((r: { descendant_id: number }) => r.descendant_id);
  await trx('group_closure').whereIn('descendant_id', descIds).whereNotIn('ancestor_id', descIds).del();
  if (newParentId !== null) {
    await trx.raw(
      `INSERT INTO group_closure (ancestor_id, descendant_id, depth)
       SELECT p.ancestor_id, s.descendant_id, p.depth + s.depth + 1
       FROM group_closure p
       CROSS JOIN group_closure s
       WHERE p.descendant_id = ?
         AND s.ancestor_id = ?`,
      [newParentId, groupId],
    );
  }
  return true;
}

/**
 * What the settings import does with one (scope, scope_id, key) row
 * Pure, exported for tests.
 *  - ignore      : an existing row is kept (skip), a missing key is created.
 *  - update      : upsert (update when the row exists, else create).
 *  - generateNew : group / site settings apply only to records created by
 *                  this import (the copies); global keys are created only
 *                  when missing, an existing global row is kept.
 */
export function decideSettingImportAction(
  strategy: ConflictStrategy,
  row: { scope: 'global' | 'group' | 'site'; exists: boolean; targetCreatedInBatch: boolean },
): 'create' | 'update' | 'skip' {
  if (strategy === 'ignore') return row.exists ? 'skip' : 'create';
  if (strategy === 'update') return row.exists ? 'update' : 'create';
  // generateNew
  if (row.scope === 'global') return row.exists ? 'skip' : 'create';
  if (!row.targetCreatedInBatch) return 'skip';
  return row.exists ? 'update' : 'create';
}

/**
 * UUID → id map of the rows of ONE tenant. The import queries are already
 * filtered on tenant_id; rows of another tenant are dropped here as well, so
 * a UUID of another tenant never resolves (defence in depth). Pure, exported
 * for tests.
 */
export function ownUuidMap(rows: ReadonlyArray<{ id: number; uuid: string; tenant_id?: number | null }>, tenantId: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.tenant_id !== undefined && r.tenant_id !== null && Number(r.tenant_id) !== tenantId) continue;
    if (typeof r.uuid === 'string' && r.uuid) map.set(r.uuid, Number(r.id));
  }
  return map;
}

/**
 * Resolves a UUID of the file to an id of the tenant: first the records this
 * import wrote (a copy made by 'generateNew' answers for the UUID of the
 * file), then the tenant's own records. Anything else → null. Pure, exported
 * for tests.
 */
export function makeUuidResolver(batch: ReadonlyMap<string, number>, own: ReadonlyMap<string, number>): (uuid: string | null | undefined) => number | null {
  return (uuid) => {
    if (!uuid) return null;
    return batch.get(uuid) ?? own.get(uuid) ?? null;
  };
}

// ── CSV import (reservations / devices) ──────────────────────────────────────
// POST /admin/import/csv/preview and /commit (site write on siteId). The file
// is parsed and validated with the server validators, each row classified
// against the site's current data: new / update / conflict / invalid. The
// preview never writes; the commit re-reads the site inside its transaction
// and applies the same classification.

export const CSV_IMPORT_KINDS = ['reservations', 'devices'] as const;
export type CsvImportKind = typeof CSV_IMPORT_KINDS[number];
export const CSV_IMPORT_MAX_ROWS = 5000;
/** Characters of a CSV body: kept under the app's 1 MB JSON body limit (escaping included). */
export const CSV_IMPORT_MAX_CHARS = 800_000;

export type CsvField = 'ip' | 'mac' | 'name' | 'description' | 'deviceType' | 'notes';

/** Header aliases per field, in priority order (normalised: lowercase a-z0-9, no accents). */
const CSV_FIELD_ALIASES: Record<CsvImportKind, Partial<Record<CsvField, string[]>>> = {
  reservations: {
    ip: ['ip', 'ipaddress', 'ipv4', 'address', 'adresseip', 'adresse'],
    name: ['name', 'reservationname', 'nom', 'label', 'libelle'],
    description: ['description', 'desc', 'comment', 'comments', 'commentaire'],
    deviceType: ['devicetype', 'type', 'typedappareil', 'typeappareil'],
    mac: ['reservedmac', 'mac', 'macaddress', 'adressemac'],
  },
  devices: {
    ip: ['ip', 'ipaddress', 'ipv4', 'address', 'adresseip', 'adresse'],
    mac: ['mac', 'macaddress', 'adressemac'],
    name: ['customname', 'displayname', 'name', 'nom', 'nomaffiche', 'label'],
    deviceType: ['devicetype', 'type', 'typedappareil', 'typeappareil'],
    notes: ['notes', 'note', 'comment', 'comments', 'commentaire'],
  },
};

/** Column order of a file without a header row (its first cell is an IPv4). */
const CSV_POSITIONAL: Record<CsvImportKind, CsvField[]> = {
  reservations: ['ip', 'name', 'description', 'deviceType', 'mac'],
  devices: ['ip', 'mac', 'name', 'deviceType', 'notes'],
};

const CSV_MAX_LENGTH: Record<CsvImportKind, Partial<Record<CsvField, number>>> = {
  reservations: { name: 128, description: 2000 },
  devices: { name: 255, notes: 10_000 },
};

export function normalizeCsvHeader(h: string): string {
  return h.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface CsvColumns {
  /** Field → column index. */
  map: Partial<Record<CsvField, number>>;
  hasHeader: boolean;
}

/**
 * Maps the columns of the first record: a header naming an IP column, or no
 * header at all when the first cell is an IPv4 (default column order).
 * null when neither.
 */
export function resolveCsvColumns(kind: CsvImportKind, firstRecord: readonly string[]): CsvColumns | null {
  const normalized = firstRecord.map((c) => normalizeCsvHeader(unneutralizeCell(c)));
  const map: Partial<Record<CsvField, number>> = {};
  const used = new Set<number>();
  for (const [field, aliases] of Object.entries(CSV_FIELD_ALIASES[kind]) as Array<[CsvField, string[]]>) {
    for (const alias of aliases) {
      const idx = normalized.findIndex((h, i) => h === alias && !used.has(i));
      if (idx >= 0) { map[field] = idx; used.add(idx); break; }
    }
  }
  if (map.ip !== undefined) return { map, hasHeader: true };
  if (isIPv4((firstRecord[0] ?? '').trim())) {
    const positional: Partial<Record<CsvField, number>> = {};
    CSV_POSITIONAL[kind].forEach((f, i) => { positional[f] = i; });
    return { map: positional, hasHeader: false };
  }
  return null;
}

/** 'printer' / 'Printer' / 'IP Camera' (the label) → DeviceType; '' → undefined; anything else → null. */
export function parseCsvDeviceType(value: string): DeviceType | null | undefined {
  const s = value.trim();
  if (s === '') return undefined;
  const lower = s.toLowerCase();
  const byKey = (DEVICE_TYPES as readonly string[]).find((t) => t === lower);
  if (byKey) return byKey as DeviceType;
  const norm = normalizeCsvHeader(s);
  const byLabel = Object.entries(DEVICE_TYPE_LABELS).find(([, label]) => normalizeCsvHeader(label) === norm);
  return byLabel ? byLabel[0] as DeviceType : null;
}

export interface CsvRow {
  /** 1-based line of the file. */
  line: number;
  ip: string;
  mac: string | null;
  /** Reservation name / device custom name ('' = not given). */
  name: string;
  /** Reservation description ('' = not given). */
  description: string;
  /** Device notes ('' = not given). */
  notes: string;
  deviceType: DeviceType | undefined;
  /** Error codes; any → the row is invalid. */
  errors: string[];
}

/**
 * Parses and validates a CSV file of reservations / devices (no database).
 * Errors of the file itself (quote, too many rows, no IP column) are thrown
 * as CsvParseError / returned as { error }.
 */
export function parseCsvImport(kind: CsvImportKind, csv: string): { rows: CsvRow[]; columns: CsvColumns } | { error: 'csv_empty' | 'csv_header_missing' } {
  // +1: the header row.
  const records = parseCsv(csv, { maxRecords: CSV_IMPORT_MAX_ROWS + 1 });
  if (records.length === 0) return { error: 'csv_empty' };
  const columns = resolveCsvColumns(kind, records[0].cells);
  if (!columns) return { error: 'csv_header_missing' };
  const data = columns.hasHeader ? records.slice(1) : records;
  if (data.length > CSV_IMPORT_MAX_ROWS) {
    throw new CsvParseError('csv_too_many_rows', `The file has more than ${CSV_IMPORT_MAX_ROWS} rows`, data[CSV_IMPORT_MAX_ROWS].line);
  }
  if (data.length === 0) return { error: 'csv_empty' };

  const limits = CSV_MAX_LENGTH[kind];
  const seen = new Set<string>();
  const rows = data.map((rec): CsvRow => {
    const cell = (f: CsvField): string => {
      const i = columns.map[f];
      return i === undefined ? '' : unneutralizeCell(rec.cells[i] ?? '').trim();
    };
    const errors: string[] = [];
    const ip = cell('ip');
    if (!isIPv4(ip)) errors.push(ip === '' ? 'ip_required' : 'invalid_ip');
    const rawMac = cell('mac');
    const mac = normalizeImportedMac(rawMac);
    if (mac === undefined) errors.push('invalid_mac');
    const name = cell('name');
    const description = kind === 'reservations' ? cell('description') : '';
    const notes = kind === 'devices' ? cell('notes') : '';
    if (kind === 'reservations' && name === '') errors.push('name_required');
    if (limits.name !== undefined && name.length > limits.name) errors.push('name_too_long');
    if (limits.description !== undefined && description.length > limits.description) errors.push('description_too_long');
    if (limits.notes !== undefined && notes.length > limits.notes) errors.push('notes_too_long');
    const deviceType = parseCsvDeviceType(cell('deviceType'));
    if (deviceType === null) errors.push('invalid_device_type');

    // The same record twice in the file: only the first one counts.
    if (errors.length === 0) {
      const key = kind === 'reservations' ? `ip:${ip}` : mac ? `mac:${mac}` : `ip:${ip}`;
      if (seen.has(key)) errors.push('duplicate_in_file');
      seen.add(key);
    }
    return {
      line: rec.line,
      ip,
      mac: mac ?? null,
      name,
      description,
      notes,
      deviceType: deviceType ?? undefined,
      errors,
    };
  });
  return { rows, columns };
}

export type CsvRowStatus = 'new' | 'update' | 'conflict' | 'invalid';

export interface CsvSiteSnapshot {
  /** Reservations of the site by IP. */
  reservationsByIp: Map<string, { id: number; reservedMac: string | null }>;
  /** Items of the site by MAC (the oldest row when several share it). */
  itemsByMac: Map<string, { id: number; ip: string; mac: string | null }>;
  /** Items of the site by IP (oldest first). */
  itemsByIp: Map<string, Array<{ id: number; ip: string; mac: string | null }>>;
}

/**
 * Adds a row about to be created to the snapshot, so the next rows of the
 * file are classified against it (preview and commit agree). Exported for tests.
 */
export function rememberCsvRow(kind: CsvImportKind, snapshot: CsvSiteSnapshot, row: CsvRow, id: number): void {
  if (kind === 'reservations') {
    snapshot.reservationsByIp.set(row.ip, { id, reservedMac: row.mac });
    return;
  }
  const item = { id, ip: row.ip, mac: row.mac };
  if (row.mac && !snapshot.itemsByMac.has(row.mac)) snapshot.itemsByMac.set(row.mac, item);
  const list = snapshot.itemsByIp.get(row.ip);
  if (list) list.push(item); else snapshot.itemsByIp.set(row.ip, [item]);
}

export interface CsvRowClassification {
  status: CsvRowStatus;
  /** The record an 'update' row writes to. */
  existingId?: number;
  /** Why a row is a conflict. */
  reason?: 'reserved_for_other_mac' | 'mac_on_other_ip' | 'ip_used_by_other_mac' | 'ambiguous_ip';
}

/**
 * new / update / conflict / invalid for one validated row. Pure, exported for tests.
 *  - reservations: keyed by IP; an existing reservation made for another MAC
 *    is a conflict (never overwritten by a CSV).
 *  - devices: keyed by MAC, else by IP, as the manual-device duplicate guard:
 *    a MAC known at another IP, an IP held by a device with another MAC, or
 *    (without MAC) several devices on the IP are conflicts.
 */
export function classifyCsvRow(kind: CsvImportKind, row: CsvRow, site: CsvSiteSnapshot): CsvRowClassification {
  if (row.errors.length > 0) return { status: 'invalid' };
  if (kind === 'reservations') {
    const existing = site.reservationsByIp.get(row.ip);
    if (!existing) return { status: 'new' };
    if (existing.reservedMac && row.mac && existing.reservedMac !== row.mac) {
      return { status: 'conflict', existingId: existing.id, reason: 'reserved_for_other_mac' };
    }
    return { status: 'update', existingId: existing.id };
  }
  const onIp = site.itemsByIp.get(row.ip) ?? [];
  if (row.mac) {
    const byMac = site.itemsByMac.get(row.mac);
    if (byMac) {
      return byMac.ip === row.ip
        ? { status: 'update', existingId: byMac.id }
        : { status: 'conflict', existingId: byMac.id, reason: 'mac_on_other_ip' };
    }
    const withoutMac = onIp.find((i) => !i.mac);
    if (withoutMac) return { status: 'update', existingId: withoutMac.id };
    if (onIp.length > 0) return { status: 'conflict', existingId: onIp[0].id, reason: 'ip_used_by_other_mac' };
    return { status: 'new' };
  }
  if (onIp.length === 0) return { status: 'new' };
  if (onIp.length === 1) return { status: 'update', existingId: onIp[0].id };
  return { status: 'conflict', reason: 'ambiguous_ip' };
}

/** CSV commit strategy: 'update' writes new and update rows, 'ignore' only new ones. Conflicts are never written. */
export type CsvCommitStrategy = 'update' | 'ignore';

export function csvRowAction(status: CsvRowStatus, strategy: CsvCommitStrategy): 'create' | 'update' | 'skip' {
  if (status === 'new') return 'create';
  if (status === 'update' && strategy === 'update') return 'update';
  return 'skip';
}

async function loadCsvSiteSnapshot(conn: Knex | Knex.Transaction, tenantId: number, siteId: number): Promise<CsvSiteSnapshot> {
  const [reservations, items] = await Promise.all([
    conn('ip_reservations').where({ tenant_id: tenantId, site_id: siteId }).select('id', 'ip', 'reserved_mac') as
      Promise<Array<{ id: number; ip: string; reserved_mac?: string | null }>>,
    conn('site_items').where({ tenant_id: tenantId, site_id: siteId }).orderBy('id', 'asc').select('id', 'ip', 'mac') as
      Promise<Array<{ id: number; ip: string; mac: string | null }>>,
  ]);
  const reservationsByIp = new Map<string, { id: number; reservedMac: string | null }>();
  for (const r of reservations) reservationsByIp.set(r.ip, { id: Number(r.id), reservedMac: r.reserved_mac ?? null });
  const itemsByMac = new Map<string, { id: number; ip: string; mac: string | null }>();
  const itemsByIp = new Map<string, Array<{ id: number; ip: string; mac: string | null }>>();
  for (const i of items) {
    const item = { id: Number(i.id), ip: i.ip, mac: i.mac };
    if (i.mac && !itemsByMac.has(i.mac)) itemsByMac.set(i.mac, item);
    const list = itemsByIp.get(i.ip);
    if (list) list.push(item); else itemsByIp.set(i.ip, [item]);
  }
  return { reservationsByIp, itemsByMac, itemsByIp };
}

const csvRequestSchema = z.object({
  siteId: z.union([z.number(), z.string()]),
  kind: z.enum(CSV_IMPORT_KINDS),
  csv: z.string().min(1).max(CSV_IMPORT_MAX_CHARS),
});

const csvCommitSchema = csvRequestSchema.extend({
  strategy: z.enum(['update', 'ignore']).default('update'),
});

/** Parses the request body and the file; answers 400 itself and returns null on any error. */
function readCsvRequest<T extends z.ZodTypeAny>(req: Request, res: Response, schema: T):
  { body: z.infer<T>; siteId: number; parsed: { rows: CsvRow[]; columns: CsvColumns } } | null {
  const body = schema.safeParse(req.body);
  if (!body.success) {
    const issues = toIssues(body.error, '');
    res.status(400).json({ success: false, error: `Invalid CSV import request: ${issues[0]?.path || 'body'} — ${issues[0]?.message ?? 'invalid'}`, issues });
    return null;
  }
  const siteId = toDbId((body.data as { siteId: unknown }).siteId);
  if (siteId === null) {
    res.status(400).json({ success: false, error: 'Invalid site ID' });
    return null;
  }
  try {
    const parsed = parseCsvImport((body.data as { kind: CsvImportKind }).kind, (body.data as { csv: string }).csv);
    if ('error' in parsed) {
      res.status(400).json({
        success: false,
        error: parsed.error,
        message: parsed.error === 'csv_empty' ? 'The file has no data rows' : 'No IP column found: add a header row (ip, name, mac…)',
      });
      return null;
    }
    return { body: body.data, siteId, parsed };
  } catch (err) {
    if (err instanceof CsvParseError) {
      res.status(400).json({ success: false, error: err.code, message: err.message, line: err.line ?? null });
      return null;
    }
    throw err;
  }
}

/** Preview row sent to the client (values as they will be written). */
function previewRow(row: CsvRow, c: CsvRowClassification) {
  return {
    line: row.line,
    status: c.status,
    ...(c.reason ? { reason: c.reason } : {}),
    ...(c.existingId !== undefined ? { existingId: c.existingId } : {}),
    errors: row.errors,
    ip: row.ip,
    mac: row.mac,
    name: row.name || null,
    description: row.description ? row.description.slice(0, 200) : null,
    notes: row.notes ? row.notes.slice(0, 200) : null,
    deviceType: row.deviceType ?? null,
  };
}

let siteItemColumns: Promise<{ deviceTypeSource: boolean; macRandomized: boolean; alertMode: boolean }> | null = null;

/** Optional site_items columns (migrations 048 / 052), checked once; written only once they exist. */
function optionalItemColumns(): Promise<{ deviceTypeSource: boolean; macRandomized: boolean; alertMode: boolean }> {
  if (!siteItemColumns) {
    siteItemColumns = Promise.all([
      db.schema.hasColumn('site_items', 'device_type_source'),
      db.schema.hasColumn('site_items', 'mac_randomized'),
      db.schema.hasColumn('site_items', 'alert_mode'),
    ]).then(([deviceTypeSource, macRandomized, alertMode]) => {
      // Not cached until every migration ran: re-checked after an upgrade.
      if (!deviceTypeSource || !macRandomized || !alertMode) siteItemColumns = null;
      return { deviceTypeSource, macRandomized, alertMode };
    }).catch((err: unknown) => {
      siteItemColumns = null;
      throw err;
    });
  }
  return siteItemColumns;
}

/** Insert row of a manual device (same columns as siteService.createManualItem). */
async function manualItemRow(
  tenantId: number,
  siteId: number,
  data: { ip: string; mac: string | null; customName: string | null; deviceType: DeviceType | null | undefined; notes: string | null },
): Promise<Record<string, unknown>> {
  const cols = await optionalItemColumns();
  const now = new Date();
  const deviceType = data.deviceType ?? 'unknown';
  return {
    ...(cols.deviceTypeSource ? { device_type_source: deviceType !== 'unknown' ? 'manual' : null } : {}),
    ...(cols.macRandomized ? { mac_randomized: isLocallyAdministered(data.mac) } : {}),
    site_id: siteId,
    tenant_id: tenantId,
    ip: data.ip,
    mac: data.mac,
    custom_name: data.customName,
    device_type: deviceType,
    notes: data.notes,
    status: 'unknown',
    is_manual: true,
    first_seen_at: now,
    last_seen_at: now,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Device type written by an import: a changed type is pinned as chosen by a
 * person ('manual' source, never re-classified), 'unknown' clears the source
 * (same rule as siteService.updateItem).
 */
async function deviceTypePatch(trx: Knex.Transaction, deviceType: DeviceType): Promise<Record<string, unknown>> {
  const cols = await optionalItemColumns();
  const patch: Record<string, unknown> = { device_type: deviceType };
  if (cols.deviceTypeSource) {
    patch.device_type_source = trx.raw(
      deviceType === 'unknown'
        ? 'CASE WHEN device_type IS DISTINCT FROM ? THEN NULL ELSE device_type_source END'
        : "CASE WHEN device_type IS DISTINCT FROM ? THEN 'manual' ELSE device_type_source END",
      [deviceType],
    );
  }
  return patch;
}

/** After devices / reservations of sites were written: live refresh + device-check targets (never throws). */
function afterSitesChanged(tenantId: number, siteIds: Iterable<number>): void {
  const ids = [...new Set(siteIds)];
  if (ids.length === 0) return;
  for (const siteId of ids) emitSiteUpdated(tenantId, siteId);
  pushConfigToAffectedProbes(tenantId, ids).catch((err: unknown) =>
    logger.warn({ err: (err as Error)?.message, tenantId }, 'Device checks config push after an import failed'));
}

// ── Controller ────────────────────────────────────────────────────────────────

export const importExportController = {

  // ── EXPORT ──────────────────────────────────────────────────────────────────

  async exportData(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawSections = typeof req.query.sections === 'string' ? req.query.sections : '';
      const requested   = rawSections ? rawSections.split(',').map(s => s.trim()) : [];
      const all         = requested.length === 0 || requested.includes('all');
      // The MAC-vendor overrides are platform data: exported for platform
      // admins only (left out of "all" for the others).
      const isPlatformAdmin = req.session.role === 'admin';
      const allowed     = (s: ExportSection) => s !== 'macVendorOverrides' || isPlatformAdmin;
      const want        = (s: ExportSection) => (all || requested.includes(s)) && allowed(s);
      const sections    = EXPORT_SECTIONS.filter(want);

      // Channel secrets are replaced by the redaction placeholder unless the
      // admin explicitly asks for them (audited separately).
      const includeSecrets = req.query.includeSecrets === '1' || req.query.includeSecrets === 'true';

      const tenantId = req.tenantId;

      const payload: Record<string, unknown> = {
        version:    1,
        exportedAt: new Date().toISOString(),
        _note: [
          'UUIDs are optional — omit them to always create new records on import.',
          'When a UUID is present and matches an existing record, the conflict strategy',
          'chosen at import time determines whether to update, ignore, or duplicate it.',
          'UUIDs are automatically assigned to all records on first export.',
          includeSecrets
            ? 'This file contains notification channel secrets in clear text: store it securely.'
            : `Notification channel secrets (tokens, API keys, Discord / Slack / Teams webhook URLs) are exported as "${REDACTED}": on import they keep the value of the matching existing channel if its target URL / server is unchanged; channels whose secrets cannot be restored are imported disabled.`,
        ].join(' '),
        sections,
      };

      // ── Lazily-built UUID maps (shared across sections) ─────────────────────
      let _groupUuidMap: Map<number, string> | null = null;
      let _siteUuidMap:  Map<number, string> | null = null;

      async function getGroupUuidMap(): Promise<Map<number, string>> {
        if (!_groupUuidMap) {
          const rows = await db('monitor_groups').where({ tenant_id: tenantId }).select('id', 'uuid');
          _groupUuidMap = new Map(rows.map((r: { id: number; uuid: string }) => [r.id, r.uuid]));
        }
        return _groupUuidMap;
      }

      async function getSiteUuidMap(): Promise<Map<number, string>> {
        if (!_siteUuidMap) {
          const rows = await db('sites').where({ tenant_id: tenantId }).select('id', 'uuid');
          _siteUuidMap = new Map(rows.map((r: { id: number; uuid: string }) => [r.id, r.uuid]));
        }
        return _siteUuidMap;
      }

      // ── Site Groups ──────────────────────────────────────────────────────────
      if (want('siteGroups')) {
        const groups  = await db('monitor_groups').where({ tenant_id: tenantId }).orderBy('sort_order').orderBy('name');
        const selfMap = new Map<number, string>(groups.map((g: any) => [g.id as number, g.uuid as string]));

        payload.siteGroups = groups.map((g: any) => ({
          uuid:               g.uuid,
          name:               g.name,
          description:        g.description,
          parentUuid:         g.parent_id != null ? (selfMap.get(g.parent_id) ?? null) : null,
          sortOrder:          g.sort_order,
          isGeneral:          g.is_general,
          groupNotifications: g.group_notifications,
        }));
      }

      // ── Sites ────────────────────────────────────────────────────────────────
      if (want('sites')) {
        const sites = await db('sites').where({ tenant_id: tenantId }).orderBy('name');
        const guMap = await getGroupUuidMap();

        payload.sites = sites.map((s: any) => ({
          uuid:        s.uuid,
          name:        s.name,
          description: s.description ?? null,
          groupUuid:   s.group_id != null ? (guMap.get(s.group_id) ?? null) : null,
        }));
      }

      // ── Settings (all scopes) ────────────────────────────────────────────────
      if (want('settings')) {
        const settings = await db('settings').where({ tenant_id: tenantId }).orderBy('scope').orderBy('scope_id').orderBy('key');
        const guMap    = await getGroupUuidMap();
        const suMap    = await getSiteUuidMap();

        payload.settings = settings
          .map((s: any) => ({
            scope:     s.scope,
            scopeUuid:
              s.scope === 'global' ? null :
              s.scope === 'group'  ? (guMap.get(s.scope_id) ?? null) :
              s.scope === 'site'   ? (suMap.get(s.scope_id) ?? null) :
              null,
            key:   s.key,
            value: s.value,
          }))
          .filter((s: any) => s.scope === 'global' || s.scopeUuid !== null);
      }

      // ── Notification Channels + Bindings ─────────────────────────────────────
      if (want('notificationChannels')) {
        const channels   = await db('notification_channels').where({ tenant_id: tenantId }).orderBy('id');
        const channelIds = channels.map((c: any) => c.id as number);
        const bindings   = channelIds.length > 0
          ? await db('notification_bindings').where({ tenant_id: tenantId }).whereIn('channel_id', channelIds).orderBy('channel_id')
          : [];
        const guMap    = await getGroupUuidMap();
        const suMap    = await getSiteUuidMap();

        payload.notificationChannels = channels.map((c: any) => {
          const cfg = parseChannelConfig(c.config);
          return {
            uuid:      c.uuid,
            name:      c.name,
            type:      c.type,
            config:    includeSecrets ? cfg : redactChannelConfig(c.type, cfg),
            isEnabled: c.is_enabled,
            bindings:  bindings
              .filter((b: any) => b.channel_id === c.id)
              .map((b: any) => ({
                scope:        b.scope,
                scopeUuid:
                  b.scope === 'global' ? null :
                  b.scope === 'group'  ? (guMap.get(b.scope_id) ?? null) :
                  b.scope === 'site'   ? (suMap.get(b.scope_id) ?? null) :
                  null,
                overrideMode: b.override_mode,
              }))
              .filter((b: any) => b.scope === 'global' || b.scopeUuid !== null),
          };
        });
      }

      // ── Teams + Permissions (no memberships — users are never exported) ───────
      if (want('teams')) {
        const teams       = await db('user_teams').where({ tenant_id: tenantId }).orderBy('id');
        const teamIds     = teams.map((t: any) => t.id as number);
        const permissions = teamIds.length > 0
          ? await db('team_permissions').whereIn('team_id', teamIds).orderBy('team_id')
          : [];
        const guMap       = await getGroupUuidMap();
        const suMap       = await getSiteUuidMap();

        payload.teams = teams.map((t: any) => ({
          uuid:        t.uuid,
          name:        t.name,
          description: t.description,
          canCreate:   t.can_create,
          permissions: permissions
            .filter((p: any) => p.team_id === t.id)
            .map((p: any) => ({
              scope:     p.scope,
              scopeUuid: p.scope === 'group'
                ? (guMap.get(p.scope_id) ?? null)
                : p.scope === 'site'
                  ? (suMap.get(p.scope_id) ?? null)
                  : null,
              level: p.level,
            }))
            .filter((p: any) => p.scopeUuid !== null),
        }));
      }

      // ── Site subnets (manual metadata; probe-reported prefixes need no row) ──
      if (want('siteSubnets')) {
        const rows  = await db.schema.hasTable('site_subnets')
          ? await db('site_subnets').where({ tenant_id: tenantId }).orderBy('site_id').orderBy('cidr')
          : [];
        const suMap = await getSiteUuidMap();
        payload.siteSubnets = rows
          .map((r: any) => ({
            siteUuid:    suMap.get(r.site_id) ?? null,
            cidr:        r.cidr,
            name:        r.name ?? null,
            vlan:        r.vlan ?? null,
            gateway:     r.gateway ?? null,
            description: r.description ?? null,
          }))
          .filter((r: any) => r.siteUuid !== null);
      }

      // ── IP reservations ──────────────────────────────────────────────────────
      if (want('reservations')) {
        const rows  = await db('ip_reservations').where({ tenant_id: tenantId }).orderBy('site_id').orderBy('ip');
        const suMap = await getSiteUuidMap();
        payload.reservations = rows
          .map((r: any) => ({
            siteUuid:    suMap.get(r.site_id) ?? null,
            ip:          r.ip,
            name:        r.name,
            description: r.description ?? null,
            deviceType:  r.device_type ?? null,
            reservedMac: r.reserved_mac ?? null,
          }))
          .filter((r: any) => r.siteUuid !== null);
      }

      // ── Devices: manual ones, plus what a person set on discovered ones ─────
      if (want('siteItems')) {
        const cols  = await optionalItemColumns();
        const rows  = await db('site_items')
          .where({ tenant_id: tenantId })
          .where((q) => {
            q.where('is_manual', true).orWhereNotNull('custom_name').orWhereNotNull('notes');
            if (cols.deviceTypeSource) q.orWhere('device_type_source', 'manual');
            if (cols.alertMode) q.orWhereNot('alert_mode', 'inherit');
          })
          .orderBy('site_id').orderBy('id')
          .select('*');
        const suMap = await getSiteUuidMap();
        payload.siteItems = rows
          .map((r: any) => {
            const typeChosen = r.is_manual || r.device_type_source === 'manual';
            return {
              siteUuid:   suMap.get(r.site_id) ?? null,
              ip:         r.ip,
              mac:        r.mac ?? null,
              isManual:   !!r.is_manual,
              customName: r.custom_name ?? null,
              deviceType: typeChosen ? (r.device_type ?? 'unknown') : null,
              notes:      r.notes ?? null,
              alertMode:  typeof r.alert_mode === 'string' ? r.alert_mode : null,
            };
          })
          // Rows the import would refuse (an IPv6 or unusual address) are left out.
          .filter((r: any) => r.siteUuid !== null && isIPv4(r.ip));
      }

      // ── Vendor → device-type rules ───────────────────────────────────────────
      if (want('vendorRules')) {
        const rows  = await db('vendor_type_rules').where({ tenant_id: tenantId }).orderBy('priority', 'desc').orderBy('id');
        const guMap = await getGroupUuidMap();
        payload.vendorRules = rows
          .map((r: any) => ({
            groupUuid:     r.group_id != null ? (guMap.get(r.group_id) ?? undefined) : null,
            vendorPattern: r.vendor_pattern,
            deviceType:    r.device_type,
            label:         r.label ?? null,
            priority:      r.priority ?? 0,
          }))
          // A rule of a group that no longer resolves would become tenant-wide.
          .filter((r: any) => r.groupUuid !== undefined);
      }

      // ── MAC vendor overrides (platform data, platform admins only) ──────────
      if (want('macVendorOverrides')) {
        const rows = await db('mac_vendors').whereNotNull('custom_name').orderBy('prefix').select('prefix', 'custom_name');
        payload.macVendorOverrides = rows.map((r: any) => ({ prefix: r.prefix, customName: r.custom_name }));
      }

      // ── Custom permission sets (the seeded ones exist everywhere) ───────────
      if (want('permissionSets')) {
        const rows = await db('permission_sets').where({ is_default: false }).orderBy('name');
        payload.permissionSets = rows.map((r: any) => ({
          slug:         r.slug,
          name:         r.name,
          capabilities: parseStoredCapabilities(r.capabilities),
        }));
      }

      void auditService.logReq(req, {
        action: 'export.run',
        resourceType: 'tenant',
        resourceId: tenantId,
        details: { sections, includeSecrets },
      });
      if (includeSecrets && want('notificationChannels')) {
        void auditService.logReq(req, {
          action: 'export.secrets',
          resourceType: 'tenant',
          resourceId: tenantId,
          details: { channels: Array.isArray(payload.notificationChannels) ? payload.notificationChannels.length : 0 },
        });
      }

      const filename = `oblimap-export-${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/json');
      res.json(payload);
    } catch (err) {
      next(err);
    }
  },

  // ── IMPORT ──────────────────────────────────────────────────────────────────

  async importData(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // ── Validate the request, then every selected section ─────────────────
      const request = importRequestSchema.safeParse(req.body);
      if (!request.success) {
        const issues = toIssues(request.error, '');
        res.status(400).json({ success: false, error: `Invalid import request: ${issues[0]?.path || 'body'} — ${issues[0]?.message ?? 'invalid'}`, issues });
        return;
      }
      const { sections, conflictStrategy } = request.data as { sections: ExportSection[]; conflictStrategy: ConflictStrategy };
      const rawData = request.data.data;

      const input: ImportData = {};
      for (const section of new Set(sections)) {
        if (rawData[section] === undefined || rawData[section] === null) continue;
        const parsed = sectionSchemas[section].safeParse(rawData[section]);
        if (!parsed.success) {
          const issues = toIssues(parsed.error, `data.${section}`);
          res.status(400).json({ success: false, error: `Invalid import data: ${issues[0]?.path} — ${issues[0]?.message}`, issues });
          return;
        }
        (input as Record<string, unknown>)[section] = parsed.data;
      }

      const want = (s: ExportSection) => sections.includes(s);
      const tenantId = req.tenantId;
      const userId = toDbId(req.session.userId);
      const isPlatformAdmin = req.session.role === 'admin';

      // Per-section gates beyond the import gate of the route: platform data
      // (platform admins only) and the vendor rules (deviceChecks.manage, as
      // their own routes). Refused before anything is written.
      for (const section of sections) {
        if (input[section] === undefined) continue;
        if (PLATFORM_ADMIN_SECTIONS.includes(section) && !isPlatformAdmin) {
          res.status(403).json({ success: false, error: 'forbidden', section, message: 'Only a platform administrator may import this section' });
          return;
        }
        const capability = SECTION_EXTRA_CAPABILITY[section];
        if (capability && !isPlatformAdmin
          && !(userId !== null && await permissionService.userHasTenantCapability(userId, tenantId, capability))) {
          res.status(403).json({ success: false, error: 'forbidden', capability, section });
          return;
        }
      }

      type SectionResult = { created: number; updated: number; skipped: number; disabled?: number };
      const results: Record<string, SectionResult> = {};
      // Sites whose devices / reservations changed (live refresh after the commit).
      const touchedSiteIds = new Set<number>();
      const itemEvents: ItemEventInput[] = [];
      const permissionSetAudits: Array<{ action: 'permission_set.created' | 'permission_set.updated'; id: number; details: Record<string, unknown> }> = [];
      const changedPermissionSlugs = new Set<string>();
      const macOverridesSet: string[] = [];

      await db.transaction(async (trx) => {
        // The group import rewrites group_closure: serialise with concurrent
        // group create / move / delete of the same tenant.
        if (want('siteGroups') && input.siteGroups) await lockTenantTree(trx, tenantId);

        // ── Pre-populate UUID → DB id maps (scoped to current tenant) ─────────
        const groupIdByUuid:   Map<string, number> = ownUuidMap(
          await trx('monitor_groups').where({ tenant_id: tenantId }).select('id', 'uuid', 'tenant_id'), tenantId);
        const siteIdByUuid:    Map<string, number> = ownUuidMap(
          await trx('sites').where({ tenant_id: tenantId }).select('id', 'uuid', 'tenant_id'), tenantId);
        const channelIdByUuid: Map<string, number> = ownUuidMap(
          await trx('notification_channels').where({ tenant_id: tenantId }).select('id', 'uuid', 'tenant_id'), tenantId);
        const teamIdByUuid:    Map<string, number> = ownUuidMap(
          await trx('user_teams').where({ tenant_id: tenantId }).select('id', 'uuid', 'tenant_id'), tenantId);

        /**
         * Batch resolution map: tracks original-UUID → new DB id for groups
         * imported in this run. Used to resolve parent references for children
         * imported in the same batch (even when generateNew created a fresh UUID).
         */
        const batchGroupByOrigUuid: Map<string, number> = new Map();
        const batchSiteByOrigUuid:  Map<string, number> = new Map();
        // Ids of the groups / sites INSERTED by this import (the settings of
        // 'generateNew' only go to these).
        const createdGroupIds = new Set<number>();
        const createdSiteIds  = new Set<number>();

        const resolveGroup = makeUuidResolver(batchGroupByOrigUuid, groupIdByUuid);
        const resolveSite  = makeUuidResolver(batchSiteByOrigUuid, siteIdByUuid);

        // ── Cross-tenant UUID collision pre-check ─────────────────────────────
        // UUIDs have a global UNIQUE constraint across all tenants. If an imported
        // UUID belongs to a *different* tenant we must never INSERT with that UUID.
        const _uuidsOf = (items: Array<{ uuid?: string | null }> | undefined) =>
          (items ?? []).map((i) => i.uuid).filter((u): u is string => !!u);
        const _importedGroupUuids   = _uuidsOf(input.siteGroups);
        const _importedSiteUuids    = _uuidsOf(input.sites);
        const _importedChannelUuids = _uuidsOf(input.notificationChannels);
        const _importedTeamUuids    = _uuidsOf(input.teams);

        const _toUuidSet = (rows: { uuid: string }[]) => new Set<string>(rows.map(r => r.uuid));

        const foreignGroupUuids   = _importedGroupUuids.length
          ? _toUuidSet(await trx('monitor_groups')       .whereIn('uuid', _importedGroupUuids)  .whereNot({ tenant_id: tenantId }).select('uuid'))
          : new Set<string>();
        const foreignSiteUuids    = _importedSiteUuids.length
          ? _toUuidSet(await trx('sites')                .whereIn('uuid', _importedSiteUuids)   .whereNot({ tenant_id: tenantId }).select('uuid'))
          : new Set<string>();
        const foreignChannelUuids = _importedChannelUuids.length
          ? _toUuidSet(await trx('notification_channels').whereIn('uuid', _importedChannelUuids).whereNot({ tenant_id: tenantId }).select('uuid'))
          : new Set<string>();
        const foreignTeamUuids    = _importedTeamUuids.length
          ? _toUuidSet(await trx('user_teams')           .whereIn('uuid', _importedTeamUuids)   .whereNot({ tenant_id: tenantId }).select('uuid'))
          : new Set<string>();

        function resolveConflict(
          inputUuid: string | null | undefined,
          idMap: Map<string, number>,
          foreignUuids: Set<string>,
        ): { action: 'create'; uuid: string } | { action: 'update'; uuid: string; existingId: number } | { action: 'skip' } {
          if (!inputUuid) {
            return { action: 'create', uuid: randomUUID() };
          }
          if (foreignUuids.has(inputUuid)) {
            return { action: 'create', uuid: randomUUID() };
          }
          const existingId = idMap.get(inputUuid);
          if (existingId === undefined) {
            return { action: 'create', uuid: inputUuid };
          }
          if (conflictStrategy === 'update')      return { action: 'update', uuid: inputUuid, existingId };
          if (conflictStrategy === 'generateNew') return { action: 'create', uuid: randomUUID() };
          /* ignore */                            return { action: 'skip' };
        }

        // ── Site Groups ────────────────────────────────────────────────────────
        if (want('siteGroups') && input.siteGroups) {
          let created = 0, updated = 0, skipped = 0;

          for (const g of topoSortGroups(input.siteGroups)) {
            if (!g.name) { skipped++; continue; }

            const decision = resolveConflict(g.uuid, groupIdByUuid, foreignGroupUuids);
            const parentId = resolveGroup(g.parentUuid);

            if (decision.action === 'skip') {
              if (g.uuid) batchGroupByOrigUuid.set(g.uuid, groupIdByUuid.get(g.uuid)!);
              skipped++;
              continue;
            }

            if (decision.action === 'update') {
              const current = await trx('monitor_groups').where({ id: decision.existingId, tenant_id: tenantId }).first('parent_id');
              const moved = current && (current.parent_id ?? null) !== parentId
                ? await moveGroupTrx(trx, decision.existingId, parentId)
                : false;
              await trx('monitor_groups').where({ uuid: decision.uuid, tenant_id: tenantId }).update({
                name:                g.name,
                description:         g.description ?? null,
                sort_order:          g.sortOrder ?? 0,
                is_general:          g.isGeneral ?? false,
                group_notifications: g.groupNotifications ?? false,
                ...(moved && { parent_id: parentId }),
                updated_at:          new Date(),
              });
              batchGroupByOrigUuid.set(decision.uuid, decision.existingId);
              if (g.uuid && g.uuid !== decision.uuid)
                batchGroupByOrigUuid.set(g.uuid, decision.existingId);
              updated++;
            } else {
              const slug  = await ensureUniqueSlugTrx(trx, slugify(g.name), tenantId);
              const [row] = await trx('monitor_groups').insert({
                uuid:                decision.uuid,
                name:                g.name,
                slug,
                description:         g.description ?? null,
                parent_id:           parentId,
                sort_order:          g.sortOrder ?? 0,
                is_general:          g.isGeneral ?? false,
                group_notifications: g.groupNotifications ?? false,
                tenant_id:           tenantId,
              }).returning('*');

              await insertGroupClosure(trx, row.id, parentId);
              createdGroupIds.add(row.id);
              groupIdByUuid.set(decision.uuid, row.id);
              if (g.uuid) batchGroupByOrigUuid.set(g.uuid, row.id);
              batchGroupByOrigUuid.set(decision.uuid, row.id);
              created++;
            }
          }
          results.siteGroups = { created, updated, skipped };
        }

        // ── Sites ─────────────────────────────────────────────────────────────
        if (want('sites') && input.sites) {
          let created = 0, updated = 0, skipped = 0;

          for (const s of input.sites) {
            if (!s.name) { skipped++; continue; }

            const decision = resolveConflict(s.uuid, siteIdByUuid, foreignSiteUuids);
            const groupId  = resolveGroup(s.groupUuid);

            if (decision.action === 'skip') {
              if (s.uuid) batchSiteByOrigUuid.set(s.uuid, siteIdByUuid.get(s.uuid)!);
              skipped++;
              continue;
            }

            if (decision.action === 'update') {
              await trx('sites').where({ uuid: decision.uuid, tenant_id: tenantId }).update({
                name:        s.name,
                description: s.description ?? null,
                group_id:    groupId,
                updated_at:  new Date(),
              });
              batchSiteByOrigUuid.set(decision.uuid, decision.existingId);
              if (s.uuid && s.uuid !== decision.uuid)
                batchSiteByOrigUuid.set(s.uuid, decision.existingId);
              updated++;
            } else {
              const [row] = await trx('sites').insert({
                uuid:        decision.uuid,
                name:        s.name,
                description: s.description ?? null,
                group_id:    groupId,
                tenant_id:   tenantId,
              }).returning('*');

              createdSiteIds.add(row.id);
              siteIdByUuid.set(decision.uuid, row.id);
              if (s.uuid) batchSiteByOrigUuid.set(s.uuid, row.id);
              batchSiteByOrigUuid.set(decision.uuid, row.id);
              created++;
            }
          }
          results.sites = { created, updated, skipped };
        }

        // ── Settings ─────────────────────────────────────────────────────────
        if (want('settings') && input.settings) {
          let created = 0, updated = 0, skipped = 0;

          for (const s of input.settings) {
            const scope = s.scope;
            let scopeId: number | null = null;

            if (scope !== 'global') {
              if (!s.scopeUuid) { skipped++; continue; }
              scopeId = scope === 'group' ? resolveGroup(s.scopeUuid) : resolveSite(s.scopeUuid);
              if (scopeId === null) { skipped++; continue; }
            }

            // Same per-key validation as the settings API: exports carry the
            // stored (JSON-encoded) text, so decode it first, then normalise.
            let normalized: unknown;
            try {
              normalized = normalizeSettingValue(s.key, decodeSettingValue(s.key, s.value));
            } catch {
              skipped++;
              continue;
            }
            // Same refusal as the settings API: an extra subnet the probe
            // cannot sweep (wider than its minimum prefix).
            if (s.key === 'extraSubnets' && firstTooWideSubnet(normalized) >= 0) { skipped++; continue; }
            const value = JSON.stringify(normalized);
            if (value === undefined || value.length > 65_536) { skipped++; continue; }

            // The conflict strategy decides per (scope, scope_id, key) row.
            // knex turns scope_id: null into IS NULL (global rows).
            const rowKey = { scope, scope_id: scopeId, key: s.key, tenant_id: tenantId };
            const existing = await trx('settings').where(rowKey).first('id') as { id: number } | undefined;
            const targetCreatedInBatch = scope === 'group'
              ? createdGroupIds.has(scopeId as number)
              : scope === 'site'
                ? createdSiteIds.has(scopeId as number)
                : false;
            const action = decideSettingImportAction(conflictStrategy, {
              scope,
              exists: !!existing,
              targetCreatedInBatch,
            });

            if (action === 'skip') { skipped++; continue; }
            if (action === 'update' && existing) {
              await trx('settings').where({ id: existing.id, tenant_id: tenantId }).update({ value, updated_at: new Date() });
              updated++;
            } else {
              await trx('settings').insert({ ...rowKey, value, updated_at: new Date() });
              created++;
            }
          }
          results.settings = { created, updated, skipped };
        }

        // ── Notification Channels ─────────────────────────────────────────────
        if (want('notificationChannels') && input.notificationChannels) {
          let created = 0, updated = 0, skipped = 0, disabled = 0;
          const ownSmtpServerIds = new Set<number>(
            (await trx('smtp_servers').where({ tenant_id: tenantId }).pluck('id')) as number[],
          );

          for (const c of input.notificationChannels) {
            if (!c.name) { skipped++; continue; }

            const decision = resolveConflict(c.uuid, channelIdByUuid, foreignChannelUuids);

            if (decision.action === 'skip') { skipped++; continue; }

            const existingRow = decision.action === 'update'
              ? await trx('notification_channels').where({ id: decision.existingId, tenant_id: tenantId }).first('config', 'type') as { config: unknown; type: string } | undefined
              : undefined;
            let enabled = c.isEnabled ?? true;

            // An update without a config keeps the stored one (same type).
            const keepStoredConfig = !!existingRow && existingRow.type === c.type
              && (c.config === null || c.config === undefined);
            let channelConfig: Record<string, unknown> | null = null;
            if (!keepStoredConfig) {
              // A channel without a config cannot send: imported disabled.
              if (c.config === null || c.config === undefined) enabled = false;
              const incoming = c.config ?? {};
              const stored = parseChannelConfig(existingRow?.config);
              // Redacted secrets keep the value of the channel being updated,
              // unless the target (URL / server / host) changes too: stored
              // secrets never follow a placeholder to a new destination. A
              // secret that cannot be restored leaves the channel disabled.
              channelConfig = restoreRedactedConfig(incoming, redactedSecretsRetargeted(incoming, stored) ? {} : stored);
              const restored = channelConfig;
              const missingSecret = Object.entries(incoming).some(([k, v]) => v === REDACTED && restored[k] === undefined);
              if (missingSecret) enabled = false;

              // An SMTP server reference must point at a server of this
              // tenant; an smtp channel without one (legacy inline host and
              // credentials) is imported disabled.
              const rawSmtpId = channelConfig.smtpServerId;
              if (rawSmtpId !== undefined && rawSmtpId !== null && rawSmtpId !== '') {
                const smtpId = toDbId(rawSmtpId);
                if (smtpId === null || !ownSmtpServerIds.has(smtpId)) {
                  delete channelConfig.smtpServerId;
                  enabled = false;
                }
              } else if (c.type === 'smtp') {
                enabled = false;
              }
            }
            if (!enabled && (c.isEnabled ?? true)) disabled++;

            const channelRow: Record<string, unknown> = {
              name:       c.name,
              type:       c.type,
              is_enabled: enabled,
              tenant_id:  tenantId,
              updated_at: new Date(),
            };
            if (channelConfig !== null) channelRow.config = JSON.stringify(channelConfig);

            let channelId: number;
            if (decision.action === 'update') {
              await trx('notification_channels').where({ uuid: decision.uuid, tenant_id: tenantId }).update(channelRow);
              channelId = decision.existingId;
              updated++;
            } else {
              const [inserted] = await trx('notification_channels')
                .insert({ ...channelRow, uuid: decision.uuid })
                .returning('id');
              channelId = inserted.id;
              if (c.uuid) channelIdByUuid.set(c.uuid, channelId);
              channelIdByUuid.set(decision.uuid, channelId);
              created++;
            }

            // Rebuild this tenant's bindings of the channel (bindings other
            // tenants made to a shared channel are left alone).
            if (c.bindings) {
              await trx('notification_bindings').where({ channel_id: channelId, tenant_id: tenantId }).del();
              const seen = new Set<string>();
              for (const b of c.bindings) {
                let bScopeId: number | null = null;

                if (b.scope !== 'global') {
                  if (!b.scopeUuid) continue;
                  bScopeId = b.scope === 'group' ? resolveGroup(b.scopeUuid) : resolveSite(b.scopeUuid);
                  if (bScopeId === null) continue;
                }

                const dedupKey = `${b.scope}:${bScopeId ?? ''}`;
                if (seen.has(dedupKey)) continue;
                seen.add(dedupKey);

                await trx('notification_bindings').insert({
                  tenant_id:     tenantId,
                  channel_id:    channelId,
                  scope:         b.scope,
                  scope_id:      bScopeId,
                  override_mode: b.overrideMode ?? 'merge',
                });
              }
            }
          }
          results.notificationChannels = { created, updated, skipped, disabled };
        }

        // ── Teams ─────────────────────────────────────────────────────────────
        if (want('teams') && input.teams) {
          let created = 0, updated = 0, skipped = 0;

          for (const t of input.teams) {
            if (!t.name) { skipped++; continue; }

            const decision = resolveConflict(t.uuid, teamIdByUuid, foreignTeamUuids);

            if (decision.action === 'skip') { skipped++; continue; }

            const teamRow: Record<string, unknown> = {
              name:        t.name,
              description: t.description ?? null,
              can_create:  t.canCreate ?? false,
              tenant_id:   tenantId,
              updated_at:  new Date(),
            };

            let teamId: number;
            if (decision.action === 'update') {
              // Name taken by another team of this tenant: keep the current name.
              // (Checked up front: a failed statement would abort the transaction.)
              const nameConflict = await trx('user_teams')
                .where({ name: t.name, tenant_id: tenantId })
                .whereNot({ id: decision.existingId })
                .first('id');
              const { name: _name, ...withoutName } = teamRow;
              await trx('user_teams')
                .where({ uuid: decision.uuid, tenant_id: tenantId })
                .update(nameConflict ? withoutName : teamRow);
              teamId = decision.existingId;
              updated++;
            } else {
              // Skip if a different team in this tenant already owns this name
              const nameConflict = await trx('user_teams').where({ name: t.name, tenant_id: tenantId }).first();
              if (nameConflict) { skipped++; continue; }

              const [inserted] = await trx('user_teams').insert({ ...teamRow, uuid: decision.uuid }).returning('id');
              teamId = inserted.id;
              if (t.uuid) teamIdByUuid.set(t.uuid, teamId);
              teamIdByUuid.set(decision.uuid, teamId);
              created++;
            }

            if (t.permissions) {
              await trx('team_permissions').where({ team_id: teamId }).del();
              for (const p of t.permissions) {
                if (!p.scopeUuid) continue;

                const scopeId = p.scope === 'group' ? resolveGroup(p.scopeUuid) : resolveSite(p.scopeUuid);
                if (scopeId === null) continue;

                await trx('team_permissions').insert({
                  team_id:  teamId,
                  scope:    p.scope,
                  scope_id: scopeId,
                  level:    p.level ?? 'ro',
                }).onConflict(['team_id', 'scope', 'scope_id']).ignore();
              }
            }
          }
          results.teams = { created, updated, skipped };
        }

        // ── IPAM rows of a site ───────────────────────────────────────────────
        // The site is resolved by UUID in this tenant only (records written by
        // this import first). The conflict strategy decides per row as for
        // the site settings: 'generateNew' fills only the sites this import
        // created (the copies).
        const decideSiteRow = (siteId: number, exists: boolean) => decideSettingImportAction(conflictStrategy, {
          scope: 'site',
          exists,
          targetCreatedInBatch: createdSiteIds.has(siteId),
        });

        // ── Site subnets ─────────────────────────────────────────────────────
        if (want('siteSubnets') && input.siteSubnets) {
          let created = 0, updated = 0, skipped = 0;
          const tableReady = await trx.schema.hasTable('site_subnets');
          for (const s of input.siteSubnets) {
            const siteId = tableReady ? resolveSite(s.siteUuid) : null;
            if (siteId === null) { skipped++; continue; }
            // Same rules as the subnets API: /16 – /30, gateway inside the subnet.
            const net = parseSubnet(s.cidr);
            if (!net || net.prefix < SITE_SUBNET_MIN_PREFIX || net.prefix > SITE_SUBNET_MAX_PREFIX) { skipped++; continue; }
            const gateway = s.gateway ? s.gateway : null;
            if (gateway !== null && !isHostOf(net, gateway)) { skipped++; continue; }
            const cidr = formatCidr(net);

            const existing = await trx('site_subnets').where({ tenant_id: tenantId, site_id: siteId, cidr }).first('id') as { id: number } | undefined;
            const action = decideSiteRow(siteId, !!existing);
            if (action === 'skip') { skipped++; continue; }
            const fields = {
              name:        s.name || null,
              vlan:        s.vlan ?? null,
              gateway,
              description: s.description || null,
            };
            if (action === 'update' && existing) {
              await trx('site_subnets').where({ id: existing.id, tenant_id: tenantId }).update({ ...fields, updated_at: new Date() });
              updated++;
            } else {
              await trx('site_subnets').insert({ ...fields, tenant_id: tenantId, site_id: siteId, cidr, created_by: userId });
              created++;
            }
          }
          results.siteSubnets = { created, updated, skipped };
        }

        // ── IP reservations ──────────────────────────────────────────────────
        if (want('reservations') && input.reservations) {
          let created = 0, updated = 0, skipped = 0;
          for (const r of input.reservations) {
            const siteId = resolveSite(r.siteUuid);
            if (siteId === null) { skipped++; continue; }

            const existing = await trx('ip_reservations').where({ tenant_id: tenantId, site_id: siteId, ip: r.ip }).first('id') as { id: number } | undefined;
            const action = decideSiteRow(siteId, !!existing);
            if (action === 'skip') { skipped++; continue; }
            const fields = {
              name:         r.name,
              description:  r.description || null,
              device_type:  r.deviceType ?? null,
              reserved_mac: r.reservedMac ?? null,
            };
            if (action === 'update' && existing) {
              await trx('ip_reservations').where({ id: existing.id, tenant_id: tenantId }).update({ ...fields, updated_at: new Date() });
              updated++;
            } else {
              await trx('ip_reservations').insert({ ...fields, tenant_id: tenantId, site_id: siteId, ip: r.ip, created_by: userId });
              created++;
            }
            touchedSiteIds.add(siteId);
          }
          results.reservations = { created, updated, skipped };
        }

        // ── Devices ──────────────────────────────────────────────────────────
        // Matched as the manual-device duplicate guard does: by MAC, else by
        // IP (a row without MAC on that IP). A manual device that does not
        // exist is created; a discovered one cannot be (the probes report
        // it), only its name / type / notes / alert mode are applied.
        if (want('siteItems') && input.siteItems) {
          let created = 0, updated = 0, skipped = 0;
          const cols = await optionalItemColumns();
          const lockedSites = new Set<number>();
          for (const it of input.siteItems) {
            const siteId = resolveSite(it.siteUuid);
            if (siteId === null) { skipped++; continue; }
            if (!lockedSites.has(siteId)) {
              // Serialised with manual creates of the site (siteService.createManualItem).
              await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`oblimap:site-manual-item:${siteId}`]);
              lockedSites.add(siteId);
            }
            const mac = it.mac ?? null;
            type ItemMatch = { id: number; mac: string | null; ip: string };
            // The MAC match wins: falling back to a MAC-less row on the IP
            // only when no device has that MAC (never two rows with one MAC).
            let existing: ItemMatch | undefined;
            if (mac) {
              existing = await trx('site_items')
                .where({ site_id: siteId, tenant_id: tenantId, mac })
                .orderBy('id', 'asc')
                .first('id', 'mac', 'ip') as ItemMatch | undefined;
              if (!existing) {
                existing = await trx('site_items')
                  .where({ site_id: siteId, tenant_id: tenantId, ip: it.ip })
                  .whereNull('mac')
                  .orderBy('id', 'asc')
                  .first('id', 'mac', 'ip') as ItemMatch | undefined;
              }
            } else {
              existing = await trx('site_items')
                .where({ site_id: siteId, tenant_id: tenantId, ip: it.ip })
                .orderBy('id', 'asc')
                .first('id', 'mac', 'ip') as ItemMatch | undefined;
            }

            const action = decideSiteRow(siteId, !!existing);
            if (action === 'skip') { skipped++; continue; }

            if (action === 'update' && existing) {
              const patch: Record<string, unknown> = {
                custom_name: it.customName || null,
                notes:       it.notes || null,
                updated_at:  new Date(),
              };
              if (it.deviceType) Object.assign(patch, await deviceTypePatch(trx, it.deviceType));
              if (it.alertMode && cols.alertMode) patch.alert_mode = it.alertMode;
              if (mac && !existing.mac) patch.mac = mac;
              await trx('site_items').where({ id: existing.id, site_id: siteId, tenant_id: tenantId }).update(patch);
              updated++;
              itemEvents.push({
                tenantId, siteId, itemId: Number(existing.id), mac: mac ?? existing.mac, ip: existing.ip,
                kind: 'edited', actorUserId: userId, details: { source: 'import' },
              });
            } else {
              if (!it.isManual) { skipped++; continue; }
              const row = await manualItemRow(tenantId, siteId, {
                ip: it.ip,
                mac,
                customName: it.customName || null,
                deviceType: it.deviceType,
                notes: it.notes || null,
              });
              if (it.alertMode && cols.alertMode) row.alert_mode = it.alertMode;
              const [inserted] = await trx('site_items').insert(row).returning('id') as Array<{ id: number }>;
              created++;
              itemEvents.push({
                tenantId, siteId, itemId: Number(inserted.id), mac, ip: it.ip,
                kind: 'created', actorUserId: userId, details: { source: 'import', deviceType: it.deviceType ?? 'unknown' },
              });
            }
            touchedSiteIds.add(siteId);
          }
          results.siteItems = { created, updated, skipped };
        }

        // ── Vendor → device-type rules ───────────────────────────────────────
        // Keyed by (group, pattern) — no UUID. A tenant-wide rule follows the
        // global settings rule, a group rule the group settings rule.
        if (want('vendorRules') && input.vendorRules) {
          let created = 0, updated = 0, skipped = 0;
          for (const v of input.vendorRules) {
            let groupId: number | null = null;
            if (v.groupUuid) {
              groupId = resolveGroup(v.groupUuid);
              if (groupId === null) { skipped++; continue; }
            }
            const existing = await trx('vendor_type_rules')
              .where({ tenant_id: tenantId })
              .where((q) => { if (groupId === null) q.whereNull('group_id'); else q.where('group_id', groupId); })
              .whereRaw('lower(vendor_pattern) = lower(?)', [v.vendorPattern])
              .orderBy('id', 'asc')
              .first('id') as { id: number } | undefined;
            const action = decideSettingImportAction(conflictStrategy, {
              scope: groupId === null ? 'global' : 'group',
              exists: !!existing,
              targetCreatedInBatch: groupId !== null && createdGroupIds.has(groupId),
            });
            if (action === 'skip') { skipped++; continue; }
            const fields = {
              vendor_pattern: v.vendorPattern,
              device_type:    v.deviceType,
              label:          v.label || null,
              priority:       v.priority ?? 0,
            };
            if (action === 'update' && existing) {
              await trx('vendor_type_rules').where({ id: existing.id, tenant_id: tenantId }).update({ ...fields, updated_at: new Date() });
              updated++;
            } else {
              await trx('vendor_type_rules').insert({ ...fields, tenant_id: tenantId, group_id: groupId });
              created++;
            }
          }
          results.vendorRules = { created, updated, skipped };
        }

        // ── Custom permission sets (platform-wide, platform admins only) ─────
        // Keyed by slug. The seeded sets are never touched; 'update' renames
        // a custom set and replaces its capabilities.
        if (want('permissionSets') && input.permissionSets) {
          let created = 0, updated = 0, skipped = 0;
          for (const p of input.permissionSets) {
            const capabilities = parseStoredCapabilities(p.capabilities ?? []);
            const existing = await trx('permission_sets').where({ slug: p.slug }).forUpdate().first('id', 'name', 'capabilities', 'is_default') as
              { id: number; name: string; capabilities: unknown; is_default: boolean } | undefined;
            if (existing?.is_default) { skipped++; continue; }
            const action = decideSettingImportAction(conflictStrategy, { scope: 'global', exists: !!existing, targetCreatedInBatch: false });
            if (action === 'skip') { skipped++; continue; }
            if (action === 'update' && existing) {
              const before = parseStoredCapabilities(existing.capabilities);
              await trx('permission_sets').where({ id: existing.id }).update({ name: p.name, capabilities: JSON.stringify(capabilities) });
              updated++;
              const added = capabilities.filter((c) => !before.includes(c));
              const removed = before.filter((c) => !capabilities.includes(c));
              if (added.length > 0 || removed.length > 0) changedPermissionSlugs.add(p.slug);
              if (added.length > 0 || removed.length > 0 || existing.name !== p.name) {
                permissionSetAudits.push({
                  action: 'permission_set.updated',
                  id: Number(existing.id),
                  details: {
                    slug: p.slug,
                    source: 'import',
                    ...(existing.name !== p.name ? { name: { from: existing.name, to: p.name } } : {}),
                    ...(added.length > 0 ? { added } : {}),
                    ...(removed.length > 0 ? { removed } : {}),
                  },
                });
              }
            } else {
              const [row] = await trx('permission_sets').insert({
                name: p.name,
                slug: p.slug,
                capabilities: JSON.stringify(capabilities),
                is_default: false,
                created_at: new Date(),
              }).returning('id') as Array<{ id: number }>;
              created++;
              permissionSetAudits.push({
                action: 'permission_set.created',
                id: Number(row.id),
                details: { name: p.name, slug: p.slug, capabilities, source: 'import' },
              });
            }
          }
          results.permissionSets = { created, updated, skipped };
        }

        // ── MAC vendor overrides (platform data, platform admins only) ───────
        // Only prefixes of the IEEE table can carry an override; an existing
        // override is "the row exists" for the conflict strategy.
        if (want('macVendorOverrides') && input.macVendorOverrides) {
          let created = 0, updated = 0, skipped = 0;
          for (const o of input.macVendorOverrides) {
            const existing = await trx('mac_vendors').where({ prefix: o.prefix }).first('custom_name') as
              { custom_name: string | null } | undefined;
            if (!existing) { skipped++; continue; }
            const action = decideSettingImportAction(conflictStrategy, { scope: 'global', exists: existing.custom_name !== null, targetCreatedInBatch: false });
            if (action === 'skip' || existing.custom_name === o.customName) { skipped++; continue; }
            await trx('mac_vendors').where({ prefix: o.prefix }).update({ custom_name: o.customName, updated_at: new Date() });
            if (action === 'update') updated++; else created++;
            macOverridesSet.push(o.prefix);
          }
          results.macVendorOverrides = { created, updated, skipped };
        }

      }); // end transaction

      // ── After the commit ────────────────────────────────────────────────────
      afterSitesChanged(tenantId, touchedSiteIds);
      if (itemEvents.length > 0) void recordItemEvents(itemEvents);
      if (permissionSetAudits.length > 0) {
        invalidateTenantCapabilityCache();
        for (const a of permissionSetAudits) {
          void auditService.logReq(req, { tenantId: null, action: a.action, resourceType: 'permission_set', resourceId: a.id, details: a.details });
        }
      }
      if (changedPermissionSlugs.size > 0) {
        try {
          const slugs = [...changedPermissionSlugs];
          // The legacy 'member' role reads as the 'viewer' set.
          const roles = slugs.includes('viewer') ? [...slugs, LEGACY_MEMBER_ROLE] : slugs;
          const holders = await db('user_tenants').whereIn('role', roles).distinct('user_id') as Array<{ user_id: number }>;
          emitPermissionsChanged(holders.map((h) => Number(h.user_id)));
        } catch (err) {
          logger.warn({ err: (err as Error)?.message }, 'Permission change push after an import failed');
        }
      }
      if (macOverridesSet.length > 0) {
        clearVendorLookupCache();
        void auditService.logReq(req, {
          tenantId: null,
          action: 'mac_vendor.override_set',
          resourceType: 'mac_vendor',
          resourceId: null,
          details: { source: 'import', count: macOverridesSet.length, prefixes: macOverridesSet.slice(0, 50) },
        });
      }

      void auditService.logReq(req, {
        action: 'import.run',
        resourceType: 'tenant',
        resourceId: tenantId,
        details: { sections, conflictStrategy, results },
      });
      res.json({ success: true, data: results });
    } catch (err) {
      // The error reaches the generic handler (500 without details); the
      // server log keeps the full error.
      logger.error({ err }, 'Import failed');
      next(err);
    }
  },

  // ── CSV IMPORT (reservations / devices of one site) ──────────────────────────
  // The routes check site write on body.siteId (in req.tenantId) first.

  /** POST /admin/import/csv/preview {siteId, kind, csv} — no write. */
  async csvPreview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const request = readCsvRequest(req, res, csvRequestSchema);
      if (!request) return;
      const { siteId, parsed } = request;
      const kind = request.body.kind as CsvImportKind;
      const snapshot = await loadCsvSiteSnapshot(db, req.tenantId, siteId);
      const counts: Record<CsvRowStatus, number> = { new: 0, update: 0, conflict: 0, invalid: 0 };
      const rows = parsed.rows.map((row) => {
        const c = classifyCsvRow(kind, row, snapshot);
        counts[c.status]++;
        if (c.status === 'new') rememberCsvRow(kind, snapshot, row, -row.line);
        return previewRow(row, c);
      });
      res.json({
        success: true,
        data: {
          kind,
          siteId,
          hasHeader: parsed.columns.hasHeader,
          columns: Object.keys(parsed.columns.map),
          counts,
          rows,
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /admin/import/csv/commit {siteId, kind, csv, strategy} — one
   * transaction; the rows are classified again against the site as it is
   * then (a preview may be stale). Conflicts and invalid rows are skipped.
   */
  async csvCommit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const request = readCsvRequest(req, res, csvCommitSchema);
      if (!request) return;
      const { siteId, parsed } = request;
      const kind = request.body.kind as CsvImportKind;
      const strategy = request.body.strategy as CsvCommitStrategy;
      const tenantId = req.tenantId;
      const userId = toDbId(req.session.userId);

      const counts = { created: 0, updated: 0, skipped: 0, conflicts: 0, invalid: 0 };
      const events: ItemEventInput[] = [];

      await db.transaction(async (trx) => {
        if (kind === 'devices') {
          // Serialised with manual creates of the site (siteService.createManualItem).
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`oblimap:site-manual-item:${siteId}`]);
        } else {
          // Serialises concurrent CSV reservation imports of the site.
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`oblimap:site-reservations:${siteId}`]);
        }
        const site = await trx('sites').where({ id: siteId, tenant_id: tenantId }).forShare().first('id');
        if (!site) throw new AppError(404, 'Site not found');
        const snapshot = await loadCsvSiteSnapshot(trx, tenantId, siteId);

        for (const row of parsed.rows) {
          const c = classifyCsvRow(kind, row, snapshot);
          if (c.status === 'invalid') { counts.invalid++; continue; }
          if (c.status === 'conflict') { counts.conflicts++; continue; }
          const action = csvRowAction(c.status, strategy);
          if (action === 'skip') { counts.skipped++; continue; }

          if (kind === 'reservations') {
            if (action === 'update' && c.existingId !== undefined) {
              const patch: Record<string, unknown> = { name: row.name, updated_at: new Date() };
              if (row.description) patch.description = row.description;
              if (row.deviceType) patch.device_type = row.deviceType;
              if (row.mac) patch.reserved_mac = row.mac;
              await trx('ip_reservations').where({ id: c.existingId, site_id: siteId, tenant_id: tenantId }).update(patch);
              counts.updated++;
            } else {
              // A reservation created meanwhile by the reservations API (which
              // takes no lock) is counted as a conflict, never a 500.
              const inserted = await trx('ip_reservations').insert({
                site_id: siteId,
                tenant_id: tenantId,
                ip: row.ip,
                name: row.name,
                description: row.description || null,
                device_type: row.deviceType ?? null,
                reserved_mac: row.mac,
                created_by: userId,
              }).onConflict(['site_id', 'ip']).ignore().returning('id') as Array<{ id: number }>;
              if (inserted.length === 0) { counts.conflicts++; continue; }
              counts.created++;
              rememberCsvRow(kind, snapshot, row, -row.line);
            }
            continue;
          }

          // devices: empty cells keep the stored value.
          if (action === 'update' && c.existingId !== undefined) {
            const patch: Record<string, unknown> = { updated_at: new Date() };
            if (row.name) patch.custom_name = row.name;
            if (row.notes) patch.notes = row.notes;
            if (row.deviceType) Object.assign(patch, await deviceTypePatch(trx, row.deviceType));
            if (row.mac) patch.mac = trx.raw('COALESCE(mac, ?)', [row.mac]);
            await trx('site_items').where({ id: c.existingId, site_id: siteId, tenant_id: tenantId }).update(patch);
            counts.updated++;
            events.push({
              tenantId, siteId, itemId: c.existingId, mac: row.mac, ip: row.ip,
              kind: 'edited', actorUserId: userId, details: { source: 'csv_import' },
            });
          } else {
            const insertRow = await manualItemRow(tenantId, siteId, {
              ip: row.ip,
              mac: row.mac,
              customName: row.name || null,
              deviceType: row.deviceType,
              notes: row.notes || null,
            });
            const [inserted] = await trx('site_items').insert(insertRow).returning('id') as Array<{ id: number }>;
            counts.created++;
            rememberCsvRow(kind, snapshot, row, Number(inserted.id));
            events.push({
              tenantId, siteId, itemId: Number(inserted.id), mac: row.mac, ip: row.ip,
              kind: 'created', actorUserId: userId, details: { source: 'csv_import', deviceType: row.deviceType ?? 'unknown' },
            });
          }
        }
      });

      if (counts.created + counts.updated > 0) afterSitesChanged(tenantId, [siteId]);
      if (events.length > 0) void recordItemEvents(events);
      void auditService.logReq(req, {
        action: 'import.csv',
        resourceType: 'site',
        resourceId: siteId,
        details: { siteId, kind, strategy, rows: parsed.rows.length, ...counts },
      });
      res.json({ success: true, data: counts });
    } catch (err) {
      next(err);
    }
  },
};
