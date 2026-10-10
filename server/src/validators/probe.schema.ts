import { isIPv6 } from 'net';
import { z } from 'zod';
import { SCAN_INTERVAL_MAX_SECONDS, SCAN_INTERVAL_MIN_SECONDS, SCAN_SUBNET_MIN_PREFIX } from '@oblimap/shared';
import type { FlowEntry } from '@oblimap/shared';

// Probe payload + admin probe API validation.
//
// The push payload is parsed once, by parseProbePush, for the HTTP push and
// the WS scan_result. What a genuine probe can send decides every rule below:
// a rejected push leaves the probe's devices untouched and its status stale,
// so a deployed probe must never be rejected for data it legitimately
// produces (Go encodes an empty device / subnet list as null, interfaces with
// public addresses, IPoIB hardware addresses, `ss` addresses carrying a
// %zone, many VLAN interfaces, ...). Unknown keys are stripped.

// ── Limits ───────────────────────────────────────────────────────────────────

export const PROBE_PUSH_LIMITS = {
  hostnameMax: 255,
  probeVersionMax: 32,
  // A probe on a VLAN trunk has one address / subnet per VLAN.
  probeIPsMax: 256,
  scannedSubnetsMax: 256,
  osInfoMaxBytes: 8 * 1024,
  devicesMax: 8192,
  openPortsMax: 1024,
  flowsMax: 10_000,
  processMax: 128,
  capabilitiesMax: 16,
  skippedSubnetsMax: 64,
} as const;

// ── IPv4 helpers ─────────────────────────────────────────────────────────────

// Dotted quad without leading zeros (PostgreSQL's inet reads 010 as 10, JS
// libraries disagree): exactly what Go's net.IP.String() produces.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

/** "a.b.c.d" → unsigned 32-bit integer, or null when not a strict IPv4 literal. */
export function ipv4ToInt(ip: unknown): number | null {
  if (typeof ip !== 'string' || !IPV4_RE.test(ip)) return null;
  const p = ip.split('.').map(Number);
  return p[0] * 16_777_216 + p[1] * 65_536 + p[2] * 256 + p[3];
}

export function isIPv4(ip: unknown): ip is string {
  return ipv4ToInt(ip) !== null;
}

interface Ipv4Net { base: number; prefix: number }

function rangeOf(cidr: string): Ipv4Net {
  const net = parseIPv4Cidr(cidr);
  if (!net) throw new Error(`bad built-in range ${cidr}`);
  return net;
}

function inNet(n: number, net: Ipv4Net): boolean {
  return n >= net.base && n < net.base + 2 ** (32 - net.prefix);
}

/** "a.b.c.d/n" → network (host bits cleared) + prefix, or null. */
export function parseIPv4Cidr(value: unknown): Ipv4Net | null {
  if (typeof value !== 'string') return null;
  const m = /^([0-9.]{7,15})\/(\d{1,2})$/.exec(value.trim());
  if (!m) return null;
  const n = ipv4ToInt(m[1]);
  const prefix = Number(m[2]);
  if (n === null || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  return { base: n - (n % size), prefix };
}

// RFC 1918, link-local (reported by the probe's own private filter) and the
// RFC 6598 shared space (CGNAT / overlay networks used as LANs).
const PRIVATE_NETS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10'].map(rangeOf);
// Never a device: "this network", loopback, multicast, reserved + broadcast.
const NEVER_DEVICE_NETS = ['0.0.0.0/8', '127.0.0.0/8', '224.0.0.0/4', '240.0.0.0/4'].map(rangeOf);

export function isPrivateIPv4(ip: unknown): boolean {
  const n = ipv4ToInt(ip);
  return n !== null && PRIVATE_NETS.some((net) => inNet(n, net));
}

// An IPv6 CIDR as the probe prints it for an admin-configured extra subnet
// (scanned subnets are reported, IPv6 ones are never scanned).
const IPV6_CIDR_RE = /^[0-9A-Fa-f:.]{2,45}\/(?:12[0-8]|1[01]\d|\d{1,2})$/;

// ── MAC / strings ────────────────────────────────────────────────────────────

const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

/** "aa-bb-cc-dd-ee-ff" → "AA:BB:CC:DD:EE:FF"; anything that is not a 6-byte MAC → null. */
export function normalizeMacAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!MAC_RE.test(s)) return null;
  return s.toUpperCase().replace(/-/g, ':');
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

function stripControl(s: string): string {
  return s.replace(CONTROL_CHARS_RE, '');
}

/**
 * A MAC field: a hardware address that is not a 6-byte MAC (IPoIB, EUI-64
 * interfaces — site_items.mac is varchar(17)) is dropped, not fatal: the
 * device is then tracked by IP, as for a device without an ARP entry.
 */
const macField = z.unknown().transform((v) => normalizeMacAddress(v));

const ipv4String = z.string().max(15).refine(isIPv4, 'Invalid IPv4 address');

// ── Capabilities ─────────────────────────────────────────────────────────────

const CAPABILITY_RE = /^[a-z_]+:\d+$/;

/**
 * Keeps the well-formed capability strings ("device_checks:1"), deduplicated,
 * at most PROBE_PUSH_LIMITS.capabilitiesMax (only the first 64 entries are
 * looked at). Not an array → null (the probe did not advertise any). Also
 * meant for the WS hello message.
 */
export function filterProbeCapabilities(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value.slice(0, 64)) {
    if (typeof v !== 'string' || v.length > 64 || !CAPABILITY_RE.test(v) || out.includes(v)) continue;
    out.push(v);
    if (out.length >= PROBE_PUSH_LIMITS.capabilitiesMax) break;
  }
  return out;
}

// ── Skipped subnets ──────────────────────────────────────────────────────────

export interface ProbeSkippedSubnet {
  cidr: string;
  /** Short machine reason reported by the probe ('too_wide', …). */
  reason: string;
}

const SKIPPED_REASON_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * skippedSubnets of a push: [{cidr, reason}]. Informational, never fatal:
 * malformed entries are dropped, duplicates removed, at most
 * PROBE_PUSH_LIMITS.skippedSubnetsMax kept (only the first 256 entries are
 * looked at). Not an array → null (not reported).
 */
export function filterSkippedSubnets(value: unknown): ProbeSkippedSubnet[] | null {
  if (!Array.isArray(value)) return null;
  const out: ProbeSkippedSubnet[] = [];
  for (const entry of value.slice(0, 256)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as { cidr?: unknown; reason?: unknown };
    const cidr = typeof e.cidr === 'string' ? e.cidr.trim() : '';
    if (cidr.length > 64 || (parseIPv4Cidr(cidr) === null && !IPV6_CIDR_RE.test(cidr))) continue;
    const reason = typeof e.reason === 'string' && SKIPPED_REASON_RE.test(e.reason.trim()) ? e.reason.trim() : 'unknown';
    if (out.some((o) => o.cidr === cidr)) continue;
    out.push({ cidr, reason });
    if (out.length >= PROBE_PUSH_LIMITS.skippedSubnetsMax) break;
  }
  return out;
}

// ── Push payload ─────────────────────────────────────────────────────────────

// Validated entry by entry in parseProbePush: the address rules (IPv4, scope)
// are applied there, after the structural checks below.
const deviceSchema = z.object({
  ip: z.string().max(64),
  mac: macField,
  hostname: z.string().max(PROBE_PUSH_LIMITS.hostnameMax).nullable().optional()
    .transform((v) => (v ? stripControl(v) || null : null)),
  isOnline: z.boolean(),
  openPorts: z.array(z.number().int().min(1).max(65535)).max(PROBE_PUSH_LIMITS.openPortsMax).nullable().optional()
    .transform((v) => v ?? null),
});

const portNumber = z.number().int().min(0).max(65535);

// `ss` prints the bound device of a socket as "10.0.0.5%eth0".
const flowIp = z.string().max(64).transform((s) => s.trim().replace(/%.*$/, '')).pipe(ipv4String);
const processName = z.string().max(PROBE_PUSH_LIMITS.processMax).nullable().optional();

const flowSchema = z.object({
  sourceIp: flowIp,
  sourcePort: portNumber.nullable().optional(),
  destIp: flowIp,
  destPort: portNumber,
  protocol: z.string().max(8).optional()
    .transform((v) => (v ?? 'tcp').trim().toLowerCase() || 'tcp')
    .pipe(z.enum(['tcp', 'udp'])),
  // The probe sends `process`; `sourceProcess` is the stored name.
  process: processName,
  sourceProcess: processName,
  connectionCount: z.number().int().min(0).optional(),
});

function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const probePushSchema = z.object({
  hostname: z.string().max(PROBE_PUSH_LIMITS.hostnameMax)
    .transform((v) => stripControl(v).trim() || 'unknown'),
  probeVersion: z.string().max(PROBE_PUSH_LIMITS.probeVersionMax).transform((v) => stripControl(v).trim()),
  osInfo: z.record(z.string(), z.unknown()).nullable().optional()
    .refine((v) => v == null || jsonSize(v) <= PROBE_PUSH_LIMITS.osInfoMaxBytes, 'osInfo is too large')
    .transform((v) => v ?? null),
  probeMac: macField,
  probeIPs: z.array(ipv4String).max(PROBE_PUSH_LIMITS.probeIPsMax).nullable().optional()
    .transform((v) => v ?? null),
  // null / absent = the probe reported no device list (Go nil slice).
  // Validated entry by entry in parseProbePush.
  discoveredDevices: z.array(z.unknown()).max(PROBE_PUSH_LIMITS.devicesMax).nullable().optional()
    .transform((v) => v ?? null),
  // Validated entry by entry in parseProbePush (a bad entry is dropped).
  discoveredFlows: z.array(z.unknown()).max(PROBE_PUSH_LIMITS.flowsMax).nullable().optional(),
  scannedSubnets: z.array(
    z.string().max(64).refine((s) => parseIPv4Cidr(s) !== null || IPV6_CIDR_RE.test(s.trim()), 'Invalid subnet'),
  ).max(PROBE_PUSH_LIMITS.scannedSubnetsMax).nullable().optional().transform((v) => v ?? []),
  // Informational fields: an unexpected value is ignored, never fatal.
  scanDurationMs: z.number().finite().nonnegative().nullable().optional().catch(null).transform((v) => v ?? null),
  // Sent only by probes whose config carried acceptsSkippedSubnets.
  skippedSubnets: z.unknown().transform((v) => filterSkippedSubnets(v)),
  capabilities: z.unknown().transform((v) => filterProbeCapabilities(v)),
  serverScheme: z.unknown().transform((v): 'http' | 'https' | null => {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return s === 'http' || s === 'https' ? s : null;
  }),
});

export interface ProbePushDevice {
  ip: string;
  /** Normalised "AA:BB:CC:DD:EE:FF", or null. */
  mac: string | null;
  hostname: string | null;
  isOnline: boolean;
  /** null: no port scan ran for this device. */
  openPorts: number[] | null;
}

export interface ProbePushPayload {
  hostname: string;
  probeVersion: string;
  osInfo: Record<string, unknown> | null;
  probeMac: string | null;
  probeIPs: string[] | null;
  /** null: the probe reported no device list at all (nothing found). */
  discoveredDevices: ProbePushDevice[] | null;
  /** Valid entries only (see droppedFlows). */
  discoveredFlows: FlowEntry[];
  scannedSubnets: string[];
  scanDurationMs: number | null;
  /** Subnets the probe did not scan, with its reason; null when not reported (older probes). */
  skippedSubnets: ProbeSkippedSubnet[] | null;
  /** Filtered capability list; null when the probe sent none. */
  capabilities: string[] | null;
  serverScheme: 'http' | 'https' | null;
}

export type ParseProbePushResult =
  | { ok: true; data: ProbePushPayload; droppedFlows: number; droppedDevices: number }
  | { ok: false; error: string };

function parseFailure(path: (string | number)[], message: string | undefined): { ok: false; error: string } {
  const where = path.length ? path.join('.') : 'payload';
  return { ok: false, error: stripControl(`${where}: ${message ?? 'invalid'}`).slice(0, 200) };
}

type DeviceCheck =
  | { kind: 'keep'; device: ProbePushDevice }
  | { kind: 'drop' }
  | { kind: 'reject'; path: (string | number)[]; message: string };

/**
 * One discoveredDevices entry. A structural problem (not an object, bad
 * isOnline / openPorts / hostname) or an IPv4 address that cannot be a LAN
 * device rejects the push. A non-IPv4 address the probe genuinely reports is
 * dropped: every probe build adds itself with the local address of its UDP
 * dial to the server, which is IPv6 when the server name resolves to IPv6
 * (dual-stack LAN) — the device list is IPv4 only.
 */
function checkDevice(
  entry: unknown,
  i: number,
  probeMac: string | null,
  scanned: Ipv4Net[],
): DeviceCheck {
  const r = deviceSchema.safeParse(entry);
  if (!r.success) {
    const issue = r.error.issues[0];
    return { kind: 'reject', path: ['discoveredDevices', i, ...(issue?.path ?? [])], message: issue?.message ?? 'invalid' };
  }
  const d = r.data;
  const n = ipv4ToInt(d.ip);
  if (n === null) {
    if (isIPv6(d.ip) || (d.mac !== null && d.mac === probeMac)) return { kind: 'drop' };
    return { kind: 'reject', path: ['discoveredDevices', i, 'ip'], message: 'Invalid IPv4 address' };
  }
  if (NEVER_DEVICE_NETS.some((net) => inNet(n, net))) {
    return { kind: 'reject', path: ['discoveredDevices', i, 'ip'], message: 'Not a device address' };
  }
  // A unicast address the probe can have seen on a LAN: private, or inside
  // one of the subnets it scanned (LANs numbered in public space), or the
  // probe's own outbound address (injected with its MAC).
  const inScope = PRIVATE_NETS.some((net) => inNet(n, net))
    || scanned.some((net) => inNet(n, net))
    || (d.mac !== null && d.mac === probeMac);
  if (!inScope) {
    return {
      kind: 'reject',
      path: ['discoveredDevices', i, 'ip'],
      message: 'Device address is neither private nor inside a scanned subnet',
    };
  }
  return { kind: 'keep', device: d };
}

/**
 * Validates a probe push / scan_result payload. On failure, `error` is a
 * short "path: message" string (control characters removed, ≤ 200 chars) —
 * safe for logs and for the probe's error response.
 */
export function parseProbePush(raw: unknown): ParseProbePushResult {
  const r = probePushSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    return parseFailure(issue?.path ?? [], issue?.message);
  }

  let devices: ProbePushDevice[] | null = null;
  let droppedDevices = 0;
  if (r.data.discoveredDevices) {
    const scanned = r.data.scannedSubnets
      .map(parseIPv4Cidr)
      .filter((n): n is Ipv4Net => n !== null && n.prefix >= 8);
    devices = [];
    for (let i = 0; i < r.data.discoveredDevices.length; i++) {
      const c = checkDevice(r.data.discoveredDevices[i], i, r.data.probeMac, scanned);
      if (c.kind === 'reject') return parseFailure(c.path, c.message);
      if (c.kind === 'drop') droppedDevices++;
      else devices.push(c.device);
    }
  }

  // Flows are secondary data collected from `ss` / `netstat` text output: an
  // entry that does not parse is dropped instead of failing the whole push.
  const flows: FlowEntry[] = [];
  let droppedFlows = 0;
  for (const entry of r.data.discoveredFlows ?? []) {
    const f = flowSchema.safeParse(entry);
    if (!f.success) { droppedFlows++; continue; }
    const proc = f.data.process ?? f.data.sourceProcess;
    const clean = proc ? stripControl(proc) : '';
    flows.push({
      sourceIp: f.data.sourceIp,
      ...(f.data.sourcePort != null ? { sourcePort: f.data.sourcePort } : {}),
      destIp: f.data.destIp,
      destPort: f.data.destPort,
      protocol: f.data.protocol,
      ...(clean ? { process: clean } : {}),
    });
  }

  const d = r.data;
  return {
    ok: true,
    droppedFlows,
    droppedDevices,
    data: {
      hostname: d.hostname,
      probeVersion: d.probeVersion,
      osInfo: d.osInfo,
      probeMac: d.probeMac,
      probeIPs: d.probeIPs,
      discoveredDevices: devices,
      discoveredFlows: flows,
      scannedSubnets: d.scannedSubnets,
      scanDurationMs: d.scanDurationMs,
      skippedSubnets: d.skippedSubnets,
      capabilities: d.capabilities,
      serverScheme: d.serverScheme,
    },
  };
}

// ── Admin API ────────────────────────────────────────────────────────────────

/**
 * A subnet entry of a probe scan config: IPv4 CIDR, or a bare IPv4 network
 * (the probe's exclusion check reads "192.168.1.0" as that /24).
 */
const scanSubnet = z.string().trim().max(43)
  .refine((s) => parseIPv4Cidr(s) !== null || isIPv4(s), 'Invalid subnet (expected e.g. 192.168.1.0/24)');

/**
 * An extra subnet to scan: also at most SCAN_SUBNET_MIN_PREFIX wide
 * ('subnet_too_wide', as for the extraSubnets setting). A bare network
 * address is read as a /24 by the probe.
 */
const extraScanSubnet = scanSubnet.refine((s) => {
  const net = parseIPv4Cidr(s);
  return net === null || net.prefix >= SCAN_SUBNET_MIN_PREFIX;
}, 'subnet_too_wide');

export const probeScanConfigSchema = z.object({
  excludedSubnets: z.array(scanSubnet).max(64).default([]),
  extraSubnets: z.array(extraScanSubnet).max(64).default([]),
  portScanEnabled: z.boolean().optional(),
  portScanPorts: z.array(z.number().int().min(1).max(65535)).max(PROBE_PUSH_LIMITS.openPortsMax).optional(),
  // Not read from the scan config any more (resolved from the site settings);
  // kept so saving a probe does not rewrite older configs needlessly.
  flowAnalysisEnabled: z.boolean().optional(),
});

/**
 * The scan config of a probe update: wide extra subnets pass the syntax check
 * here; updateProbe refuses only those not already stored for the probe
 * (newTooWideExtraSubnet), so editing another part of an older config that
 * holds one does not fail on a value the admin did not touch.
 */
const probeScanConfigUpdateSchema = probeScanConfigSchema.extend({
  extraSubnets: z.array(scanSubnet).max(64).default([]),
});

/** "10.0.0.0/8" → "167772160/8" (network + prefix), else the trimmed text. */
function subnetKey(value: unknown): string {
  const net = parseIPv4Cidr(value);
  return net ? `${net.base}/${net.prefix}` : String(value ?? '').trim();
}

/**
 * Index of the first extra subnet wider than SCAN_SUBNET_MIN_PREFIX that the
 * stored scan config (`stored`: object or JSON text) does not already hold,
 * or -1.
 */
export function newTooWideExtraSubnet(next: readonly string[], stored: unknown): number {
  let storedExtra: unknown = [];
  try {
    const cfg = typeof stored === 'string' ? JSON.parse(stored) as unknown : stored;
    if (cfg && typeof cfg === 'object') storedExtra = (cfg as { extraSubnets?: unknown }).extraSubnets ?? [];
  } catch { /* unreadable: nothing kept */ }
  const kept = new Set(Array.isArray(storedExtra) ? storedExtra.map(subnetKey) : []);
  return next.findIndex((s) => {
    const net = parseIPv4Cidr(s);
    return net !== null && net.prefix < SCAN_SUBNET_MIN_PREFIX && !kept.has(subnetKey(s));
  });
}

export const updateProbeSchema = z.object({
  name: z.string().trim().min(1).max(128).nullable().optional(),
  siteId: z.number().int().positive().max(2_147_483_647).nullable().optional(),
  // New writes: 60-86400 s (older rows may hold 30-59 s: clamped when sent).
  scanIntervalSeconds: z.number().int().min(SCAN_INTERVAL_MIN_SECONDS).max(SCAN_INTERVAL_MAX_SECONDS).optional(),
  scanConfig: probeScanConfigUpdateSchema.optional(),
  scanConfigOverride: z.boolean().optional(),
  isPrimary: z.boolean().optional(),
});

export type UpdateProbeInput = z.infer<typeof updateProbeSchema>;

const siteIdSchema = z.number().int().positive().max(2_147_483_647);

export const createProbeApiKeySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(128),
  /** Site given at approval to the probes of this key that have none. */
  defaultSiteId: siteIdSchema.nullable().optional(),
});

export type CreateProbeApiKeyInput = z.infer<typeof createProbeApiKeySchema>;

export const updateProbeApiKeySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(128).optional(),
  defaultSiteId: siteIdSchema.nullable().optional(),
}).refine((v) => v.name !== undefined || v.defaultSiteId !== undefined, 'Nothing to update');

export type UpdateProbeApiKeyInput = z.infer<typeof updateProbeApiKeySchema>;

/** POST /devices/:id/approve — optional site (else the key's default site). */
export const approveProbeSchema = z.object({
  siteId: siteIdSchema.optional(),
}).default({});

export type ApproveProbeInput = z.infer<typeof approveProbeSchema>;

export const PROBE_COMMANDS = ['uninstall', 'update', 'rescan'] as const;
export type ProbeCommand = (typeof PROBE_COMMANDS)[number];

export const probeCommandSchema = z.object({
  command: z.enum(PROBE_COMMANDS),
});

export const PROBE_BULK_MAX_IDS = 500;

export const probeBulkSchema = z.object({
  action: z.enum(['approve', 'delete', 'uninstall', 'suspend', 'unsuspend']),
  ids: z.array(z.number().int().positive().max(2_147_483_647)).min(1).max(PROBE_BULK_MAX_IDS),
});

export type ProbeBulkInput = z.infer<typeof probeBulkSchema>;

/**
 * Bulk site creation from unassigned probes (AdminProbePage "Create sites"):
 * the client derives each site name from the probe names (prefix / suffix
 * stripped) and shows the preview; the server re-checks every probe and
 * creates or reuses the sites.
 */
export const probeCreateSitesSchema = z.object({
  groupId: z.number().int().positive().max(2_147_483_647).nullable(),
  /** Approve the pending probes of the plan (needs probes.approve). */
  approvePending: z.boolean().default(true),
  sites: z.array(z.object({
    name: z.string().trim().min(1, 'Name is required').max(128),
    probeIds: z.array(z.number().int().positive().max(2_147_483_647)).min(1).max(16),
    primaryProbeId: z.number().int().positive().max(2_147_483_647),
  }).refine((s) => s.probeIds.includes(s.primaryProbeId), { message: 'The primary probe must be one of the site probes', path: ['primaryProbeId'] }))
    .min(1).max(500),
}).refine((b) => {
  const all = b.sites.flatMap((s) => s.probeIds);
  return new Set(all).size === all.length;
}, { message: 'A probe can only go to one site', path: ['sites'] });

export type ProbeCreateSitesInput = z.infer<typeof probeCreateSitesSchema>;
