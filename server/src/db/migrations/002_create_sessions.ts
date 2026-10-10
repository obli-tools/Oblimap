import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('session', (t) => {
    t.string('sid').primary();
    t.jsonb('sess').notNullable();
    t.timestamp('expire').notNullable().index();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('session');
}
