import type { DeviceType } from '@oblimap/shared';

// Device tracking helpers of the scan pipeline (probe.service processDevices).
// Pure functions only (no database access): unit-tested in
// tests/unit/services/deviceClassification.test.ts and takeoverDecision.test.ts.

// ─── MAC addresses ───────────────────────────────────────────────────────────

/**
 * True when the MAC is locally administered: bit 0x02 of the first octet set,
 * i.e. the second hex digit is 2, 6, A or E ("x2:…", "x6:…", "xA:…", "xE:…").
 * Phones, tablets and laptops use such randomized ("private") addresses and
 * rotate them, so the address alone does not identify the device. Accepts
 * "AA:BB:…", "AA-BB-…" and bare "AABB…" forms; anything unparsable is false.
 */
export function isLocallyAdministered(mac: string | null | undefined): boolean {
  if (typeof mac !== 'string') return false;
  const hex = mac.trim().replace(/[:\-.]/g, '');
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return false;
  return (parseInt(hex.slice(0, 2), 16) & 0x02) !== 0;
}

// ─── Port-based classification ───────────────────────────────────────────────

const WINDOWS_PORTS = [445, 3389, 5985, 135];
const WEB_PORTS = [80, 443, 8080];
const PRINTER_PORTS = [9100, 515, 631];

/**
 * Device type guessed from the open TCP ports of the last port scan, or null
 * when the ports say nothing. Follows Obliance's agent classifyByPorts
 * (agent/network_scan.go), first matching rule wins:
 *  1. printer   — 9100 (raw / JetDirect), 515 (LPD) or 631 (IPP);
 *  2. camera    — 554 (RTSP) without 22: IP cameras and NVRs stream over RTSP
 *                 and rarely expose SSH (a server running an RTSP service
 *                 usually does). Oblimap-specific rule, Obliance has no camera type;
 *  3. server    — a Windows port (445 SMB, 3389 RDP, 5985 WinRM, 135 RPC) and
 *                 a web port (80, 443, 8080);
 *  4. workstation — a Windows port alone (Obliance 'pc');
 *  5. switch    — 161 (SNMP) without Windows ports (Obliance 'network'; the
 *                 probe only scans TCP, so this rarely fires);
 *  6. server    — 22 (SSH) and a web port, no Windows port;
 *  7. workstation — 22 alone (Obliance 'pc': a Linux / macOS host);
 * otherwise null (the device keeps its current type).
 */
export function classifyByPorts(openPorts: readonly number[] | null | undefined): DeviceType | null {
  if (!Array.isArray(openPorts) || openPorts.length === 0) return null;
  const ports = new Set<number>();
  for (const p of openPorts) {
    const n = typeof p === 'number' ? p : Number(p);
    if (Number.isInteger(n) && n > 0 && n <= 65535) ports.add(n);
  }
  const any = (list: number[]): boolean => list.some((p) => ports.has(p));
  const hasWindows = any(WINDOWS_PORTS);
  const hasWeb = any(WEB_PORTS);
  const hasSsh = ports.has(22);

  if (any(PRINTER_PORTS)) return 'printer';
  if (ports.has(554) && !hasSsh) return 'camera';
  if (hasWindows && hasWeb) return 'server';
  if (hasWindows) return 'workstation';
  if (ports.has(161)) return 'switch';
  if (hasSsh && hasWeb) return 'server';
  if (hasSsh) return 'workstation';
  return null;
}

/** open_ports as stored (JSON text or array) → numbers. */
export function parseOpenPorts(raw: unknown): number[] {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  return v.map((p) => Number(p)).filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
}

// ─── Vendor rules ────────────────────────────────────────────────────────────

export interface VendorRuleRow {
  vendor_pattern?: unknown;
  device_type?: unknown;
  label?: unknown;
}

/**
 * First rule (rows already sorted by priority desc, id asc) whose pattern is
 * contained in the vendor, case-insensitive. Empty patterns never match (they
 * would match every vendor). Null when nothing matches.
 */
export function matchVendorRule(
  rules: readonly VendorRuleRow[],
  vendor: string | null | undefined,
): { deviceType: string; label: string | null } | null {
  if (!vendor) return null;
  const vendorLower = vendor.toLowerCase();
  for (const rule of rules) {
    const pattern = String(rule.vendor_pattern ?? '').trim().toLowerCase();
    if (!pattern) continue;
    if (vendorLower.includes(pattern) && typeof rule.device_type === 'string' && rule.device_type) {
      const label = typeof rule.label === 'string' ? rule.label.trim() : '';
      return { deviceType: rule.device_type, label: label || null };
    }
  }
  return null;
}

/** Where a device's type came from (site_items.device_type_source). */
export type DeviceTypeSource = 'manual' | 'rule' | 'ports' | 'probe';

/**
 * Whether the scan pipeline may (re)classify a known device: never one typed
 * by hand ('manual', and pre-048 typed rows backfilled as such), never one
 * whose type was set without a recorded source (a manual edit); otherwise
 * when it is still 'unknown', or when its type came from a rule or the ports
 * and its vendor just arrived (a vendor rule beats a port guess).
 */
export function mayReclassify(
  deviceType: string | null | undefined,
  source: string | null | undefined,
  vendorArrived: boolean,
): boolean {
  if (source === 'manual') return false;
  const type = deviceType || 'unknown';
  if (type === 'unknown') return true;
  return vendorArrived && (source === 'rule' || source === 'ports');
}

// ─── IP claims (DHCP reuse vs takeover) ──────────────────────────────────────

export const DEFAULT_TAKEOVER_WINDOW_MINUTES = 30;

/**
 * A MAC never seen on the site claims an IP held by another MAC (pure):
 *  - 'takeover' (alerted) only when the previous owner was seen within the
 *    window and its MAC is not randomized: two real devices fighting over
 *    one address;
 *  - 'reassigned' (quiet) otherwise: the DHCP lease went to another device
 *    after the old one left, or the old owner was a rotating private MAC.
 * The old row is never overwritten in either case (it keeps its name / type).
 */
export function decideIpClaim(input: {
  oldLastSeenAt: Date | string | number | null | undefined;
  oldMac: string | null | undefined;
  now: Date | number;
  windowMinutes: number;
}): 'takeover' | 'reassigned' {
  if (isLocallyAdministered(input.oldMac)) return 'reassigned';
  const raw = input.oldLastSeenAt;
  const lastSeen = raw == null ? NaN
    : typeof raw === 'number' ? raw
      : (raw instanceof Date ? raw : new Date(String(raw))).getTime();
  if (!Number.isFinite(lastSeen)) return 'reassigned';
  const now = typeof input.now === 'number' ? input.now : input.now.getTime();
  const window = Number.isFinite(input.windowMinutes) && input.windowMinutes > 0
    ? input.windowMinutes
    : DEFAULT_TAKEOVER_WINDOW_MINUTES;
  return now - lastSeen <= window * 60_000 ? 'takeover' : 'reassigned';
}

/** True when there is at least one MAC and every one is randomized (no conflict alert then). */
export function allRandomized(macs: Iterable<string | null | undefined>): boolean {
  let count = 0;
  for (const mac of macs) {
    if (!isLocallyAdministered(mac)) return false;
    count++;
  }
  return count > 0;
}
