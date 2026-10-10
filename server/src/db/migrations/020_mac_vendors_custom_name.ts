import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('mac_vendors', (t) => {
    t.string('custom_name', 255).nullable().defaultTo(null);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('mac_vendors', (t) => {
    t.dropColumn('custom_name');
  });
}
