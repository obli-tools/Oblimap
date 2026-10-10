import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('notification_channels', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('type', 64).notNullable();
    t.jsonb('config').notNullable().defaultTo('{}');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('notification_bindings', (t) => {
    t.increments('id').primary();
    t.integer('channel_id').notNullable().references('id').inTable('notification_channels').onDelete('CASCADE');
    t.string('scope', 16).notNullable(); // 'global' | 'group' | 'site'
    t.integer('scope_id').nullable();
    t.string('override_mode', 16).notNullable().defaultTo('merge');
    t.boolean('on_down').notNullable().defaultTo(true);
    t.boolean('on_up').notNullable().defaultTo(true);
    t.boolean('on_warning').notNullable().defaultTo(true);
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('notification_bindings');
  await knex.schema.dropTableIfExists('notification_channels');
}
