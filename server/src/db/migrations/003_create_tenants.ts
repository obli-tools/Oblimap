import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tenants', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('slug', 64).notNullable().unique();
    t.text('description').nullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('user_tenants', (t) => {
    t.increments('id').primary();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('role', 16).notNullable().defaultTo('member');
    t.unique(['user_id', 'tenant_id']);
  });

  // Insert default tenant
  await knex('tenants').insert({ id: 1, name: 'Default', slug: 'default' });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_tenants');
  await knex.schema.dropTableIfExists('tenants');
}
