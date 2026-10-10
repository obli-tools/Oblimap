import type { Knex } from 'knex';

/**
 * Tenant capabilities. The tenant role (user_tenants.role) is
 * now a permission set slug: WHAT a user may do in the tenant comes from that
 * set's capabilities (permissionService.userHasTenantCapability), WHERE from
 * the team permissions, as before.
 *
 * 1. The seeded 'admin' set gets the new capabilities (tunnels.use,
 *    deviceChecks.manage, notifications.manage, audit.read, and any original
 *    one it lost). Tenant admins hold every capability in code anyway; this
 *    keeps the permission set matrix truthful.
 * 2. Set 'operator' (monitoring, sites.manage, groups.manage, tunnels.use) is
 *    created when no set has that slug; an existing one is left alone. The
 *    'viewer' set, which the legacy role 'member' is read as, is re-created
 *    only if it went missing.
 * 3. user_tenants.role is widened to varchar(64): permission set slugs are up
 *    to 64 characters, the column was 16.
 *
 * user_tenants VALUES are not changed: 'admin' stays a tenant admin (every
 * capability, full access in the tenant — as before), and the legacy
 * 'member' is read as the 'viewer' set in code. Nobody loses access: every
 * route that becomes capability-gated was platform-admin only before, and
 * platform admins (users.role = 'admin') hold every capability. Team
 * permissions and group creation through a can_create team are unchanged.
 *
 * Idempotent and non-destructive.
 */

const ADMIN_CAPABILITIES = [
  'monitoring',
  'groups.manage',
  'sites.manage',
  'probes.manage',
  'tunnels.use',
  'deviceChecks.manage',
  'notifications.manage',
  'settings',
  'users.manage',
  'audit.read',
];

/** Capabilities 029_permission_sets did not seed on 'admin' (removed again by down()). */
const ADDED_TO_ADMIN = ['tunnels.use', 'deviceChecks.manage', 'notifications.manage', 'audit.read'];

const OPERATOR_CAPABILITIES = ['monitoring', 'sites.manage', 'groups.manage', 'tunnels.use'];
const VIEWER_CAPABILITIES = ['monitoring'];

function parseCapabilities(raw: unknown): string[] {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string') : [];
}

async function insertSetIfMissing(knex: Knex, name: string, slug: string, capabilities: string[]): Promise<void> {
  if (await knex('permission_sets').where({ slug }).first('id')) return;
  await knex('permission_sets')
    .insert({ name, slug, capabilities: JSON.stringify(capabilities), is_default: true })
    .onConflict('slug')
    .ignore();
}

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('permission_sets')) {
    // ── 1. 'admin' set: every capability ─────────────────────────────────────
    const admin = await knex('permission_sets').where({ slug: 'admin' }).first('id', 'capabilities') as
      { id: number; capabilities: unknown } | undefined;
    if (admin) {
      const current = parseCapabilities(admin.capabilities);
      const merged = [...current, ...ADMIN_CAPABILITIES.filter((c) => !current.includes(c))];
      if (merged.length !== current.length) {
        await knex('permission_sets').where({ id: admin.id }).update({ capabilities: JSON.stringify(merged) });
      }
    } else {
      await insertSetIfMissing(knex, 'Admin', 'admin', ADMIN_CAPABILITIES);
    }

    // ── 2. 'operator' set; 'viewer' back if it went missing ─────────────────
    await insertSetIfMissing(knex, 'Operator', 'operator', OPERATOR_CAPABILITIES);
    await insertSetIfMissing(knex, 'Viewer', 'viewer', VIEWER_CAPABILITIES);
  }

  // ── 3. user_tenants.role: room for any permission set slug ─────────────────
  if ((await knex.schema.hasTable('user_tenants')) && (await knex.schema.hasColumn('user_tenants', 'role'))) {
    const result = await knex.raw(`
      SELECT data_type, character_maximum_length AS len
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'user_tenants'
         AND column_name = 'role'
    `) as { rows?: Array<{ data_type: string; len: number | string | null }> };
    const column = result.rows?.[0];
    if (column && column.data_type === 'character varying' && column.len !== null && Number(column.len) < 64) {
      await knex.raw('ALTER TABLE user_tenants ALTER COLUMN role TYPE varchar(64)');
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('permission_sets'))) return;

  const admin = await knex('permission_sets').where({ slug: 'admin' }).first('id', 'capabilities') as
    { id: number; capabilities: unknown } | undefined;
  if (admin) {
    const kept = parseCapabilities(admin.capabilities).filter((c) => !ADDED_TO_ADMIN.includes(c));
    await knex('permission_sets').where({ id: admin.id }).update({ capabilities: JSON.stringify(kept) });
  }

  // The seeded 'operator' set (is_default), unless a membership still uses it.
  // user_tenants.role keeps its width: narrowing could fail on longer slugs.
  const inUse = await knex('user_tenants').where({ role: 'operator' }).first('user_id');
  if (!inUse) {
    await knex('permission_sets').where({ slug: 'operator', is_default: true }).del();
  }
}
