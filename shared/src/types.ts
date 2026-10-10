import type { UserRole } from './ipamTypes';
import type { SettingsKey } from './settingsDefaults';
import type { BusinessHours, DeviceCheckSummary } from './deviceChecks';

// ============================================
// App / Theme
// ============================================
export type AppTheme = 'obli-operator' | 'obli-daylight' | 'obli-dim' | 'modern' | 'neon';

export interface UserPreferences {
  toastEnabled: boolean;
  toastPosition: 'top-center' | 'bottom-right';
  multiTenantNotificationsEnabled?: boolean;
  preferredTheme?: AppTheme;
  anonymousMode?: boolean;
}

/**
 * Shape of a live alert as returned by the server (lists and NOTIFICATION_NEW).
 * NOTIFICATION_NEW also carries an alert the client may already hold, when it
 * was resolved: same id, resolvedAt set.
 */
export interface LiveAlertData {
  id: number;
  tenantId: number;
  tenantName?: string;
  severity: 'down' | 'up' | 'warning' | 'info';
  title: string;
  message: string;
  navigateTo: string | null;
  stableKey: string | null;
  read: boolean;
  createdAt: string;
  /** ISO time the problem ended (device / probe back online), null while it lasts. */
  resolvedAt?: string | null;
  /** Site the alert is about: only members who may read that site receive it. */
  siteId?: number | null;
  /**
   * Machine-readable kind of the alert (LIVE_ALERT_KINDS) and its parameters:
   * clients render a translated, anonymizable title / message from them
   * (liveAlerts.kinds.<kind>.title / .message). title / message stay the
   * English text (notification channels, older clients). Null on rows written
   * before migration 052 and on alerts without a kind.
   */
  kind?: LiveAlertKind | string | null;
  params?: LiveAlertParams | null;
}

/** Kinds of the structured live alerts (server-generated). */
export const LIVE_ALERT_KINDS = [
  'device_offline',
  'device_online',
  'ip_takeover',
  'ip_instability',
  'probe_offline',
  'channel_target_blocked',
  'device_check_open',
  'device_check_recovered',
] as const;

export type LiveAlertKind = (typeof LIVE_ALERT_KINDS)[number];

/**
 * Parameters of a structured live alert. Keys by kind:
 *  - device_offline / device_online: name, ip, siteName (+ mac when known);
 *  - ip_takeover: ip, oldMac, newMac (+ oldName, siteName);
 *  - ip_instability: ip, macCount (+ siteName);
 *  - probe_offline: name (+ siteName, minutes);
 *  - channel_target_blocked: channelName;
 *  - device_check_open / device_check_recovered: ruleName, deviceName, ip (+ siteName).
 *    device_check_open may carry `detail`: FREE TEXT (the default message, or
 *    the failed assertion / error text) that can hold raw IPs, MACs or
 *    extracted values; the client must regex-mask it (IPv4 / MAC) in
 *    anonymous mode.
 * IPs, MACs and names are to be anonymized by the client in anonymous mode.
 */
export type LiveAlertParams = Record<string, string | number | null>;

// ============================================
// Users
// ============================================
export interface User {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  preferences?: UserPreferences | null;
  email?: string | null;
  preferredLanguage: string;
  enrollmentVersion: number;
  totpEnabled?: boolean;
  emailOtpEnabled?: boolean;
  /** SSO foreign user fields — null for local users */
  foreignSource?: string | null;
  foreignId?: number | null;
  foreignSourceUrl?: string | null;
  /** True when user has no local password (SSO-only account) */
  hasPassword?: boolean;
  /** Profile picture URL — synced from Obligate via SSO. */
  avatar?: string | null;
  /** True when the user must set a new password before using the app (bootstrap admin, admin reset). */
  mustChangePassword?: boolean;
}

export interface UserWithPassword extends User {
  passwordHash: string;
}

// ============================================
// Groups
// ============================================
export interface MonitorGroup {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  parentId: number | null;
  tenantId: number;
  kind?: 'monitor' | 'agent' | null; // keep for backwards compat
  sortOrder?: number | null;
  isGeneral?: boolean;
  groupNotifications?: boolean;
  agentThresholds?: unknown;
  agentGroupConfig?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface GroupTreeNode extends MonitorGroup {
  children: GroupTreeNode[];
  depth: number;
  monitors?: any[];
  sites?: Array<{ id: number; name: string; itemCount: number; onlineCount: number; offlineCount: number; probeCount: number }>;
}

export interface GroupStats {
  groupId: number;
  siteCount: number;
  onlineCount: number;
  offlineCount: number;
}

// ============================================
// Teams
// ============================================
export interface UserTeam {
  id: number;
  name: string;
  description: string | null;
  canCreate: boolean;
  tenantId: number;
  tenantName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamPermission {
  id: number;
  teamId: number;
  /** A group (with its sub-groups and their sites) or one site. */
  scope: PermissionScope;
  scopeId: number;
  level: 'ro' | 'rw';
}

/** GET /teams/:id */
export interface TeamDetail extends UserTeam {
  memberIds: number[];
  permissions: TeamPermission[];
  /** Users who may join the team: the members of the team's tenant. */
  eligibleMemberIds: number[];
}

// ============================================
// Tenants
// ============================================
export interface Tenant {
  id: number;
  name: string;
  slug: string;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Tenant role of a membership (user_tenants.role): 'admin' = tenant admin,
 * otherwise a permission set slug; the legacy 'member' reads as 'viewer'.
 */
export type TenantRole = string;

export interface TenantMembership {
  tenantId: number;
  role: TenantRole;
}

export interface TenantWithRole extends Tenant {
  role: TenantRole;
}

export interface UserTenantAssignment {
  tenantId: number;
  tenantName: string;
  tenantSlug: string;
  isMember: boolean;
  role: TenantRole;
}

// ============================================
// Settings
// ============================================
export type SettingsScope = 'global' | 'group' | 'site' | 'monitor';

export interface SettingValue {
  /** BusinessHours for 'schedule' settings (businessHours); the hardcoded default is the '{}' string */
  value: string | number | boolean | string[] | number[] | BusinessHours | null;
  source: SettingsScope | 'default';
  sourceId: number | null;
  sourceName: string | null;
}

export type ResolvedSettings = Record<SettingsKey, SettingValue>;

// ============================================
// Notifications
// ============================================
export type NotificationOverrideMode = 'merge' | 'replace' | 'exclude';

// Aliases for backwards compat
export type OverrideMode = NotificationOverrideMode;
export type NotificationOverride = NotificationOverrideMode;

export interface NotificationChannel {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  tenantId?: number;
  isEnabled?: boolean;
  isShared?: boolean;
  createdBy?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationBinding {
  id: number;
  channelId: number;
  channelName?: string;
  channelType?: string;
  scope: string;
  scopeId: number | null;
  overrideMode: NotificationOverrideMode;
  onDown?: boolean;
  onUp?: boolean;
  onWarning?: boolean;
  tenantId?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface NotificationPluginMeta {
  type: string;
  name: string;
  description: string;
  configFields: NotificationConfigField[];
}

// NotificationConfigField (used in notification plugin metadata)
export interface NotificationConfigField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  description?: string;
}

// ============================================
// App Config (used by appConfig.service)
// ============================================
export interface AppConfig {
  obligateUrl?: string | null;
  obligateEnabled?: boolean;
  allow_2fa?: boolean;
  force_2fa?: boolean;
  otp_smtp_server_id?: number | null;
  [key: string]: unknown;
}

/**
 * GET / PUT /admin/config/obligate: flags only, never a secret. The client_id
 * this app sends to Obligate (/authorize) is always the public client id,
 * sha256(API key) as lowercase hex: the key itself stays server-side.
 */
export interface ObligateConfig {
  url: string | null;
  apiKeySet: boolean;
  enabled: boolean;
  /** A distinct inbound secret is in force (setting or env); its value is never returned. */
  inboundSecretSet: boolean;
  inboundSecretFromEnv: boolean;
}

// ============================================
// SmtpServer (used by smtpServer.service)
// ============================================
export interface SmtpServer {
  id: number;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  fromAddress: string | null;
  isDefault?: boolean;
  tenantId?: number;
  /** A password is stored (never returned). */
  passwordSet?: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================
// Permission
// ============================================
export type PermissionLevel = 'ro' | 'rw';

// ============================================
// User permissions
// ============================================
export interface UserPermissions {
  role?: UserRole;
  canCreate: boolean;
  canWriteSite?: boolean;
  canWriteGroup?: boolean;
  canAdmin?: boolean;
  teams?: number[] | Array<{
    teamId: number;
    teamName: string;
    permission: 'read' | 'write';
    scopeId: number | null;
    scope: string;
  }>;
  permissions?: Record<string, PermissionLevel>;
  /** Tenant capabilities held in the current tenant (server TENANT_CAPABILITIES keys). */
  capabilities?: string[];
}

// ============================================
// IPAM — Device Types
// ============================================
export type DeviceType =
  | 'router'
  | 'switch'
  | 'server'
  | 'printer'
  | 'iot'
  | 'camera'
  | 'counter'
  | 'workstation'
  | 'phone'
  | 'gsm'
  | 'laptop'
  | 'vm'
  | 'ap'
  | 'firewall'
  | 'nas'
  | 'unknown';

export type ItemStatus = 'online' | 'offline' | 'reserved' | 'unknown';

// ============================================
// IPAM — Sites
// ============================================
export interface Site {
  id: number;
  name: string;
  description: string | null;
  groupId: number | null;
  tenantId: number;
  createdAt: string;
  updatedAt: string;
  /** Counts populated by JOIN queries */
  itemCount?: number;
  onlineCount?: number;
  offlineCount?: number;
  probeCount?: number;
  /** Approved probes of the site currently online (not reported offline). */
  onlineProbeCount?: number;
}

// ============================================
// IPAM — Site Items (network devices)
// ============================================
export interface SiteItem {
  id: number;
  siteId: number;
  tenantId: number;
  ip: string;
  mac: string | null;
  /** Hostname from DNS/ARP — original, not editable by user */
  hostname: string | null;
  /** User-set display name (replaces hostname in UI when set) */
  customName: string | null;
  deviceType: DeviceType;
  vendor: string | null;
  notes: string | null;
  status: ItemStatus;
  isManual: boolean;
  discoveredByProbeId: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  /** True if a reservation exists for this item's IP */
  hasReservationConflict?: boolean;
  /** True if this item corresponds to a known probe (matched by IP or MAC) */
  isProbe?: boolean;
  /** The probe ID if this item is a probe, for linking to probe detail */
  probeId?: number | null;
  /** Open TCP ports discovered by the last port scan */
  openPorts?: number[] | null;
  /** Latest device check results for this item (enabled rules only, worst status first) */
  checks?: DeviceCheckSummary[];
  /**
   * Where deviceType came from: 'manual' (set by a user, never reclassified),
   * 'rule' (vendor rule), 'ports' (open-port guess), 'probe'; null = not
   * classified yet.
   */
  deviceTypeSource?: string | null;
  /** Locally administered (randomized / private) MAC address. */
  macRandomized?: boolean;
  /**
   * Offline / back-online alerts of this device (migration 052): 'inherit'
   * follows the alertOnlyWatchedDevices setting, 'always' alerts even when
   * only watched devices alert, 'never' raises none (an existing offline
   * alert is still resolved).
   */
  alertMode?: ItemAlertMode;
}

export const ITEM_ALERT_MODES = ['inherit', 'always', 'never'] as const;
export type ItemAlertMode = (typeof ITEM_ALERT_MODES)[number];

/** Kinds of the device event history (site_item_events, migration 052). */
export const ITEM_EVENT_KINDS = [
  'discovered',
  'ip_changed',
  'offline',
  'online',
  'takeover',
  'ip_reassigned',
  'created',
  'edited',
  'deleted',
  'purged',
] as const;

export type ItemEventKind = (typeof ITEM_EVENT_KINDS)[number];

/**
 * One entry of a device's history (GET /api/items/events, GET
 * /api/items/:id/events), newest first. itemId is null once the device was
 * deleted (deleted / purged events keep its id in details.itemId); mac / ip
 * are the device's at the time of the event. details by kind:
 *  - discovered: vendor, hostname, deviceType;
 *  - ip_changed: oldIp, newIp;
 *  - offline: missedScans;
 *  - takeover / ip_reassigned: oldMac, oldItemId;
 *  - created: deviceType;
 *  - edited: fields (changed field names, never the notes text);
 *  - deleted / purged: itemId, name (+ staleDeviceDays for purged).
 */
export interface SiteItemEvent {
  id: number;
  siteId: number;
  siteName: string;
  itemId: number | null;
  /** Current display name of the device (null once deleted: see details.name). */
  itemName: string | null;
  mac: string | null;
  ip: string | null;
  kind: ItemEventKind;
  details: Record<string, unknown> | null;
  actorUserId: number | null;
  actorUsername: string | null;
  probeId: number | null;
  probeName: string | null;
  createdAt: string;
}

export interface ItemEventsResult {
  events: SiteItemEvent[];
  /** More events matched than `limit`: the oldest were left out. */
  truncated: boolean;
  /** Window actually queried (ISO), after the 30-day cap. */
  from: string;
  to: string;
}

export interface ItemIpHistory {
  id: number;
  mac: string;
  siteId: number;
  tenantId: number;
  ip: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

// ============================================
// IPAM — IP Reservations
// ============================================
export interface IpReservation {
  id: number;
  siteId: number;
  tenantId: number;
  ip: string;
  name: string;
  description: string | null;
  deviceType: DeviceType | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  /** True if a live device is currently using this IP */
  isOccupied?: boolean;
  occupiedByMac?: string | null;
  /** MAC of the device the IP is reserved for (AA:BB:CC:DD:EE:FF) */
  reservedMac?: string | null;
  /** Site item the IP is reserved for */
  itemId?: number | null;
  /** free / held by its owner / conflict (another device) / owner offline */
  state?: IpReservationState;
}

/**
 * State of an IP reservation against the devices on its IP:
 * - free: no online device holds the IP;
 * - held: the owner (reservedMac, or the item itemId) holds it;
 * - conflict: another online device holds it (any online device when no
 *   owner is defined);
 * - owner_offline: the owner is defined but offline, nobody else holds the IP.
 */
export type IpReservationState = 'free' | 'held' | 'conflict' | 'owner_offline';

// ============================================
// IPAM — MAC Vendors
// ============================================
export interface MacVendor {
  prefix: string;       // e.g. "AA:BB:CC"
  vendorName: string;   // from IEEE OUI database
  customName: string | null; // admin-defined override (null = use vendorName)
  /** Effective display name: customName if set, else vendorName */
  effectiveName: string;
  updatedAt: string;
}

// ============================================
// IPAM — Vendor Type Rules
// ============================================
export interface VendorTypeRule {
  id: number;
  groupId: number | null;
  tenantId: number;
  vendorPattern: string;
  deviceType: DeviceType;
  label: string | null;
  priority: number;
  createdAt: string;
}

// ============================================
// IPAM — Probes
// ============================================
export type ProbeStatus = 'pending' | 'approved' | 'refused' | 'suspended';

export interface ProbeApiKey {
  id: number;
  name: string;
  key: string;
  tenantId: number;
  createdBy: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** Number of probes bound to this key (probes.api_key_id) */
  probeCount?: number;
  /** Site assigned at approval to the probes of this key that have none */
  defaultSiteId?: number | null;
  defaultSiteName?: string | null;
}

export interface ProbeScanConfig {
  excludedSubnets: string[];
  extraSubnets: string[];
  portScanEnabled?: boolean;
  portScanPorts?: number[];
  flowAnalysisEnabled?: boolean;
}

export type ProbeRole = 'primary' | 'secondary';

export interface Probe {
  id: number;
  uuid: string;
  hostname: string;
  ip: string | null;
  mac: string | null;
  ips?: string[] | null;
  osInfo: {
    platform: string;
    distro?: string;
    release?: string;
    arch?: string;
  } | null;
  probeVersion: string | null;
  apiKeyId: number | null;
  status: ProbeStatus;
  tenantId: number;
  siteId: number | null;
  name: string | null;
  scanIntervalSeconds: number;
  scanConfig: ProbeScanConfig;
  scanConfigOverride?: boolean;
  isPrimary?: boolean;
  wsConnected?: boolean;
  lastSeenAt: string | null;
  pendingCommand: string | null;
  uninstallCommandedAt: string | null;
  updatingSince: string | null;
  approvedBy: number | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Features advertised by the probe (e.g. "device_checks:1"); null for probes that never advertised any */
  capabilities?: string[] | null;
  /** True when capabilities include DEVICE_CHECKS_CAPABILITY */
  deviceChecksSupported?: boolean;
  /** Scheme of the server URL as configured on the probe (reported by the probe itself) */
  serverScheme?: 'http' | 'https' | null;
  /** True when a per-probe identity token has been issued to this probe */
  hasIdentityToken?: boolean;
  /**
   * True when the server would send device check credentials to this probe
   * (FORCE_HTTPS and an https server URL on the probe, or
   * ALLOW_PLAINTEXT_PROBE_SECRETS and the probe's own plaintext opt-in,
   * DEVICE_CHECKS_PLAINTEXT_SECRETS_CAPABILITY).
   */
  checkSecretsDeliverable?: boolean;
  /**
   * Server verdict on the probe's liveness (the probe-offline job's own
   * threshold): for approved probes, connected over the WebSocket or not
   * reported offline; null for pending / refused / suspended probes.
   */
  online: boolean | null;
  /** When the server reported the probe offline (ISO), null while online */
  offlineSince: string | null;
  /** Name of the API key the probe is bound to */
  apiKeyName?: string | null;
  // ── Reserved for later releases (not filled yet) ──
  lastScanAt?: string | null;
  lastScanDurationMs?: number | null;
  lastScanDeviceCount?: number | null;
  lastScannedSubnets?: string[];
  skippedSubnets?: { cidr: string; reason: string }[];
  lastPushErrorCode?: string | null;
  lastPushErrorAt?: string | null;
  lastUpdateError?: string | null;
  lastUpdateErrorAt?: string | null;
  lastUpdateTarget?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
}

// ============================================
// Network Flows
// ============================================
export interface NetworkFlow {
  id: number;
  siteId: number;
  tenantId: number;
  sourceIp: string;
  sourcePort: number | null;
  destIp: string;
  destPort: number;
  protocol: string;
  sourceProcess: string | null;
  connectionCount: number;
  discoveredByProbeId: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type FlowPeriod = '1h' | '24h' | '30d' | '1y';

export interface FlowEntry {
  sourceIp: string;
  sourcePort?: number;
  destIp: string;
  destPort: number;
  protocol: string;
  process?: string;
}

// ============================================
// Tunnels
// ============================================
export type TunnelStatus = 'opening' | 'active' | 'closed' | 'error';

export interface Tunnel {
  id: string;
  tenantId: number;
  probeId: number;
  siteId: number;
  targetIp: string;
  targetPort: number;
  status: TunnelStatus;
  requestedBy: number | null;
  errorMessage: string | null;
  createdAt: string;
  closedAt: string | null;
}

/** Which tunnels GET /api/tunnel lists: open ones (default) or finished ones. */
export type TunnelListStatus = 'active' | 'closed';

/** A tunnel of the supervision list (GET /api/tunnel), raw values: the client anonymizes. */
export interface TunnelListEntry extends Tunnel {
  lastActivityAt: string | null;
  requestedByUsername: string | null;
  probeName: string | null;
  siteName: string | null;
}

// ============================================
// Audit log
// ============================================
/** Shape of an audit_logs row as returned by the server (details never contain secrets) */
export interface AuditLogEntry {
  id: number;
  tenantId: number | null;
  userId: number | null;
  username: string | null;
  probeId: number | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

// ============================================
// Backwards-compat API types (used by client api/ layer)
// ============================================
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface CreateGroupRequest {
  name: string;
  slug?: string;
  description?: string | null;
  parentId?: number | null;
  isGeneral?: boolean;
  groupNotifications?: boolean;
  kind?: 'monitor' | 'agent' | null;
  [key: string]: unknown;
}

export interface UpdateGroupRequest {
  name?: string;
  slug?: string;
  description?: string | null;
  parentId?: number | null;
  isGeneral?: boolean;
  groupNotifications?: boolean;
  kind?: 'monitor' | 'agent' | null;
  [key: string]: unknown;
}

export interface CreateNotificationChannelRequest {
  name: string;
  type: string;
  config: Record<string, unknown>;
}

export interface UpdateNotificationChannelRequest {
  name?: string;
  config?: Record<string, unknown>;
}

export interface CreateTeamRequest {
  name: string;
  description?: string | null;
  canCreate?: boolean;
}

export interface UpdateTeamRequest {
  name?: string;
  description?: string | null;
  canCreate?: boolean;
}

export interface SetTeamMembersRequest {
  members?: Array<{ userId: number; permission: 'read' | 'write' }>;
  userIds?: number[];
  [key: string]: unknown;
}

export interface SetTeamPermissionsRequest {
  permissions: Array<{ scope: PermissionScope; scopeId: number; level: 'ro' | 'rw' }>;
}

export interface CreateUserRequest {
  username: string;
  displayName?: string | null;
  password?: string;
  role?: UserRole;
  email?: string | null;
  /** Tenants to join as 'member'; default: the admin's current tenant. */
  tenantIds?: number[];
}

export interface UpdateUserRequest {
  username?: string;
  displayName?: string | null;
  password?: string;
  role?: UserRole;
  isActive?: boolean;
  email?: string | null;
}

// Legacy Monitor type (used by pages that haven't been fully migrated)
export interface Monitor {
  id: number;
  name: string;
  type: string;
  status: string;
  groupId: number | null;
  isActive: boolean;
  [key: string]: unknown;
}

// Legacy Heartbeat type
export interface Heartbeat {
  id: number;
  monitorId: number;
  status: string;
  responseTime: number | null;
  createdAt: string;
  value?: string | null;
  [key: string]: unknown;
}

/** Scope of a team permission (the legacy Obliview 'monitor' scope is gone). */
export type PermissionScope = 'group' | 'site';
