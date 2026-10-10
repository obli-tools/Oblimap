import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('site_items', (t) => {
    t.increments('id').primary();
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('ip', 45).notNullable();
    t.string('mac', 17).nullable();       // "AA:BB:CC:DD:EE:FF"
    t.string('hostname', 255).nullable(); // from DNS/ARP, not user-editable
    t.string('custom_name', 255).nullable(); // user-set display name
    t.string('device_type', 32).notNullable().defaultTo('unknown');
    t.string('vendor', 128).nullable();
    t.text('notes').nullable();
    t.string('status', 16).notNullable().defaultTo('unknown'); // online|offline|reserved|unknown
    t.boolean('is_manual').notNullable().defaultTo(false);
    t.integer('discovered_by_probe_id').nullable().references('id').inTable('probes').onDelete('SET NULL');
    t.timestamp('first_seen_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at').notNullable().defaultTo(knex.fn.now());
    t.timestamps(true, true);
    t.index(['site_id', 'ip']);
    t.index(['site_id', 'mac']);
    t.index(['mac']); // MAC-based lookup across site
  });

  // Track IP history per MAC
  await knex.schema.createTable('item_ip_history', (t) => {
    t.increments('id').primary();
    t.string('mac', 17).notNullable();
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('ip', 45).notNullable();
    t.timestamp('first_seen_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at').notNullable().defaultTo(knex.fn.now());
    t.index(['mac', 'site_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('item_ip_history');
  await knex.schema.dropTableIfExists('site_items');
}
