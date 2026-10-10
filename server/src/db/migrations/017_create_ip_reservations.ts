import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ip_reservations', (t) => {
    t.increments('id').primary();
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('ip', 45).notNullable();
    t.string('name', 128).notNullable();
    t.text('description').nullable();
    t.string('device_type', 32).nullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['site_id', 'ip']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ip_reservations');
}
