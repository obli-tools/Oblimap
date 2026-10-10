// TRUSTED_PROXIES may come from .env: load it before reading process.env.
import '../env';
import { BlockList, isIP } from 'net';
import os from 'os';
import type { IncomingMessage } from 'http';

/**
 * The one way to know a client's IP for the audit log and for display
 * (port of Obliance server/src/utils/clientIp.ts). Not a rate-limit key and
 * not an access-control input: rate limits key on req.ip (Express
 * 'trust proxy'), which a client cannot choose.
 *
 * `X-Forwarded-For` is a list the CLIENT can pre-fill: only the entries added
 * by proxies we trust are meaningful. Like Express's `trust proxy`, the list
 * is walked from the right (closest hop first) and the first address that is
 * NOT a trusted proxy is the client. Taking the left-most value would let
 * anyone write the address they are recorded with.
 *
 * Trusted proxies: env TRUSTED_PROXIES, comma-separated IPs, CIDRs or the
 * keywords loopback, linklocal, uniquelocal, self (the subnets of this
 * container's own interfaces — where the client container's nginx lives,
 * whatever address pool Docker uses). Default "loopback, self, 172.16.0.0/12":
 * the client container's nginx and a reverse proxy (Nginx Proxy Manager, …)
 * running in Docker on the same host. If the socket peer is not trusted,
 * X-Forwarded-For is ignored and every client resolves to that peer. A reverse
 * proxy elsewhere on the LAN must be added (e.g. TRUSTED_PROXIES="loopback,
 * self, 172.16.0.0/12, 192.168.1.10").
 * Avoid "uniquelocal" when LAN clients reach the proxy directly: a LAN client
 * would then be treated as a proxy and could forge its address.
 *
 * TRUSTED_PROXY_HOPS (default 2 = edge reverse proxy + the client container's
 * nginx) caps how many X-Forwarded-For entries are consumed. It closes the
 * case where the edge proxy only sees a Docker gateway (inside a trusted
 * range): without the cap the walk would continue into the client-written
 * part. When the client container's port is reachable WITHOUT an edge proxy,
 * set TRUSTED_PROXY_HOPS=1.
 *
 * Unlike Obliance, an invalid TRUSTED_PROXIES / TRUSTED_PROXY_HOPS never stops
 * the server: a loud warning is printed and the default is used.
 */
export const DEFAULT_TRUSTED_PROXIES = 'loopback, self, 172.16.0.0/12';
export const DEFAULT_TRUSTED_PROXY_HOPS = 2;

/** IPv4 subnets of this process's interfaces (Docker plumbing). In the host
 *  network namespace (docker0 present) only Docker bridges count, never the
 *  real LAN interfaces. */
function ownSubnets(): string[] {
  const ifaces = os.networkInterfaces();
  const hostNetns = 'docker0' in ifaces;
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (hostNetns && !/^(docker\d*|br-|veth|cni|flannel|cali|vxlan)/.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && a.cidr && !a.internal) out.push(a.cidr);
    }
  }
  return out;
}

const KEYWORDS: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

/** "1.2.3.4:5678" / "[2001:db8::1]:443" (Azure, IIS ARR) -> bare address. */
function stripPort(s: string): string {
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (v6) return v6[1];
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  return v4 ? v4[1] : s;
}

/** Strips a port, the IPv4-mapped IPv6 prefix (::ffff:) and an IPv6 zone id. */
export function normalizeIp(raw: string | undefined | null): string {
  const s = stripPort((raw ?? '').trim()).replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  return s.replace(/%.*$/, '');
}

/** Compiles a TRUSTED_PROXIES spec into a matcher. Throws on an invalid entry. */
export function compileTrustedProxies(spec: string): (addr: string) => boolean {
  const list = new BlockList();
  const entries = spec.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const expanded = entries.flatMap((e) => (e === 'self' ? ownSubnets() : KEYWORDS[e] ?? [e]));
  for (const entry of expanded) {
    const [ip, bitsText] = entry.split('/');
    const family = isIP(ip);
    if (!family) throw new Error(`TRUSTED_PROXIES: invalid entry "${entry}"`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (bitsText === undefined) {
      list.addAddress(ip, type);
    } else {
      const bits = Number(bitsText);
      // Strict: "10.0.0.0/" must not become /0 (= trust everything).
      if (!/^\d{1,3}$/.test(bitsText) || bits < 0 || bits > (family === 4 ? 32 : 128)) {
        throw new Error(`TRUSTED_PROXIES: invalid prefix in "${entry}"`);
      }
      list.addSubnet(ip, bits, type);
    }
  }
  return (addr: string) => {
    const ip = normalizeIp(addr);
    const family = isIP(ip);
    return family !== 0 && list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  };
}

function configWarning(message: string): void {
  // The logger is not up yet at import time (and pulls the config): console.
  console.warn(`WARNING: ${message}`);
}

/** Trust function of this process. */
export const isTrustedProxy = ((): ((addr: string) => boolean) => {
  const spec = process.env.TRUSTED_PROXIES;
  if (spec && spec.trim() !== '') {
    try {
      return compileTrustedProxies(spec);
    } catch (err) {
      configWarning(`${(err as Error).message} — using the default "${DEFAULT_TRUSTED_PROXIES}". Fix TRUSTED_PROXIES.`);
    }
  }
  return compileTrustedProxies(DEFAULT_TRUSTED_PROXIES);
})();

export const trustedProxyHops = ((): number => {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TRUSTED_PROXY_HOPS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    configWarning(`TRUSTED_PROXY_HOPS: expected 1..10, got "${raw}" — using ${DEFAULT_TRUSTED_PROXY_HOPS}.`);
    return DEFAULT_TRUSTED_PROXY_HOPS;
  }
  return n;
})();

/** Non-public ranges (RFC 1918, CGNAT, loopback, link-local, ULA). */
const NON_PUBLIC = compileTrustedProxies(
  '0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, ::1/128, fc00::/7, fe80::/10',
);

export interface ResolvedClient {
  ip: string;
  /**
   * The address is a relay shared by every user behind it, not a client:
   * one of our proxies / Docker plumbing, or a private address that itself
   * forwarded on behalf of someone else (X-Forwarded-For entries remain) —
   * typically an edge proxy missing from TRUSTED_PROXIES.
   */
  relay: boolean;
  /** Relay reached before the hop cap: likely a proxy to add to TRUSTED_PROXIES. */
  untrustedForwarder: boolean;
}

/**
 * Client IP of an HTTP request or WebSocket upgrade: the socket address, then
 * X-Forwarded-For from right to left while the current hop is a trusted
 * proxy (at most `maxHops` entries). A malformed entry stops the walk at the
 * last valid address.
 */
export function resolveClient(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trusted: (addr: string) => boolean = isTrustedProxy,
  maxHops: number = trustedProxyHops,
): ResolvedClient {
  let current = normalizeIp(socketAddress);
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '';
  const hops = header.split(',').map(normalizeIp).filter((h) => h.length > 0);
  let consumed = 0;
  let malformed = false;
  while (current && trusted(current) && hops.length > 0 && consumed < maxHops) {
    consumed++;
    const next = hops.pop()!;
    if (!isIP(next)) { malformed = true; break; }
    current = next;
  }
  const forwarded = malformed || hops.length > 0;
  if (!current || trusted(current)) return { ip: current, relay: true, untrustedForwarder: false };
  const relay = forwarded && NON_PUBLIC(current);
  // Hop budget left but the address is not trusted: it is most likely a
  // reverse proxy missing from TRUSTED_PROXIES. (At the hop cap it is a
  // client of our trusted edge that sent its own header: no config issue.)
  return { ip: current, relay, untrustedForwarder: relay && consumed < maxHops };
}

export function resolveClientIp(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trusted: (addr: string) => boolean = isTrustedProxy,
  maxHops: number = trustedProxyHops,
): string {
  return resolveClient(socketAddress, forwardedFor, trusted, maxHops).ip;
}

/** The resolved address is itself one of our proxies / Docker plumbing. */
export function isRelayAddress(ip: string | undefined): boolean {
  return !ip || isTrustedProxy(ip);
}

// One warning per address: an edge proxy missing from TRUSTED_PROXIES makes
// every user share its address in the audit log.
const warnedForwarders = new Set<string>();
function warnUntrustedForwarder(ip: string): void {
  if (warnedForwarders.has(ip) || warnedForwarders.size >= 50) return;
  warnedForwarders.add(ip);
  // Lazy: the logger pulls the config, keep this module import-light.
  void import('./logger').then(({ logger }) => {
    logger.warn({ ip },
      `Client IP: requests are forwarded by ${ip}, which is not in TRUSTED_PROXIES — every client behind it shows up as ${ip} `
      + 'in the audit log. If it is your reverse proxy, add it (or its subnet) to TRUSTED_PROXIES.');
  }).catch(() => { /* logging only */ });
}

export function clientAddress(req: IncomingMessage): ResolvedClient {
  const resolved = resolveClient(req.socket?.remoteAddress, req.headers['x-forwarded-for']);
  if (resolved.untrustedForwarder) warnUntrustedForwarder(resolved.ip);
  return resolved;
}

/** Client IP of a request (audit / display only). Empty string when unknown. */
export function clientIp(req: IncomingMessage): string {
  return clientAddress(req).ip;
}
