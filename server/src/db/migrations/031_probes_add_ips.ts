import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('probes', (table) => {
    table.jsonb('ips').nullable().defaultTo(null);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('probes', (table) => {
    table.dropColumn('ips');
  });
}
