import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('settings', (t) => {
    t.increments('id').primary();
    t.string('scope', 16).notNullable(); // 'global' | 'group' | 'site'
    t.integer('scope_id').nullable();    // null for global
    t.string('key', 64).notNullable();
    t.text('value').notNullable();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamps(true, true);
    t.unique(['scope', 'scope_id', 'key', 'tenant_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('settings');
}
