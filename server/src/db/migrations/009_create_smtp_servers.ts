import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('smtp_servers', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('host', 255).notNullable();
    t.integer('port').notNullable().defaultTo(587);
    t.boolean('secure').notNullable().defaultTo(false);
    t.string('username', 255).nullable();
    t.string('password_encrypted', 512).nullable();
    t.string('from_address', 255).nullable();
    t.boolean('is_default').notNullable().defaultTo(false);
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('smtp_servers');
}
