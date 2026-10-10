import { lookup } from 'dns/promises';
import { BlockList, isIP } from 'net';
import { AppError } from '../middleware/errorHandler';

// Outbound HTTP targets chosen by users (notification webhooks, Gotify, ntfy,
// Slack / Discord / Teams URLs…) must not reach internal services: the
// database, other containers, the cloud metadata endpoint (169.254.169.254),
// admin panels on the LAN. Port of Obliance utils/ssrfGuard.ts.
//
// The hostname is resolved BEFORE the request and every answer is screened —
// `https://example.com` could otherwise resolve onto an internal address.
// This is best effort against DNS rebinding (the HTTP client resolves again);
// strong isolation needs an egress proxy with an allow-list.
//
// Intentionally internal targets (a Gotify / ntfy server on the LAN) are
// allowed through env SSRF_ALLOWLIST: comma-separated host names
// ("gotify.lan", "*.corp.example"), IP addresses or CIDRs ("192.168.10.0/24").

/** Refusal: always the same client-facing message; the reason is for server logs only. */
export class TargetNotAllowedError extends AppError {
  constructor(public readonly reason: string) {
    super(400, 'Target not allowed');
    this.name = 'TargetNotAllowedError';
  }
}

function buildList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [ip, bits] = entry.split('/');
    const type = isIP(ip) === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(ip, type);
    else list.addSubnet(ip, Number(bits), type);
  }
  return list;
}

// Not globally reachable (IANA special-purpose registries).
const BLOCKED_V4 = buildList([
  '0.0.0.0/8',        // "this" network
  '10.0.0.0/8',       // RFC 1918
  '100.64.0.0/10',    // CGNAT (also Alibaba metadata 100.100.100.200)
  '127.0.0.0/8',      // loopback
  '169.254.0.0/16',   // link-local + cloud metadata
  '172.16.0.0/12',    // RFC 1918 (Docker networks)
  '192.0.0.0/24',     // IETF protocol assignments
  '192.0.2.0/24',     // TEST-NET-1
  '192.88.99.0/24',   // 6to4 relay anycast
  '192.168.0.0/16',   // RFC 1918
  '198.18.0.0/15',    // benchmarking
  '198.51.100.0/24',  // TEST-NET-2
  '203.0.113.0/24',   // TEST-NET-3
  '224.0.0.0/4',      // multicast
  '240.0.0.0/4',      // reserved + broadcast
]);

const BLOCKED_V6 = buildList([
  '::/96',            // unspecified, loopback, IPv4-compatible (deprecated)
  '64:ff9b:1::/48',   // local-use NAT64
  '100::/64',         // discard-only
  '2001::/32',        // Teredo (embeds an obfuscated IPv4)
  '2001:db8::/32',    // documentation
  'fc00::/7',         // unique local (ULA)
  'fe80::/10',        // link-local
  'fec0::/10',        // site-local (deprecated)
  'ff00::/8',         // multicast
]);

/** 8 hextets of an IPv6 address (brackets, zone id and IPv4 tail accepted), or null. */
export function ipv6ToHextets(raw: string): number[] | null {
  let ip = raw.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '');
  if (isIP(ip) !== 6) return null;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const o = v4.slice(1, 5).map(Number);
    ip = ip.slice(0, ip.length - v4[0].length)
      + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = ip.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  let parts: string[];
  if (halves.length === 1) {
    parts = head;
  } else {
    const tail = halves[1] ? halves[1].split(':') : [];
    parts = [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  }
  if (parts.length !== 8) return null;
  const hextets = parts.map((p) => parseInt(p, 16));
  return hextets.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffff) ? hextets : null;
}

function hextetsToV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function isPrivateIPv4(ip: string): boolean {
  return isIP(ip) !== 4 || BLOCKED_V4.check(ip, 'ipv4');
}

/** IPv6 check, including the IPv4 embedded by mapped (::ffff:a.b.c.d), NAT64 and 6to4 addresses. */
export function isPrivateIPv6(ip: string): boolean {
  const h = ipv6ToHextets(ip);
  if (!h) return true;
  // ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::a.b.c.d (NAT64): the IPv4 decides.
  const mapped = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff;
  const nat64 = h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0;
  if (mapped || nat64) return isPrivateIPv4(hextetsToV4(h[6], h[7]));
  // 2002:aabb:ccdd::/48 (6to4) tunnels to IPv4 aa.bb.cc.dd.
  if (h[0] === 0x2002 && isPrivateIPv4(hextetsToV4(h[1], h[2]))) return true;
  return BLOCKED_V6.check(h.map((x) => x.toString(16)).join(':'), 'ipv6');
}

/** True when the address is not a public unicast address (or is not an IP at all). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true;
}

interface Allowlist { hosts: Set<string>; suffixes: string[]; ips: BlockList; hasIps: boolean }
let allowlistCache: { raw: string; list: Allowlist } | null = null;

function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

/** SSRF_ALLOWLIST, parsed once per distinct value; invalid entries are ignored. */
function getAllowlist(): Allowlist {
  const raw = process.env.SSRF_ALLOWLIST ?? '';
  if (allowlistCache && allowlistCache.raw === raw) return allowlistCache.list;
  const list: Allowlist = { hosts: new Set(), suffixes: [], ips: new BlockList(), hasIps: false };
  for (const item of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr, bits] = item.split('/');
    const family = isIP(normalizeHost(addr));
    if (family) {
      const ip = normalizeHost(addr);
      const type = family === 4 ? 'ipv4' : 'ipv6';
      if (bits === undefined) {
        list.ips.addAddress(ip, type);
        list.hasIps = true;
      } else if (/^\d{1,3}$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128)) {
        list.ips.addSubnet(ip, Number(bits), type);
        list.hasIps = true;
      }
    } else if (item.startsWith('*.') && item.length > 2) {
      list.suffixes.push(normalizeHost(item.slice(1))); // ".corp.example"
    } else if (!item.includes('/')) {
      list.hosts.add(normalizeHost(item));
    }
  }
  allowlistCache = { raw, list };
  return list;
}

function hostAllowlisted(host: string, list: Allowlist): boolean {
  return list.hosts.has(host) || list.suffixes.some((s) => host.endsWith(s));
}

function ipAllowlisted(ip: string, list: Allowlist): boolean {
  if (!list.hasIps) return false;
  const v = isIP(ip);
  return v !== 0 && list.ips.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Validates a user-supplied outbound URL and returns it parsed.
 * Refuses (TargetNotAllowedError, HTTP 400 'Target not allowed'):
 * non-http(s) schemes, credentials in the URL, localhost names, and any host
 * that is — or resolves to — a loopback / link-local / metadata / private
 * (RFC 1918, CGNAT, ULA) / reserved address, unless opts.allowPrivate is set
 * or the host / address is in SSRF_ALLOWLIST.
 */
export async function assertPublicHttpUrl(rawUrl: string, opts: { allowPrivate?: boolean } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new TargetNotAllowedError('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TargetNotAllowedError(`scheme ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new TargetNotAllowedError('credentials in URL');
  }
  if (opts.allowPrivate) return url;

  const host = normalizeHost(url.hostname);
  if (!host) throw new TargetNotAllowedError('empty host');
  const allow = getAllowlist();
  if (hostAllowlisted(host, allow)) return url;

  if (isIP(host)) {
    if (isPrivateAddress(host) && !ipAllowlisted(host, allow)) {
      throw new TargetNotAllowedError(`private address ${host}`);
    }
    return url;
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain') {
    throw new TargetNotAllowedError('localhost');
  }

  let answers: { address: string; family: number }[];
  try {
    answers = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new TargetNotAllowedError(`cannot resolve ${host}`);
  }
  if (answers.length === 0) throw new TargetNotAllowedError(`cannot resolve ${host}`);
  for (const a of answers) {
    if (isPrivateAddress(a.address) && !ipAllowlisted(a.address, allow)) {
      throw new TargetNotAllowedError(`${host} resolves to private address ${a.address}`);
    }
  }
  return url;
}
