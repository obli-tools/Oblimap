import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('site_items', (table) => {
    // Array of open TCP port numbers, populated by the probe's port scan.
    // Stored as JSONB (e.g. [22, 80, 443]) — null means no scan has been run.
    table.jsonb('open_ports').nullable().defaultTo(null);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('site_items', (table) => {
    table.dropColumn('open_ports');
  });
}
