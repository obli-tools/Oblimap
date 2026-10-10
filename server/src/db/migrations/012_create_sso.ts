import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('sso_foreign_users', (t) => {
    t.increments('id').primary();
    t.string('foreign_source', 64).notNullable();
    t.integer('foreign_user_id').notNullable();
    t.integer('local_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.timestamps(true, true);
    t.unique(['foreign_source', 'foreign_user_id']);
  });

  await knex.schema.createTable('sso_link_tokens', (t) => {
    t.increments('id').primary();
    t.string('link_token', 128).notNullable().unique();
    t.string('foreign_source', 64).nullable();
    t.integer('foreign_id').nullable();
    t.text('foreign_source_url').nullable();
    t.string('foreign_username', 64).nullable();
    t.string('foreign_display_name', 128).nullable();
    t.string('foreign_role', 16).nullable();
    t.string('foreign_email', 255).nullable();
    t.string('conflicting_username', 64).nullable();
    t.timestamp('expires_at').notNullable();
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('sso_link_tokens');
  await knex.schema.dropTableIfExists('sso_foreign_users');
}
