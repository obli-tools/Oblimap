import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('network_flows', (t) => {
    t.increments('id').primary();
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('source_ip', 45).notNullable();
    t.integer('source_port').nullable();
    t.string('dest_ip', 45).notNullable();
    t.integer('dest_port').notNullable();
    t.string('protocol', 8).notNullable().defaultTo('tcp');
    t.string('source_process', 128).nullable();
    t.integer('connection_count').notNullable().defaultTo(1);
    t.integer('discovered_by_probe_id').nullable().references('id').inTable('probes').onDelete('SET NULL');
    t.timestamp('first_seen_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at').notNullable().defaultTo(knex.fn.now());
    t.index(['site_id', 'source_ip', 'dest_ip', 'dest_port', 'protocol'], 'idx_flows_dedup');
    t.index(['site_id', 'last_seen_at'], 'idx_flows_period');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('network_flows');
}
