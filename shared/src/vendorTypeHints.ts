import type { DeviceType } from './types';

// Best-effort vendor → device type suggestions ("Auto rules" of the vendor
// rules page). A hint matches an IEEE vendor name by case-insensitive
// substring, like a vendor rule. `ambiguous` marks vendors whose products
// span several types (the suggestion is their most common type on a LAN):
// the UI asks the user to check them.
//
// OUI blocks are assigned per company, not per product line (a TP-Link
// switch and a TP-Link access point share the same prefixes), so the hints
// work on the vendor name only.

/** A vendor name seen on the tenant's devices (GET /vendor-rules/observed-vendors). */
export interface ObservedVendor {
  vendor: string;
  /** Devices with this vendor (readable sites). */
  devices: number;
  /** Of which still without a type ('unknown'). */
  untyped: number;
}

export interface VendorTypeHint {
  /** Lower-case substring of the vendor name (also the rule pattern created). */
  pattern: string;
  type: DeviceType;
  ambiguous?: boolean;
}

export const VENDOR_TYPE_HINTS: readonly VendorTypeHint[] = [
  // Cameras / people counters
  { pattern: 'hikvision', type: 'camera' },
  { pattern: 'dahua', type: 'camera' },
  { pattern: 'axis communications', type: 'camera' },
  { pattern: 'hanwha', type: 'camera' },
  { pattern: 'uniview', type: 'camera' },
  { pattern: 'vivotek', type: 'camera' },
  { pattern: 'mobotix', type: 'camera' },
  { pattern: 'avigilon', type: 'camera' },
  { pattern: 'xovis', type: 'counter' },

  // Access points
  { pattern: 'cisco meraki', type: 'ap', ambiguous: true },
  { pattern: 'ubiquiti', type: 'ap', ambiguous: true },
  { pattern: 'aruba', type: 'ap', ambiguous: true },
  { pattern: 'ruckus', type: 'ap' },
  { pattern: 'cambium', type: 'ap' },
  { pattern: 'engenius', type: 'ap' },
  { pattern: 'aerohive', type: 'ap' },
  { pattern: 'mist systems', type: 'ap' },

  // Switches
  { pattern: 'tp-link', type: 'switch', ambiguous: true },
  { pattern: 'netgear', type: 'switch', ambiguous: true },
  { pattern: 'd-link', type: 'switch', ambiguous: true },
  { pattern: 'zyxel', type: 'switch', ambiguous: true },
  { pattern: 'cisco', type: 'switch', ambiguous: true },
  { pattern: 'juniper', type: 'switch', ambiguous: true },
  { pattern: 'allied telesis', type: 'switch' },
  { pattern: 'extreme networks', type: 'switch' },
  { pattern: 'h3c', type: 'switch' },

  // Routers
  { pattern: 'routerboard', type: 'router' },
  { pattern: 'mikrotik', type: 'router' },
  { pattern: 'draytek', type: 'router' },
  { pattern: 'teltonika', type: 'router' },
  { pattern: 'avm gmbh', type: 'router' },
  { pattern: 'avm audiovisuelles', type: 'router' },
  { pattern: 'sagemcom', type: 'router' },

  // Firewalls
  { pattern: 'fortinet', type: 'firewall' },
  { pattern: 'sophos', type: 'firewall' },
  { pattern: 'palo alto networks', type: 'firewall' },
  { pattern: 'watchguard', type: 'firewall' },
  { pattern: 'sonicwall', type: 'firewall' },
  { pattern: 'check point', type: 'firewall' },
  { pattern: 'netgate', type: 'firewall' },

  // Printers
  { pattern: 'brother', type: 'printer' },
  { pattern: 'canon inc', type: 'printer', ambiguous: true },
  { pattern: 'seiko epson', type: 'printer' },
  { pattern: 'kyocera', type: 'printer' },
  { pattern: 'lexmark', type: 'printer' },
  { pattern: 'ricoh', type: 'printer' },
  { pattern: 'konica minolta', type: 'printer' },
  { pattern: 'xerox', type: 'printer' },
  { pattern: 'zebra technologies', type: 'printer' },
  { pattern: 'oki electric', type: 'printer' },
  { pattern: 'toshiba tec', type: 'printer' },

  // VoIP phones
  { pattern: 'yealink', type: 'phone' },
  { pattern: 'polycom', type: 'phone' },
  { pattern: 'snom', type: 'phone' },
  { pattern: 'grandstream', type: 'phone' },
  { pattern: 'gigaset', type: 'phone' },
  { pattern: 'fanvil', type: 'phone' },
  { pattern: 'mitel', type: 'phone' },
  { pattern: 'avaya', type: 'phone' },

  // NAS
  { pattern: 'synology', type: 'nas' },
  { pattern: 'qnap', type: 'nas' },
  { pattern: 'asustor', type: 'nas' },

  // Virtual machines (hypervisor OUIs)
  { pattern: 'vmware', type: 'vm' },
  { pattern: 'proxmox', type: 'vm' },
  { pattern: 'xensource', type: 'vm' },
  { pattern: 'parallels', type: 'vm' },
  { pattern: 'pcs systemtechnik', type: 'vm' },

  // Servers
  { pattern: 'super micro', type: 'server' },

  // IoT
  { pattern: 'espressif', type: 'iot' },
  { pattern: 'tuya', type: 'iot' },
  { pattern: 'shelly', type: 'iot' },
  { pattern: 'allterco', type: 'iot' },
  { pattern: 'sonos', type: 'iot' },
  { pattern: 'barix', type: 'iot' },
  { pattern: 'raspberry pi', type: 'iot', ambiguous: true },
];

/**
 * The hint of a vendor name: the longest matching pattern wins ("cisco
 * meraki" before "cisco"). Null when no hint applies.
 */
export function suggestDeviceTypeForVendor(vendor: string | null | undefined): VendorTypeHint | null {
  if (!vendor) return null;
  const v = vendor.toLowerCase();
  let best: VendorTypeHint | null = null;
  for (const hint of VENDOR_TYPE_HINTS) {
    if (v.includes(hint.pattern) && (!best || hint.pattern.length > best.pattern.length)) best = hint;
  }
  return best;
}

/**
 * Priority given to a rule created from a hint: below the default 0 of a
 * rule written by hand, longer (more specific) patterns first.
 */
export function autoRulePriority(pattern: string): number {
  return -200 + Math.min(pattern.length, 100);
}
