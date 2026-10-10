// ── Tenant capabilities ───────────────
// WHAT a member may do inside a tenant. The member's tenant role
// (user_tenants.role) is a permission set slug; the set lists capabilities.
// WHERE (which groups and sites) comes from the team permissions. One table
// for the server (permissionSet.service, rbac.ts gates) and the client
// (PAGE_ACCESS, permission set matrix).

export const TENANT_CAPABILITIES = [
  'monitoring',
  'groups.manage',
  'sites.manage',
  'probes.read',
  'probes.approve',
  'probes.manage',
  'tunnels.use',
  'deviceChecks.manage',
  'notifications.manage',
  'settings',
  'users.manage',
  'audit.read',
] as const;

export type TenantCapability = typeof TENANT_CAPABILITIES[number];

/** Groups of the permission set matrix, in display order. */
export interface CapabilityGroup {
  id: 'sites' | 'probes' | 'alerting' | 'administration';
  /** English label (the client translates it: permissionSets.groups.<id>). */
  label: string;
  keys: readonly TenantCapability[];
}

export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  { id: 'sites', label: 'Sites & devices', keys: ['monitoring', 'groups.manage', 'sites.manage'] },
  { id: 'probes', label: 'Probes & tunnels', keys: ['probes.read', 'probes.approve', 'probes.manage', 'tunnels.use'] },
  { id: 'alerting', label: 'Alerting', keys: ['deviceChecks.manage', 'notifications.manage'] },
  { id: 'administration', label: 'Administration', keys: ['settings', 'users.manage', 'audit.read'] },
];

/**
 * Capabilities a capability grants as well (server-side implication). A set
 * listing 'probes.manage' holds 'probes.approve' and 'probes.read': existing
 * sets keep exactly the rights they had before the split.
 */
export const CAPABILITY_IMPLIES: Readonly<Partial<Record<TenantCapability, readonly TenantCapability[]>>> = {
  'probes.manage': ['probes.approve', 'probes.read'],
  'probes.approve': ['probes.read'],
};

/**
 * 'monitoring' is the baseline: what a member reads is decided by the team
 * permissions, it is never checked on its own (the matrix shows it locked).
 */
export const BASELINE_CAPABILITY: TenantCapability = 'monitoring';

const CAPABILITY_KEYS: ReadonlySet<string> = new Set(TENANT_CAPABILITIES);

export function isTenantCapability(value: unknown): value is TenantCapability {
  return typeof value === 'string' && CAPABILITY_KEYS.has(value);
}

/**
 * The capabilities `list` grants: the known ones plus everything they imply
 * (transitively), deduplicated, in TENANT_CAPABILITIES order.
 */
export function expandCapabilities(list: readonly unknown[]): TenantCapability[] {
  const held = new Set<TenantCapability>();
  const queue: TenantCapability[] = list.filter(isTenantCapability);
  while (queue.length > 0) {
    const cap = queue.pop()!;
    if (held.has(cap)) continue;
    held.add(cap);
    for (const implied of CAPABILITY_IMPLIES[cap] ?? []) {
      if (!held.has(implied)) queue.push(implied);
    }
  }
  return TENANT_CAPABILITIES.filter((c) => held.has(c));
}

/** Capabilities implied by the others of `list` (shown ticked and locked in the matrix). */
export function impliedCapabilities(list: readonly unknown[]): TenantCapability[] {
  const implied = new Set<TenantCapability>();
  for (const cap of list.filter(isTenantCapability)) {
    for (const other of expandCapabilities(CAPABILITY_IMPLIES[cap] ?? [])) implied.add(other);
  }
  return TENANT_CAPABILITIES.filter((c) => implied.has(c));
}

// ── Page access (client routes, sidebar links, hub tabs) ────────────────────

/** Who may open a page: platform admins always; others by tenant capability. */
export interface PageAccess {
  /** A platform function: platform admins only. */
  platformAdmin?: boolean;
  /** Every one of these tenant capabilities. */
  all?: readonly TenantCapability[];
  /** At least one of these tenant capabilities. */
  any?: readonly TenantCapability[];
  /**
   * Allowed when at least one of these nested accesses passes (a hub page
   * gated by the union of its tabs' pages).
   */
  anyOf?: readonly PageAccess[];
  /** Platform admin or admin of the current tenant. */
  fullAccess?: true;
}

/**
 * The tenant capabilities each admin page needs: the ones the server
 * enforces on the routes the page calls (server routes/*.routes.ts).
 */
const PAGE_ACCESS_PAGES = {
  // Probe list / detail ('probes.read'; approving takes 'probes.approve',
  // everything else 'probes.manage', checked per action).
  probes:        { all: ['probes.read'] },
  // Probe API keys.
  probeKeys:     { all: ['probes.manage'] },
  notifications: { all: ['notifications.manage'] },
  // Teams ('users.manage'); the users and permission sets tabs are platform functions.
  users:         { any: ['users.manage'] },
  tenants:       { platformAdmin: true },
  macVendors:    { platformAdmin: true },
  vendorRules:   { all: ['sites.manage', 'deviceChecks.manage'] },
  deviceChecks:  { all: ['deviceChecks.manage'] },
  audit:         { all: ['audit.read'] },
  // Import / export carries settings, groups, sites, channels and teams.
  importExport:  { all: ['settings', 'groups.manage', 'sites.manage', 'notifications.manage', 'users.manage'] },
  // Default settings ('settings') and SMTP servers ('notifications.manage').
  settings:      { any: ['settings', 'notifications.manage'] },
} as const satisfies Record<string, PageAccess>;

/**
 * The pages, plus the hubs, gated by the union of their tabs (never narrower
 * than the pages they embed).
 */
export const PAGE_ACCESS = {
  ...PAGE_ACCESS_PAGES,
  // Policies: device checks, notification channels, tenant default settings.
  policies:      { any: ['deviceChecks.manage', 'notifications.manage', 'settings'] },
  // Discovery: probes + API keys, vendor rules, MAC vendors.
  discovery:     { anyOf: [PAGE_ACCESS_PAGES.probes, PAGE_ACCESS_PAGES.vendorRules, PAGE_ACCESS_PAGES.macVendors] },
  // Security: audit log.
  security:      { any: ['audit.read'] },
  // Supervision: TCP / web tunnels.
  supervision:   { any: ['tunnels.use'] },
} as const satisfies Record<string, PageAccess>;

/** Capabilities combined by one feature (spelled out under the matrix). */
export const COMBINED_CAPABILITY_REQUIREMENTS = {
  vendorRules: PAGE_ACCESS.vendorRules.all,
  importExport: PAGE_ACCESS.importExport.all,
} as const;
