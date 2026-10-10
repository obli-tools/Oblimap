import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_teams', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.text('description').nullable();
    t.boolean('can_create').notNullable().defaultTo(false);
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('team_members', (t) => {
    t.integer('team_id').notNullable().references('id').inTable('user_teams').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('permission', 16).notNullable().defaultTo('read');
    t.primary(['team_id', 'user_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('team_members');
  await knex.schema.dropTableIfExists('user_teams');
}
