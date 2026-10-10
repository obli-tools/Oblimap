import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('live_alerts', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('severity', 16).notNullable(); // 'down' | 'up' | 'warning' | 'info'
    t.string('title', 255).notNullable();
    t.text('message').notNullable();
    t.string('navigate_to', 512).nullable();
    t.string('stable_key', 255).nullable();
    t.boolean('read').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['tenant_id', 'read']);
    t.index(['stable_key']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('live_alerts');
}
