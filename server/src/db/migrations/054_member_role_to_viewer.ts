import type { Knex } from 'knex';

/**
 * The legacy tenant role 'member' becomes 'viewer'.
 *
 * 'member' was written for every non-admin membership before permission sets
 * were assignable, and has always been read as the 'viewer' set
 * (permissionSetSlugForRole). The code now writes 'viewer' (user creation,
 * tenant member add, Obligate SSO); this rewrites the remaining rows so the
 * UI stops showing the "legacy member role" hint. Nobody's access changes:
 * the capabilities are the same set. Reads keep accepting 'member'.
 *
 * Idempotent (a second run finds no 'member' row) and non-destructive. down()
 * is a no-op: which 'viewer' rows were 'member' before is not recorded, and
 * both values grant the same capabilities.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('user_tenants'))) return;
  await knex('user_tenants').where({ role: 'member' }).update({ role: 'viewer' });
}

export async function down(_knex: Knex): Promise<void> {
  // Nothing to undo: 'member' and 'viewer' resolve to the same permission set.
}
