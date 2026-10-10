import type { Knex } from 'knex';
import type { DeviceCheckMatch } from '@oblimap/shared';
import { ipv4ToInt, normalizeMacAddress, parseIPv4Cidr } from '../../validators/probe.schema';
import { isRfc1918 } from '../../validators/tunnel.schema';

// Which devices a Device Checks rule targets, and which probe runs the
// check on each of them.
//
// Match = (any of vendorContains / macPrefixes / deviceTypes / itemIds)
//         AND NOT (excludeItemIds or excludeDeviceTypes)
//         AND (MAC present if requireMac)
//         AND an RFC 1918 IPv4 address outside the cloud metadata denylist
//         (a manual item with a public, link-local, CGNAT, malformed or
//         metadata address is never targeted).
//
// prefilterQuery() narrows the SQL query to the candidates of the positive
// criteria; matchesItem() is the authoritative test, run on every candidate.

/** The site_items columns matching needs. */
export interface MatchableItem {
  id: number;
  ip: string;
  mac: string | null;
  vendor: string | null;
  device_type: string;
}

/**
 * Never a check target: the cloud metadata / credential endpoints a probe
 * running in a cloud VM could reach (the test endpoint returns a body snippet
 * to the admin). Outside RFC 1918 today, so already excluded by
 * isTargetableAddress; kept as an explicit denylist should the range widen.
 *  - 169.254.169.0/24: instance metadata (AWS, GCP, Azure, OCI, OpenStack,
 *    DigitalOcean… at .254), AWS time sync (.123) and DNS (.253);
 *  - 169.254.170.0/24: ECS task credentials / metadata (.2);
 *  - 169.254.0.23: Tencent Cloud metadata;
 *  - 100.100.100.200: Alibaba Cloud metadata.
 */
const FORBIDDEN_TARGET_NETS = ['169.254.169.0/24', '169.254.170.0/24', '169.254.0.23/32', '100.100.100.200/32']
  .map((cidr) => {
    const net = parseIPv4Cidr(cidr);
    if (!net) throw new Error(`bad built-in range ${cidr}`);
    return { base: net.base, size: 2 ** (32 - net.prefix) };
  });

/** True for an address of FORBIDDEN_TARGET_NETS. */
export function isForbiddenTarget(ip: unknown): boolean {
  const n = ipv4ToInt(ip);
  return n !== null && FORBIDDEN_TARGET_NETS.some((net) => n >= net.base && n < net.base + net.size);
}

/** "aa-bb-cc" / "aa:bb:cc" → "AA:BB:CC". */
export function normalizeMacPrefix(prefix: string): string {
  return prefix.trim().toUpperCase().replace(/-/g, ':');
}

/**
 * The device may be targeted at all: an RFC 1918 address outside the cloud
 * metadata denylist (config build, coverage, test and preview all go through
 * it). Same range as the probe's own guard (allowedLanTarget), which refuses
 * link-local and RFC 6598 (100.64/10) addresses: assigning those would only
 * produce target_not_allowed errors.
 */
export function isTargetableAddress(ip: unknown): boolean {
  return typeof ip === 'string' && isRfc1918(ip) && !isForbiddenTarget(ip);
}

/** True when `item` is targeted by `match` (see the header comment). */
export function matchesItem(match: DeviceCheckMatch, item: MatchableItem): boolean {
  if (!isTargetableAddress(item.ip)) return false;
  const mac = normalizeMacAddress(item.mac);
  if (match.requireMac && !mac) return false;
  if (match.excludeItemIds?.includes(item.id)) return false;
  if ((match.excludeDeviceTypes as readonly string[] | undefined)?.includes(item.device_type)) return false;

  const vendor = (item.vendor ?? '').toLowerCase();
  if ((match.vendorContains ?? []).some((v) => {
    const needle = v.trim().toLowerCase();
    return needle !== '' && vendor.includes(needle);
  })) return true;
  if (mac && (match.macPrefixes ?? []).some((p) => {
    const prefix = normalizeMacPrefix(p);
    return prefix !== '' && mac.startsWith(prefix);
  })) return true;
  if ((match.deviceTypes as readonly string[] | undefined)?.includes(item.device_type)) return true;
  if (match.itemIds?.includes(item.id)) return true;
  return false;
}

/** Escapes the LIKE wildcards (%, _) and the escape character itself. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Adds the positive criteria of `match` to a site_items query, OR-ed inside
 * one parenthesised group:
 *   vendor ILIKE '%…%' ESCAPE '\' OR upper(mac) LIKE 'AA:BB:CC%' ESCAPE '\'
 *   OR device_type IN (…) OR id IN (…)
 * A match without any positive criterion selects nothing. `alias` qualifies
 * the columns ('si' → si.vendor).
 */
export function prefilterQuery<T extends Knex.QueryBuilder>(qb: T, match: DeviceCheckMatch, alias?: string): T {
  const col = (c: string) => (alias ? `${alias}.${c}` : c);
  const vendors = (match.vendorContains ?? []).map((v) => v.trim()).filter((v) => v !== '');
  const prefixes = (match.macPrefixes ?? []).map(normalizeMacPrefix).filter((p) => p !== '');
  const types = match.deviceTypes ?? [];
  const ids = match.itemIds ?? [];
  qb.where((w: Knex.QueryBuilder) => {
    let any = false;
    for (const v of vendors) {
      w.orWhereRaw(`?? ILIKE ? ESCAPE '\\'`, [col('vendor'), `%${escapeLike(v)}%`]);
      any = true;
    }
    for (const p of prefixes) {
      w.orWhereRaw(`upper(??) LIKE ? ESCAPE '\\'`, [col('mac'), `${escapeLike(p)}%`]);
      any = true;
    }
    if (types.length > 0) {
      w.orWhereIn(col('device_type'), [...types]);
      any = true;
    }
    if (ids.length > 0) {
      w.orWhereIn(col('id'), [...ids]);
      any = true;
    }
    if (!any) w.whereRaw('false');
  });
  return qb;
}

/** A probe of the item's site, as executor selection sees it. */
export interface ExecutorCandidate {
  id: number;
  status: string;
  /** Advertises DEVICE_CHECKS_CAPABILITY. */
  capable: boolean;
  isPrimary: boolean;
  lastSeenAt: Date | null;
}

/** A discoverer counts as the executor only if it was seen this recently. */
export const EXECUTOR_RECENT_MS = 10 * 60 * 1000;

function seenRecently(p: ExecutorCandidate, now: number): boolean {
  return p.lastSeenAt !== null && now - p.lastSeenAt.getTime() < EXECUTOR_RECENT_MS;
}

/**
 * The probe that runs the checks of `item` (one executor per item):
 * among the approved probes of the site that advertise the
 * capability — the probe that discovered the device if it was seen in the
 * last 10 minutes, else the site's primary, else any (one seen recently
 * first, lowest id first: every probe's config build must agree). Null when
 * no probe of the site can run checks.
 */
export function selectExecutorProbe(
  item: { discovered_by_probe_id?: number | null },
  probes: readonly ExecutorCandidate[],
  now: Date = new Date(),
): number | null {
  const t = now.getTime();
  const eligible = probes.filter((p) => p.status === 'approved' && p.capable).sort((a, b) => a.id - b.id);
  if (eligible.length === 0) return null;
  const discoverer = item.discovered_by_probe_id ?? null;
  if (discoverer !== null) {
    const d = eligible.find((p) => p.id === discoverer);
    if (d && seenRecently(d, t)) return d.id;
  }
  const primary = eligible.find((p) => p.isPrimary);
  if (primary) return primary.id;
  return (eligible.find((p) => seenRecently(p, t)) ?? eligible[0]).id;
}
