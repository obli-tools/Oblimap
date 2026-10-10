import type { Knex } from 'knex';

/**
 * Backfill sso_foreign_users from users.foreign_source / foreign_id.
 *
 * Previously, findOrCreateForeignUser stored the link directly on the users row
 * (users.foreign_source, users.foreign_id). This only allowed one linked source
 * per user and caused the "link in a loop" bug when multiple apps tried to link
 * the same account.
 *
 * The sso_foreign_users table (created in migration 012) supports multiple linked
 * sources per user via (foreign_source, foreign_user_id) → local_user_id.
 * This migration copies any existing single-source links into that table so they
 * are found by the updated findOrCreateForeignUser lookup.
 */
export async function up(knex: Knex): Promise<void> {
  // Find all users that have a foreign_source set but no matching row in sso_foreign_users
  const linkedUsers = await knex('users')
    .whereNotNull('foreign_source')
    .whereNotNull('foreign_id')
    .select('id', 'foreign_source', 'foreign_id');

  for (const user of linkedUsers) {
    const alreadyLinked = await knex('sso_foreign_users')
      .where({
        foreign_source: user.foreign_source,
        foreign_user_id: user.foreign_id,
      })
      .first();

    if (!alreadyLinked) {
      await knex('sso_foreign_users').insert({
        foreign_source: user.foreign_source,
        foreign_user_id: user.foreign_id,
        local_user_id: user.id,
      });
    }
  }
}

export async function down(_knex: Knex): Promise<void> {
  // Not reversible — we don't know which rows were inserted by this migration vs manually
}
