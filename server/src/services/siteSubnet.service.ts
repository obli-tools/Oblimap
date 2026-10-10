import type { Knex } from 'knex';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { ipv4ToInt, parseIPv4Cidr } from '../validators/probe.schema';
import { flowService } from './flow.service';
import { pushConfigToAffectedProbes } from './deviceChecks/config.service';

// Real subnets of a site: rows of site_subnets (metadata named by an
// admin) merged with the prefixes the site's approved probes report as
// scanned (probes.last_scanned_subnets). IPv4 only; every CIDR is normalised
// to its network address. The CIDR math below is pure (unit-tested).

// ── CIDR math ────────────────────────────────────────────────────────────────

/** Prefix range accepted for a subnet created or edited by a user. */
export const SITE_SUBNET_MIN_PREFIX = 16;
export const SITE_SUBNET_MAX_PREFIX = 30;
/** Probe prefixes wider than this are ignored (never a LAN; parseProbePush drops them too). */
export const PROBE_SUBNET_MIN_PREFIX = 8;
/** next-free / used counting never walks more addresses than a /16. */
const NEXT_FREE_MIN_PREFIX = 16;

export interface Ipv4Range {
  /** Network address (host bits cleared), unsigned 32-bit. */
  base: number;
  prefix: number;
}

export function intToIpv4(n: number): string {
  return [
    Math.floor(n / 16_777_216) % 256,
    Math.floor(n / 65_536) % 256,
    Math.floor(n / 256) % 256,
    n % 256,
  ].join('.');
}

/** "10.0.1.7/22" → { base: 10.0.0.0, prefix: 22 }; anything else (IPv6 included) → null. */
export function parseSubnet(value: unknown): Ipv4Range | null {
  return parseIPv4Cidr(value);
}

/** "10.0.1.7/22" → "10.0.0.0/22"; null when not an IPv4 CIDR. */
export function normalizeCidr(value: unknown): string | null {
  const net = parseSubnet(value);
  return net ? formatCidr(net) : null;
}

export function formatCidr(net: Ipv4Range): string {
  return `${intToIpv4(net.base)}/${net.prefix}`;
}

export function subnetSize(net: Ipv4Range): number {
  return 2 ** (32 - net.prefix);
}

/**
 * Host addresses of the subnet: 2^(32-prefix) − 2 (network and broadcast
 * excluded); a /31 is a point-to-point link with two hosts (RFC 3021), a /32
 * one host.
 */
export function usableHosts(prefix: number): number {
  if (prefix >= 32) return 1;
  if (prefix === 31) return 2;
  return 2 ** (32 - prefix) - 2;
}

/** First and last host address (network / broadcast excluded below /31). */
export function hostRange(net: Ipv4Range): { first: number; last: number } {
  const size = subnetSize(net);
  if (net.prefix >= 31) return { first: net.base, last: net.base + size - 1 };
  return { first: net.base + 1, last: net.base + size - 2 };
}

export function cidrContains(net: Ipv4Range, ip: unknown): boolean {
  const n = ipv4ToInt(ip);
  return n !== null && n >= net.base && n < net.base + subnetSize(net);
}

/** True when the IP is a host address of the subnet (not its network / broadcast). */
export function isHostOf(net: Ipv4Range, ip: unknown): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const { first, last } = hostRange(net);
  return n >= first && n <= last;
}

/** Distinct host addresses of the subnet among the given IPs (items + reservations). */
export function countUsed(net: Ipv4Range, ips: Iterable<unknown>): number {
  const seen = new Set<number>();
  const { first, last } = hostRange(net);
  for (const ip of ips) {
    const n = ipv4ToInt(ip);
    if (n !== null && n >= first && n <= last) seen.add(n);
  }
  return seen.size;
}

/**
 * First host address of the subnet that is neither used (items,
 * reservations) nor skipped (the gateway); network and broadcast are never
 * returned. null when the subnet is full.
 */
export function nextFreeIp(net: Ipv4Range, used: Iterable<unknown>, skip: Iterable<unknown> = []): string | null {
  const taken = new Set<number>();
  for (const ip of [...used, ...skip]) {
    const n = ipv4ToInt(ip);
    if (n !== null) taken.add(n);
  }
  const { first, last } = hostRange(net);
  for (let n = first; n <= last; n++) {
    if (!taken.has(n)) return intToIpv4(n);
  }
  return null;
}

// ── Merge ────────────────────────────────────────────────────────────────────

export type SiteSubnetSource = 'manual' | 'probe' | 'manual+probe';

export interface SiteSubnetRow {
  id: number;
  uuid: string;
  cidr: string;
  name: string | null;
  vlan: number | null;
  gateway: string | null;
  description: string | null;
  created_by: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ProbeSubnetReport {
  probeId: number;
  subnets: unknown;
  lastScanAt: Date | string | null;
}

export interface SiteSubnet {
  /** site_subnets row id; null for a prefix only a probe reports (no metadata yet). */
  id: number | null;
  uuid: string | null;
  cidr: string;
  prefix: number;
  networkAddress: string;
  broadcastAddress: string | null;
  name: string | null;
  vlan: number | null;
  gateway: string | null;
  description: string | null;
  source: SiteSubnetSource;
  /** Probes reporting this prefix as scanned. */
  probeIds: number[];
  /** Distinct host addresses used by a device or a reservation. */
  used: number;
  usable: number;
  /** Latest scan of a probe reporting this prefix; null when no probe does. */
  lastScannedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function stringList(v: unknown): string[] {
  let x = v;
  if (typeof x === 'string') {
    try { x = JSON.parse(x); } catch { return []; }
  }
  return Array.isArray(x) ? x.filter((e): e is string => typeof e === 'string') : [];
}

/**
 * Manual rows + probe-reported prefixes → one entry per normalised CIDR,
 * sorted by network address then prefix. A probe prefix with a row keeps the
 * row's metadata ('manual+probe'); without one it is 'probe'. IPv6 and
 * prefixes wider than /8 reported by a probe are ignored. Pure.
 */
export function mergeSiteSubnets(
  rows: readonly SiteSubnetRow[],
  reports: readonly ProbeSubnetReport[],
  usedIps: readonly unknown[],
): SiteSubnet[] {
  const byCidr = new Map<string, { net: Ipv4Range; row: SiteSubnetRow | null; probeIds: Set<number>; lastScan: number | null }>();

  for (const row of rows) {
    const net = parseSubnet(row.cidr);
    if (!net) continue;
    const cidr = formatCidr(net);
    if (!byCidr.has(cidr)) byCidr.set(cidr, { net, row, probeIds: new Set(), lastScan: null });
  }

  for (const report of reports) {
    const scanAt = report.lastScanAt == null ? null : new Date(report.lastScanAt).getTime();
    for (const raw of stringList(report.subnets)) {
      const net = parseSubnet(raw);
      if (!net || net.prefix < PROBE_SUBNET_MIN_PREFIX) continue;
      const cidr = formatCidr(net);
      let entry = byCidr.get(cidr);
      if (!entry) {
        entry = { net, row: null, probeIds: new Set(), lastScan: null };
        byCidr.set(cidr, entry);
      }
      entry.probeIds.add(report.probeId);
      if (scanAt !== null && !Number.isNaN(scanAt) && (entry.lastScan === null || scanAt > entry.lastScan)) {
        entry.lastScan = scanAt;
      }
    }
  }

  const out: SiteSubnet[] = [];
  for (const [cidr, e] of byCidr) {
    const fromProbe = e.probeIds.size > 0;
    const source: SiteSubnetSource = e.row ? (fromProbe ? 'manual+probe' : 'manual') : 'probe';
    out.push({
      id: e.row ? Number(e.row.id) : null,
      uuid: e.row ? e.row.uuid : null,
      cidr,
      prefix: e.net.prefix,
      networkAddress: intToIpv4(e.net.base),
      broadcastAddress: e.net.prefix >= 31 ? null : intToIpv4(e.net.base + subnetSize(e.net) - 1),
      name: e.row?.name ?? null,
      vlan: e.row?.vlan == null ? null : Number(e.row.vlan),
      gateway: e.row?.gateway ?? null,
      description: e.row?.description ?? null,
      source,
      probeIds: [...e.probeIds].sort((a, b) => a - b),
      used: countUsed(e.net, usedIps),
      usable: usableHosts(e.net.prefix),
      lastScannedAt: e.lastScan === null ? null : new Date(e.lastScan).toISOString(),
      createdAt: e.row ? iso(e.row.created_at) : null,
      updatedAt: e.row ? iso(e.row.updated_at) : null,
    });
  }
  return out.sort((a, b) => {
    const na = ipv4ToInt(a.networkAddress) ?? 0;
    const nb = ipv4ToInt(b.networkAddress) ?? 0;
    return na - nb || a.prefix - b.prefix;
  });
}

// ── Validation of user input ─────────────────────────────────────────────────

/**
 * A user-supplied CIDR: IPv4, prefix /16–/30, normalised. Throws a 400
 * AppError otherwise.
 */
export function requireUserCidr(value: unknown): Ipv4Range {
  const net = parseSubnet(value);
  if (!net) throw new AppError(400, 'Invalid IPv4 CIDR (e.g. 192.168.1.0/24)');
  if (net.prefix < SITE_SUBNET_MIN_PREFIX || net.prefix > SITE_SUBNET_MAX_PREFIX) {
    throw new AppError(400, `The prefix must be between /${SITE_SUBNET_MIN_PREFIX} and /${SITE_SUBNET_MAX_PREFIX}`);
  }
  return net;
}

/** The gateway, when set, must be a host address of the subnet (400 otherwise). */
export function assertGatewayInSubnet(net: Ipv4Range, gateway: string | null | undefined): void {
  if (gateway == null) return;
  if (!isHostOf(net, gateway)) {
    throw new AppError(400, `The gateway must be a host address inside ${formatCidr(net)}`);
  }
}

// ── Service ──────────────────────────────────────────────────────────────────

export interface SiteSubnetInput {
  cidr: string;
  name?: string | null;
  vlan?: number | null;
  gateway?: string | null;
  description?: string | null;
}

export type SiteSubnetPatch = Partial<SiteSubnetInput>;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

function emptyToNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = v.trim();
  return s === '' ? null : s;
}

async function usedIpsOfSite(tenantId: number, siteId: number, conn: Knex | Knex.Transaction = db): Promise<string[]> {
  const [items, reservations] = await Promise.all([
    conn('site_items').where({ site_id: siteId, tenant_id: tenantId }).whereNotNull('ip').pluck('ip') as Promise<string[]>,
    conn('ip_reservations').where({ site_id: siteId, tenant_id: tenantId }).pluck('ip') as Promise<string[]>,
  ]);
  return [...items, ...reservations];
}

const CHECKS_REFRESH_DELAY_MS = 2_000;
const pendingChecksRefresh = new Set<string>();

/** Device Checks assignment re-sent after devices were removed (coalesced; never throws). */
function refreshDeviceChecks(tenantId: number, siteId: number): void {
  const key = `${tenantId}:${siteId}`;
  if (pendingChecksRefresh.has(key)) return;
  pendingChecksRefresh.add(key);
  const timer = setTimeout(() => {
    pendingChecksRefresh.delete(key);
    pushConfigToAffectedProbes(tenantId, [siteId]).catch((err: unknown) =>
      logger.warn({ err: (err as Error)?.message, tenantId, siteId }, 'Device checks config push after a subnet delete failed'));
  }, CHECKS_REFRESH_DELAY_MS);
  timer.unref?.();
}

/** A device removed by deleteItemsInCidr (for the per-device 'deleted' item events). */
export interface RemovedSiteItem {
  id: number;
  ip: string;
  mac: string | null;
  name: string;
}

export const siteSubnetService = {
  /** Manual rows merged with the prefixes the site's approved probes scan. */
  async list(tenantId: number, siteId: number): Promise<SiteSubnet[]> {
    const [rows, probes, usedIps] = await Promise.all([
      db('site_subnets').where({ site_id: siteId, tenant_id: tenantId }).select('*') as Promise<SiteSubnetRow[]>,
      db('probes')
        .where({ site_id: siteId, tenant_id: tenantId, status: 'approved' })
        .select('id', 'last_scanned_subnets', 'last_scan_at') as Promise<Array<{ id: number; last_scanned_subnets: unknown; last_scan_at: Date | string | null }>>,
      usedIpsOfSite(tenantId, siteId),
    ]);
    return mergeSiteSubnets(
      rows,
      probes.map((p) => ({ probeId: Number(p.id), subnets: p.last_scanned_subnets, lastScanAt: p.last_scan_at })),
      usedIps,
    );
  },

  async getRow(tenantId: number, siteId: number, subnetId: number): Promise<SiteSubnetRow | null> {
    const row = await db('site_subnets').where({ id: subnetId, site_id: siteId, tenant_id: tenantId }).first();
    return (row as SiteSubnetRow | undefined) ?? null;
  },

  /** The merged entry of one CIDR (after a create / update). */
  async entry(tenantId: number, siteId: number, cidr: string): Promise<SiteSubnet | null> {
    const all = await this.list(tenantId, siteId);
    return all.find((s) => s.cidr === cidr) ?? null;
  },

  async create(tenantId: number, siteId: number, input: SiteSubnetInput, userId: number | null): Promise<SiteSubnetRow> {
    const net = requireUserCidr(input.cidr);
    const gateway = emptyToNull(input.gateway) ?? null;
    assertGatewayInSubnet(net, gateway);
    try {
      const [row] = await db('site_subnets')
        .insert({
          tenant_id: tenantId,
          site_id: siteId,
          cidr: formatCidr(net),
          name: emptyToNull(input.name) ?? null,
          vlan: input.vlan ?? null,
          gateway,
          description: emptyToNull(input.description) ?? null,
          created_by: userId,
        })
        .returning('*');
      return row as SiteSubnetRow;
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'This subnet already exists on the site');
      throw err;
    }
  },

  /** null when the row does not exist on the tenant's site. */
  async update(tenantId: number, siteId: number, subnetId: number, patch: SiteSubnetPatch): Promise<{ before: SiteSubnetRow; after: SiteSubnetRow } | null> {
    const before = await this.getRow(tenantId, siteId, subnetId);
    if (!before) return null;
    const net = patch.cidr !== undefined ? requireUserCidr(patch.cidr) : parseSubnet(before.cidr);
    if (!net) throw new AppError(400, 'Invalid IPv4 CIDR');
    const gateway = patch.gateway !== undefined ? emptyToNull(patch.gateway) ?? null : before.gateway;
    assertGatewayInSubnet(net, gateway);

    const update: Record<string, unknown> = { updated_at: new Date() };
    if (patch.cidr !== undefined) update.cidr = formatCidr(net);
    if (patch.name !== undefined) update.name = emptyToNull(patch.name) ?? null;
    if (patch.vlan !== undefined) update.vlan = patch.vlan;
    if (patch.gateway !== undefined) update.gateway = gateway;
    if (patch.description !== undefined) update.description = emptyToNull(patch.description) ?? null;
    try {
      const [after] = await db('site_subnets')
        .where({ id: subnetId, site_id: siteId, tenant_id: tenantId })
        .update(update)
        .returning('*');
      return after ? { before, after: after as SiteSubnetRow } : null;
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'This subnet already exists on the site');
      throw err;
    }
  },

  /** The deleted row, or null when it does not exist on the tenant's site. */
  async remove(tenantId: number, siteId: number, subnetId: number): Promise<SiteSubnetRow | null> {
    const [row] = await db('site_subnets')
      .where({ id: subnetId, site_id: siteId, tenant_id: tenantId })
      .del('*');
    return (row as SiteSubnetRow | undefined) ?? null;
  },

  /**
   * First free host of the CIDR on the site: not held by a device or a
   * reservation, not the network / broadcast address, not the gateway of the
   * site_subnets row with this CIDR (when there is one).
   */
  async nextFree(tenantId: number, siteId: number, net: Ipv4Range): Promise<string | null> {
    if (net.prefix < NEXT_FREE_MIN_PREFIX) {
      throw new AppError(400, `next-free needs a prefix of /${NEXT_FREE_MIN_PREFIX} or narrower`);
    }
    const [usedIps, row] = await Promise.all([
      usedIpsOfSite(tenantId, siteId),
      db('site_subnets').where({ site_id: siteId, tenant_id: tenantId, cidr: formatCidr(net) }).first('gateway') as Promise<{ gateway: string | null } | undefined>,
    ]);
    return nextFreeIp(net, usedIps, row?.gateway ? [row.gateway] : []);
  },

  /**
   * Deletes the site's discovered (non-manual) devices whose IP is inside the
   * CIDR, with their flows (flows of an IP another device of the site still
   * holds are kept, as the bulk delete does).
   */
  async deleteItemsInCidr(tenantId: number, siteId: number, net: Ipv4Range): Promise<{ deleted: number; flowsDeleted: number; removed: RemovedSiteItem[] }> {
    const result = await db.transaction(async (trx) => {
      const candidates = await trx('site_items')
        .where({ site_id: siteId, tenant_id: tenantId })
        .where((q) => { q.where('is_manual', false).orWhereNull('is_manual'); })
        .whereNotNull('ip')
        .select('id', 'ip') as Array<{ id: number; ip: string }>;
      const ids = candidates.filter((c) => cidrContains(net, c.ip)).map((c) => Number(c.id));
      const removed: RemovedSiteItem[] = [];
      if (ids.length === 0) return { deleted: 0, flowsDeleted: 0, removed };

      const deletedIps: string[] = [];
      for (let i = 0; i < ids.length; i += 1000) {
        const rows = await trx('site_items')
          .where({ site_id: siteId, tenant_id: tenantId })
          .whereIn('id', ids.slice(i, i + 1000))
          .del(['id', 'ip', 'mac', 'custom_name', 'hostname']) as Array<{
            id: number; ip: string; mac: string | null; custom_name: string | null; hostname: string | null;
          }>;
        for (const r of rows) {
          deletedIps.push(r.ip);
          removed.push({ id: Number(r.id), ip: r.ip, mac: r.mac ?? null, name: r.custom_name || r.hostname || r.ip });
        }
      }
      const unique = [...new Set(deletedIps)];
      const held = new Set<string>();
      for (let i = 0; i < unique.length; i += 1000) {
        const still = await trx('site_items')
          .where({ site_id: siteId, tenant_id: tenantId })
          .whereIn('ip', unique.slice(i, i + 1000))
          .distinct('ip')
          .pluck('ip') as string[];
        for (const ip of still) held.add(ip);
      }
      const flowsDeleted = await flowService.clearFlowsForIps(
        tenantId, siteId, unique.filter((ip) => !held.has(ip)), trx,
      );
      return { deleted: deletedIps.length, flowsDeleted, removed };
    });
    if (result.deleted > 0) refreshDeviceChecks(tenantId, siteId);
    return result;
  },
};
