import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('probes', (table) => {
    table.string('mac', 17).nullable().defaultTo(null).after('ip');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('probes', (table) => {
    table.dropColumn('mac');
  });
}
