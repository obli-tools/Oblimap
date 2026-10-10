import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('mac_vendors', (t) => {
    t.string('prefix', 8).primary(); // "AA:BB:CC" (first 3 octets uppercase)
    t.string('vendor_name', 255).notNullable();
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('mac_vendors');
}
