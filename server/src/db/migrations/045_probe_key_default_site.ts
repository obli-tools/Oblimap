import type { Knex } from 'knex';

/**
 * Default site of a probe API key. Idempotent
 * (guarded) and non-destructive: the column is nullable, existing keys keep
 * today's behaviour (approved probes stay without a site until assigned).
 *
 * probe_api_keys  default_site_id — site given at approval to a probe of
 *                 this key that has none; SET NULL when the site is deleted.
 */

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('probe_api_keys'))) return;
  if (!(await knex.schema.hasTable('sites'))) return;
  if (await knex.schema.hasColumn('probe_api_keys', 'default_site_id')) return;
  await knex.schema.alterTable('probe_api_keys', (t) => {
    t.integer('default_site_id').nullable().references('id').inTable('sites').onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('probe_api_keys'))) return;
  if (await knex.schema.hasColumn('probe_api_keys', 'default_site_id')) {
    await knex.schema.alterTable('probe_api_keys', (t) => { t.dropColumn('default_site_id'); });
  }
}
