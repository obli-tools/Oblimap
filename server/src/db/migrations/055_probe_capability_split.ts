import type { Knex } from 'knex';

/**
 * Probe capability split.
 *
 * 'probes.manage' used to gate every probe route. Two narrower capabilities
 * now exist: 'probes.read' (probe list, detail, effective config) and
 * 'probes.approve' (approve / refuse / suspend / unsuspend). probes.manage
 * implies both and probes.approve implies probes.read in code (shared
 * CAPABILITY_IMPLIES), so no set needs rewriting to keep its rights.
 *
 * The seeded sets (is_default) get 'probes.approve' appended when missing
 * (it implies probes.read, which is therefore not stored on its own — the
 * permission-set matrix shows it ticked and locked):
 *  - 'admin'    += probes.approve (tenant admins hold every capability in
 *                  code anyway: keeps the matrix truthful);
 *  - 'operator' += probes.approve (sees the probe list, approves probes).
 * 'user' and 'viewer' get nothing: probes.read is tenant-wide (every probe
 * of the tenant, whatever the member's team permissions), and 'viewer' is the
 * default role of every non-admin member (legacy 'member', SSO accounts).
 * Granting it would show them probes of sites they cannot read; tenant admins
 * opt in from the matrix instead.
 * The seeded 'user' set is renamed 'Site manager' only while its name is
 * still the seeded 'User' (its slug, stored in user_tenants and sent by
 * Obligate, is unchanged). Custom sets are untouched.
 *
 * Idempotent and non-destructive.
 */

const ADDITIONS: ReadonlyArray<readonly [slug: string, capabilities: readonly string[]]> = [
  ['admin', ['probes.approve']],
  ['operator', ['probes.approve']],
];

const USER_SET_SEEDED_NAME = 'User';
const USER_SET_NEW_NAME = 'Site manager';

function parseCapabilities(raw: unknown): string[] {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string') : [];
}

async function seededSet(knex: Knex, slug: string): Promise<{ id: number; capabilities: unknown } | undefined> {
  return await knex('permission_sets').where({ slug, is_default: true }).first('id', 'capabilities') as
    { id: number; capabilities: unknown } | undefined;
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('permission_sets'))) return;

  for (const [slug, added] of ADDITIONS) {
    const set = await seededSet(knex, slug);
    if (!set) continue;
    const current = parseCapabilities(set.capabilities);
    const missing = added.filter((c) => !current.includes(c));
    if (missing.length === 0) continue;
    await knex('permission_sets').where({ id: set.id }).update({ capabilities: JSON.stringify([...current, ...missing]) });
  }

  await knex('permission_sets')
    .where({ slug: 'user', is_default: true, name: USER_SET_SEEDED_NAME })
    .update({ name: USER_SET_NEW_NAME });
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('permission_sets'))) return;

  // The capabilities are unknown to the code before this release (ignored
  // there): removing them from the seeded sets restores the previous rows.
  for (const [slug, added] of ADDITIONS) {
    const set = await seededSet(knex, slug);
    if (!set) continue;
    const current = parseCapabilities(set.capabilities);
    const kept = current.filter((c) => !added.includes(c));
    if (kept.length === current.length) continue;
    await knex('permission_sets').where({ id: set.id }).update({ capabilities: JSON.stringify(kept) });
  }

  await knex('permission_sets')
    .where({ slug: 'user', is_default: true, name: USER_SET_NEW_NAME })
    .update({ name: USER_SET_SEEDED_NAME });
}
