import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from './client';
import type { AxiosResponse } from 'axios';
import { useIpamLiveRefresh } from '@/hooks/useIpamLiveRefresh';

// Real subnets of a site (server: routes/siteSubnets.routes.ts):
// manual rows (name, VLAN, gateway, description) merged with the prefixes
// the site's approved probes report as scanned. Read: site read; mutations:
// site write.

export type SiteSubnetSource = 'manual' | 'probe' | 'manual+probe';

/** GET /api/sites/:siteId/subnets entry. */
export interface SiteSubnet {
  /** site_subnets row id; null for a prefix only a probe reports (no metadata yet). */
  id: number | null;
  uuid: string | null;
  /** Normalised CIDR (network address), e.g. "10.0.0.0/22". */
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
  lastScannedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SiteSubnetInput {
  cidr: string;
  name?: string | null;
  vlan?: number | null;
  gateway?: string | null;
  description?: string | null;
}

/** Prefix range the server accepts for a subnet created / edited by a user. */
export const SITE_SUBNET_MIN_PREFIX = 16;
export const SITE_SUBNET_MAX_PREFIX = 30;
/** next-free needs a prefix of /16 or narrower (server NEXT_FREE_MIN_PREFIX). */
export const NEXT_FREE_MIN_PREFIX = 16;
/** DELETE /items?cidr= refuses a prefix wider than this (server PROBE_SUBNET_MIN_PREFIX). */
export const DELETE_ITEMS_MIN_PREFIX = 8;

const base = (siteId: number) => `/sites/${siteId}/subnets`;

export const siteSubnetsApi = {
  list: (siteId: number, signal?: AbortSignal): Promise<{ subnets: SiteSubnet[] }> =>
    apiClient.get(base(siteId), { signal }).then((r: AxiosResponse) => r.data as { subnets: SiteSubnet[] }),

  /** A manual subnet, or the metadata of a probe-reported prefix (same CIDR). */
  create: (siteId: number, data: SiteSubnetInput): Promise<{ subnet: SiteSubnet | null }> =>
    apiClient.post(base(siteId), data).then((r: AxiosResponse) => r.data as { subnet: SiteSubnet | null }),

  update: (siteId: number, subnetId: number, data: Partial<SiteSubnetInput>): Promise<{ subnet: SiteSubnet | null }> =>
    apiClient.patch(`${base(siteId)}/${subnetId}`, data).then((r: AxiosResponse) => r.data as { subnet: SiteSubnet | null }),

  /** Deletes the row (a prefix a probe still scans stays listed, without metadata). */
  remove: (siteId: number, subnetId: number): Promise<void> =>
    apiClient.delete(`${base(siteId)}/${subnetId}`).then(() => undefined),

  /** First host not used by a device or a reservation (network, broadcast and gateway skipped); null when full. */
  nextFree: (siteId: number, cidr: string): Promise<{ cidr: string; ip: string | null }> =>
    apiClient.get(`${base(siteId)}/next-free`, { params: { cidr } })
      .then((r: AxiosResponse) => r.data as { cidr: string; ip: string | null }),

  /** Deletes the site's discovered (non-manual) devices inside the CIDR, with their flows. */
  deleteItems: (siteId: number, cidr: string): Promise<{ deleted: number; flowsDeleted: number }> =>
    apiClient.delete(`${base(siteId)}/items`, { params: { cidr } })
      .then((r: AxiosResponse) => r.data as { deleted: number; flowsDeleted: number }),
};

// ─── IPv4 / CIDR math (client side, same rules as the server) ────────────────

export interface Ipv4Net {
  /** Network address, unsigned 32-bit. */
  base: number;
  prefix: number;
}

/** "192.168.1.7" → unsigned 32-bit integer; null when not a dotted IPv4. */
export function ipv4ToInt(ip: string | null | undefined): number | null {
  if (typeof ip !== 'string') return null;
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function intToIpv4(n: number): string {
  return [
    Math.floor(n / 16_777_216) % 256,
    Math.floor(n / 65_536) % 256,
    Math.floor(n / 256) % 256,
    n % 256,
  ].join('.');
}

/** "10.0.1.7/22" → { base: 10.0.0.0, prefix: 22 } (host bits cleared); null otherwise. */
export function parseCidr(value: string | null | undefined): Ipv4Net | null {
  if (typeof value !== 'string') return null;
  const m = /^\s*([\d.]+)\/(\d{1,2})\s*$/.exec(value);
  if (!m) return null;
  const ip = ipv4ToInt(m[1]);
  const prefix = Number(m[2]);
  if (ip === null || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  return { base: ip - (ip % size), prefix };
}

export function formatCidr(net: Ipv4Net): string {
  return `${intToIpv4(net.base)}/${net.prefix}`;
}

export function subnetSize(prefix: number): number {
  return 2 ** (32 - prefix);
}

/** Host addresses: network and broadcast excluded below /31 (a /31 has 2 hosts, a /32 one). */
export function hostRange(net: Ipv4Net): { first: number; last: number } {
  const size = subnetSize(net.prefix);
  if (net.prefix >= 31) return { first: net.base, last: net.base + size - 1 };
  return { first: net.base + 1, last: net.base + size - 2 };
}

export function usableHosts(prefix: number): number {
  if (prefix >= 32) return 1;
  if (prefix === 31) return 2;
  return subnetSize(prefix) - 2;
}

export function netContains(net: Ipv4Net, ipInt: number): boolean {
  return ipInt >= net.base && ipInt < net.base + subnetSize(net.prefix);
}

export function isHostOf(net: Ipv4Net, ipInt: number): boolean {
  const { first, last } = hostRange(net);
  return ipInt >= first && ipInt <= last;
}

/** Distinct host addresses of the subnet among the given IPs (devices + reservations). */
export function countUsedHosts(net: Ipv4Net, ips: Iterable<string>): number {
  const seen = new Set<number>();
  for (const ip of ips) {
    const n = ipv4ToInt(ip);
    if (n !== null && isHostOf(net, n)) seen.add(n);
  }
  return seen.size;
}

/** A parsed site subnet, for the longest-prefix lookups. */
export interface ParsedSiteSubnet {
  subnet: SiteSubnet;
  net: Ipv4Net;
}

/** Valid IPv4 subnets of the list, most specific first (longest-prefix match order). */
export function parseSiteSubnets(subnets: readonly SiteSubnet[] | null | undefined): ParsedSiteSubnet[] {
  const out: ParsedSiteSubnet[] = [];
  for (const subnet of subnets ?? []) {
    const net = parseCidr(subnet.cidr);
    if (net) out.push({ subnet, net });
  }
  return out.sort((a, b) => b.net.prefix - a.net.prefix || a.net.base - b.net.base);
}

/** The most specific subnet containing the IP (list from parseSiteSubnets), or null. */
export function longestMatch(parsed: readonly ParsedSiteSubnet[], ip: string): ParsedSiteSubnet | null {
  const n = ipv4ToInt(ip);
  if (n === null) return null;
  for (const p of parsed) if (netContains(p.net, n)) return p;
  return null;
}

/** Utilisation ratio (0–1) and the bar colour class. */
export function utilisationTone(used: number, usable: number): { ratio: number; barClass: string } {
  const ratio = usable > 0 ? Math.min(1, used / usable) : 0;
  const barClass = ratio >= 0.9 ? 'bg-red-500' : ratio >= 0.75 ? 'bg-amber-500' : 'bg-accent';
  return { ratio, barClass };
}

// ─── Hook: the site's subnets, kept fresh ────────────────────────────────────

/** In-flight requests shared by the components of one page (one GET per site at a time). */
const inFlight = new Map<number, Promise<{ subnets: SiteSubnet[] }>>();

function fetchSubnets(siteId: number, force = false): Promise<{ subnets: SiteSubnet[] }> {
  // A forced fetch (explicit reload after a mutation) never reuses a GET that
  // may have started before the mutation.
  const pending = force ? undefined : inFlight.get(siteId);
  if (pending) return pending;
  const p = siteSubnetsApi.list(siteId).finally(() => { if (inFlight.get(siteId) === p) inFlight.delete(siteId); });
  inFlight.set(siteId, p);
  return p;
}

/**
 * The site's subnets: loaded on mount / site change, reloaded on the IPAM
 * live events (a subnet mutation emits SITE_UPDATED) and by `reload()`.
 * `subnets` is null until the first answer, or after a failed load (the
 * callers then fall back to /24 grouping).
 */
export function useSiteSubnets(siteId: number | null | undefined): {
  subnets: SiteSubnet[] | null;
  loading: boolean;
  reload: () => void;
} {
  const [state, setState] = useState<{ siteId: number | null; subnets: SiteSubnet[] | null; loading: boolean }>(
    { siteId: null, subnets: null, loading: siteId != null },
  );
  const [tick, setTick] = useState(0);
  const forceRef = useRef(false);
  const reload = useCallback(() => { forceRef.current = true; setTick((n) => n + 1); }, []);
  const siteRef = useRef(siteId);
  siteRef.current = siteId;

  useEffect(() => {
    if (siteId == null) {
      setState({ siteId: null, subnets: null, loading: false });
      return;
    }
    let cancelled = false;
    const force = forceRef.current;
    forceRef.current = false;
    setState((prev) => ({ ...prev, loading: true }));
    fetchSubnets(siteId, force)
      .then((res) => {
        if (cancelled) return;
        setState({ siteId, subnets: Array.isArray(res.subnets) ? res.subnets : [], loading: false });
      })
      .catch(() => {
        if (cancelled) return;
        // Keep what this site had (a transient error does not regroup the table).
        setState((prev) => ({ siteId, subnets: prev.siteId === siteId ? prev.subnets : null, loading: false }));
      });
    return () => { cancelled = true; };
  }, [siteId, tick]);

  useIpamLiveRefresh(useCallback(() => {
    if (siteRef.current != null) setTick((n) => n + 1);
  }, []), 2000);

  return {
    subnets: state.siteId === (siteId ?? null) ? state.subnets : null,
    loading: state.loading,
    reload,
  };
}
