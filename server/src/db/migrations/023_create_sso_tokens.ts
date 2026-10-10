import type { Knex } from 'knex';

/**
 * Create the sso_tokens table used by POST /api/sso/generate-token
 * and GET /api/sso/validate-token.
 *
 * This table was missing from migration 012 — the token generation and
 * validation routes were already referencing it but it was never created.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('sso_tokens', (t) => {
    t.increments('id').primary();
    t.string('token', 128).notNullable().unique();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.boolean('used').notNullable().defaultTo(false);
    t.timestamp('expires_at').notNullable();
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('sso_tokens');
}
