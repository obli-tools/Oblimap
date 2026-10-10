import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('monitor_groups', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('slug', 128).notNullable();
    t.text('description').nullable();
    t.integer('parent_id').nullable().references('id').inTable('monitor_groups').onDelete('SET NULL');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamps(true, true);
    t.unique(['slug', 'tenant_id']);
  });

  // Closure table for efficient hierarchy queries
  await knex.schema.createTable('group_closure', (t) => {
    t.integer('ancestor').notNullable().references('id').inTable('monitor_groups').onDelete('CASCADE');
    t.integer('descendant').notNullable().references('id').inTable('monitor_groups').onDelete('CASCADE');
    t.integer('depth').notNullable();
    t.primary(['ancestor', 'descendant']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('group_closure');
  await knex.schema.dropTableIfExists('monitor_groups');
}
