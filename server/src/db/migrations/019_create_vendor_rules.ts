import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('vendor_type_rules', (t) => {
    t.increments('id').primary();
    t.integer('group_id').nullable().references('id').inTable('monitor_groups').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('vendor_pattern', 128).notNullable(); // e.g. "Cisco", "Vivotek"
    t.string('device_type', 32).notNullable();
    t.string('label', 128).nullable(); // custom display name override
    t.integer('priority').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('vendor_type_rules');
}
