import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('probes', (table) => {
    table.boolean('scan_config_override').notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('probes', (table) => {
    table.dropColumn('scan_config_override');
  });
}
