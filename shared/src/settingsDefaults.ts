// IPAM-specific settings keys and defaults

export type SettingsKey =
  | 'scanIntervalSeconds'
  | 'maxMissedPushes'
  | 'offlineThresholdMultiplier'
  | 'probeOfflineGraceMinutes'
  | 'notificationEnabled'
  | 'notifyNewDevice'
  | 'notifyDeviceOffline'
  | 'notifyDeviceOnline'
  | 'notifyIpConflict'
  | 'notifyProbeOffline'
  | 'excludedSubnets'
  | 'extraSubnets'
  | 'portScanEnabled'
  | 'portScanPorts'
  | 'flowAnalysisEnabled'
  | 'deviceChecksEnabled'
  | 'businessHours'
  | 'takeoverWindowMinutes'
  | 'staleDeviceDays'
  | 'alertOnlyWatchedDevices'
  | 'probeUpdatePolicy';

export const SETTINGS_KEYS: SettingsKey[] = [
  'scanIntervalSeconds',
  'maxMissedPushes',
  'offlineThresholdMultiplier',
  'probeOfflineGraceMinutes',
  'notificationEnabled',
  'notifyNewDevice',
  'notifyDeviceOffline',
  'notifyDeviceOnline',
  'notifyIpConflict',
  'notifyProbeOffline',
  'excludedSubnets',
  'extraSubnets',
  'portScanEnabled',
  'portScanPorts',
  'flowAnalysisEnabled',
  'deviceChecksEnabled',
  'businessHours',
  'takeoverWindowMinutes',
  'staleDeviceDays',
  'alertOnlyWatchedDevices',
  'probeUpdatePolicy',
];

export const SETTINGS_DEFAULTS: Record<SettingsKey, string | number | boolean> = {
  scanIntervalSeconds: 300,
  maxMissedPushes: 3,
  offlineThresholdMultiplier: 2,
  probeOfflineGraceMinutes: 10,
  notificationEnabled: true,
  notifyNewDevice: true,
  notifyDeviceOffline: true,
  notifyDeviceOnline: false,
  notifyIpConflict: true,
  notifyProbeOffline: true,
  excludedSubnets: '[]',
  extraSubnets: '[]',
  portScanEnabled: false,
  portScanPorts: '[]',
  flowAnalysisEnabled: false,
  deviceChecksEnabled: true,
  businessHours: '{}',
  takeoverWindowMinutes: 30,
  staleDeviceDays: 0,
  alertOnlyWatchedDevices: false,
  probeUpdatePolicy: 'auto',
};

// Alias for backwards compat
export const HARDCODED_DEFAULTS = SETTINGS_DEFAULTS;

/**
 * Bounds of a probe scan interval (settings key scanIntervalSeconds and the
 * probe's own interval). A stored value below the minimum (older releases
 * accepted 30 s on probes) stays readable; the server clamps it when it
 * sends the configuration.
 */
export const SCAN_INTERVAL_MIN_SECONDS = 60;
export const SCAN_INTERVAL_MAX_SECONDS = 86400;

/**
 * Widest extra subnet accepted (prefix length): a wider network cannot be
 * swept host by host in one scan cycle (the probe reports it as skipped).
 * New writes of a wider extraSubnets entry are refused with 'subnet_too_wide'.
 */
export const SCAN_SUBNET_MIN_PREFIX = 16;

/**
 * Probe self-update policy (settings key probeUpdatePolicy), resolved
 * Global → Group chain → Site for a probe (its site):
 *  - 'auto': the server announces its probe version (latestVersion) to the
 *    approved probes of the scope, which install it themselves;
 *  - 'manual': no announcement, only the explicit 'update' command (probe
 *    page, "Update outdated probes");
 *  - 'frozen': no announcement, and "Update outdated probes" skips the scope
 *    (the explicit per-probe 'update' command still works).
 * Probes that do not advertise PROBE_UPDATE_POLICY_CAPABILITY still check
 * GET /api/probe/version at startup and update whatever the policy.
 */
export const PROBE_UPDATE_POLICIES = ['auto', 'manual', 'frozen'] as const;
export type ProbeUpdatePolicy = typeof PROBE_UPDATE_POLICIES[number];
export const DEFAULT_PROBE_UPDATE_POLICY: ProbeUpdatePolicy = 'auto';

/** A stored value → a policy ('auto' for anything unknown, as the default). */
export function toProbeUpdatePolicy(value: unknown): ProbeUpdatePolicy {
  return typeof value === 'string' && (PROBE_UPDATE_POLICIES as readonly string[]).includes(value)
    ? value as ProbeUpdatePolicy
    : DEFAULT_PROBE_UPDATE_POLICY;
}

/** Advertised by probes that skip the unauthenticated startup update check. */
export const PROBE_UPDATE_POLICY_CAPABILITY = 'update_policy:1';
/** Advertised by probes that report aborted updates over HTTP (POST /api/probe/agent/update-aborted). */
export const PROBE_UPDATE_ABORT_HTTP_CAPABILITY = 'update_abort_http:1';

export interface SettingDefinition {
  key: SettingsKey;
  label: string;
  /**
   * 'schedule' = BusinessHours JSON object (see deviceChecks.ts);
   * 'select' = one string among `options`.
   */
  type: 'number' | 'boolean' | 'json' | 'schedule' | 'select';
  defaultValue: string | number | boolean;
  min?: number;
  max?: number;
  /** 'select' only: the accepted values (labels: settings.options.<key>.<value>). */
  options?: readonly string[];
  description?: string;
  unit?: string;
}

// Alerting (server/src/services/probe.service.ts):
//  - maxMissedPushes: a discovered device goes offline only after this many
//    consecutive scans of its probe did not see it (debounce);
//  - offlineThresholdMultiplier × the probe's scan interval, and at least
//    probeOfflineGraceMinutes, without any contact: the probe is offline;
//  - notificationEnabled is the master switch of the IPAM alerts of a scope
//    (live alerts and notification channels); each notify* key turns one
//    event type on or off under it;
//  - takeoverWindowMinutes: a new MAC on a known IP raises an IP takeover
//    only if the previous owner was seen within it (DHCP reuse otherwise);
//  - alertOnlyWatchedDevices: device offline / back-online alerts only for
//    the devices set to always (site_items.alert_mode); never devices
//    never alert, whatever this setting.
// Probes (server/src/services/probe.service.ts):
//  - probeUpdatePolicy: see PROBE_UPDATE_POLICIES.
// Retention (server/src/services/deviceChecks/sweeper.ts, hourly):
//  - staleDeviceDays: discovered devices offline that long are deleted
//    (0 = never; manual and reserved devices are kept).
export const SETTINGS_DEFINITIONS: SettingDefinition[] = [
  { key: 'scanIntervalSeconds', label: 'Scan Interval (seconds)', type: 'number', defaultValue: 300, min: SCAN_INTERVAL_MIN_SECONDS, max: SCAN_INTERVAL_MAX_SECONDS, description: 'How often the probes of this scope sweep their subnets' },
  { key: 'maxMissedPushes', label: 'Max Missed Pushes', type: 'number', defaultValue: 3, min: 1, max: 20, description: 'Consecutive scans a device may be missing before it is marked offline' },
  { key: 'offlineThresholdMultiplier', label: 'Offline Threshold Multiplier', type: 'number', defaultValue: 2, min: 1, max: 10, description: 'A probe is offline after this many scan intervals without contact (never before the probe offline grace period)' },
  { key: 'probeOfflineGraceMinutes', label: 'Probe Offline Grace Period', type: 'number', defaultValue: 10, min: 1, max: 1440, unit: 'min', description: 'Minimum time without contact before a probe is reported offline' },
  { key: 'notificationEnabled', label: 'Notifications Enabled', type: 'boolean', defaultValue: true, description: 'Master switch for the alerts of this scope (live alerts and notification channels)' },
  { key: 'notifyNewDevice', label: 'Notify: New Device', type: 'boolean', defaultValue: true, description: 'A probe discovered a device never seen on the site' },
  { key: 'notifyDeviceOffline', label: 'Notify: Device Offline', type: 'boolean', defaultValue: true, description: 'A device was not seen for Max Missed Pushes consecutive scans' },
  { key: 'notifyDeviceOnline', label: 'Notify: Device Back Online', type: 'boolean', defaultValue: false, description: 'An offline device was seen again' },
  { key: 'notifyIpConflict', label: 'Notify: IP Conflict', type: 'boolean', defaultValue: true, description: 'IP takeover (a new MAC on a known IP) and IP instability' },
  { key: 'notifyProbeOffline', label: 'Notify: Probe Offline', type: 'boolean', defaultValue: true, description: 'A probe stopped contacting the server, and when it is back' },
  { key: 'excludedSubnets', label: 'Excluded Subnets', type: 'json', defaultValue: '[]', description: 'Subnets to exclude from scanning' },
  { key: 'extraSubnets', label: 'Extra Subnets', type: 'json', defaultValue: '[]', description: 'Additional subnets to scan' },
  { key: 'portScanEnabled', label: 'Port Scan Enabled', type: 'boolean', defaultValue: false, description: 'Also probe the Port Scan Ports on every discovered device (slower scans)' },
  { key: 'portScanPorts', label: 'Port Scan Ports', type: 'json', defaultValue: '[]', description: 'Ports to scan on discovered devices' },
  { key: 'flowAnalysisEnabled', label: 'Network Flow Analysis', type: 'boolean', defaultValue: false, description: 'Capture active TCP/UDP connections on probes for network mapping' },
  { key: 'deviceChecksEnabled', label: 'Device checks enabled', type: 'boolean', defaultValue: true, description: 'Run device check rules on matching devices (off-switch per group or site)' },
  { key: 'businessHours', label: 'Business hours', type: 'schedule', defaultValue: '{}', description: 'Opening hours used by device check alerting (empty = always open)' },
  { key: 'takeoverWindowMinutes', label: 'IP Takeover Window', type: 'number', defaultValue: 30, min: 1, max: 10080, unit: 'min', description: 'A new MAC on a known IP is an IP takeover only if the previous owner was seen within this window (otherwise the DHCP lease was reused: no alert)' },
  { key: 'staleDeviceDays', label: 'Purge Stale Devices After (days)', type: 'number', defaultValue: 0, min: 0, max: 3650, unit: 'days', description: 'Discovered devices offline for this many days are deleted (manual and reserved devices are kept; 0 = never)' },
  { key: 'alertOnlyWatchedDevices', label: 'Alert Only for Watched Devices', type: 'boolean', defaultValue: false, description: 'Device offline / back online alerts only for the devices whose alerts are set to Always (devices set to Never never alert)' },
  { key: 'probeUpdatePolicy', label: 'Probe Update Policy', type: 'select', defaultValue: 'auto', options: PROBE_UPDATE_POLICIES, description: 'Automatic: probes install the probe version shipped by the server themselves. Manual: only when asked. Frozen: never as part of a fleet update (older probes still update at startup)' },
];
