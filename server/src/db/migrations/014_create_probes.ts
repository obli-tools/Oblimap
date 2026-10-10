import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('probes', (t) => {
    t.increments('id').primary();
    t.uuid('uuid').notNullable().unique();
    t.string('hostname', 255).notNullable();
    t.string('ip', 45).nullable();
    t.jsonb('os_info').nullable();
    t.string('probe_version', 32).nullable();
    t.integer('api_key_id').nullable().references('id').inTable('probe_api_keys').onDelete('SET NULL');
    t.string('status', 16).notNullable().defaultTo('pending'); // pending|approved|refused|suspended
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('site_id').nullable(); // FK added in migration 016 after sites table exists
    t.string('name', 128).nullable();
    t.integer('scan_interval_seconds').notNullable().defaultTo(300);
    t.jsonb('scan_config').notNullable().defaultTo(JSON.stringify({ excludedSubnets: [], extraSubnets: [] }));
    t.timestamp('last_seen_at').nullable();
    t.string('pending_command', 64).nullable();
    t.timestamp('uninstall_commanded_at').nullable();
    t.timestamp('updating_since').nullable();
    t.integer('approved_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('approved_at').nullable();
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('probes');
}
