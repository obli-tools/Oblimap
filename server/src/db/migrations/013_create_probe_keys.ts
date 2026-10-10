import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('probe_api_keys', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.uuid('key').notNullable().unique();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('last_used_at').nullable();
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('probe_api_keys');
}
