import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('probes', (table) => {
    table.boolean('is_primary').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('probes', (table) => {
    table.dropColumn('is_primary');
  });
}
