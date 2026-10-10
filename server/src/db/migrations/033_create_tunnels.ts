import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tunnels', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.integer('probe_id').notNullable().references('id').inTable('probes').onDelete('CASCADE');
    table.integer('site_id').notNullable();
    table.string('target_ip', 45).notNullable();
    table.integer('target_port').notNullable();
    table.string('status', 16).notNullable().defaultTo('opening');
    table.integer('requested_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.text('error_message').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('closed_at', { useTz: true }).nullable();

    table.index(['probe_id', 'status'], 'idx_tunnels_probe');
    table.index(['tenant_id', 'status'], 'idx_tunnels_tenant');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tunnels');
}
