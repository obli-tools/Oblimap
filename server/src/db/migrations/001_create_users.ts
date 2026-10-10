import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('username', 64).notNullable().unique();
    t.string('display_name', 128).nullable();
    t.string('password_hash').nullable();
    t.string('role', 16).notNullable().defaultTo('user');
    t.string('email', 255).nullable();
    t.string('preferred_language', 16).notNullable().defaultTo('en');
    t.integer('enrollment_version').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.boolean('totp_enabled').notNullable().defaultTo(false);
    t.string('totp_secret', 64).nullable();
    t.boolean('email_otp_enabled').notNullable().defaultTo(false);
    t.jsonb('preferences').nullable();
    // SSO foreign user fields
    t.string('foreign_source', 64).nullable();
    t.integer('foreign_id').nullable();
    t.text('foreign_source_url').nullable();
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('users');
}
