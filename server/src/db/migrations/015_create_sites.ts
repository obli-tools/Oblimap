import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('sites', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.text('description').nullable();
    t.integer('group_id').nullable().references('id').inTable('monitor_groups').onDelete('SET NULL');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamps(true, true);
  });

  // Now add the FK from probes → sites
  await knex.schema.alterTable('probes', (t) => {
    t.foreign('site_id').references('id').inTable('sites').onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('probes', (t) => {
    t.dropForeign(['site_id']);
  });
  await knex.schema.dropTableIfExists('sites');
}
