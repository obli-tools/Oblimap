import type { Knex } from 'knex';

/**
 * IP reservation owner. Idempotent (every step guarded) and
 * non-destructive: both columns are nullable, existing reservations keep
 * today's behaviour (any device on the IP is a conflict).
 *
 * ip_reservations  reserved_mac — MAC of the device the IP is reserved for
 *                  (normalised AA:BB:CC:DD:EE:FF); that device holding the IP
 *                  is not a conflict.
 *                  item_id — the site item the IP is reserved for (the device
 *                  row the reservation was made from); SET NULL when the item
 *                  is deleted.
 */

async function addColumnIfMissing(
  knex: Knex,
  table: string,
  column: string,
  build: (t: Knex.AlterTableBuilder) => void,
): Promise<boolean> {
  if (!(await knex.schema.hasTable(table))) return false;
  if (await knex.schema.hasColumn(table, column)) return false;
  await knex.schema.alterTable(table, build);
  return true;
}

export async function up(knex: Knex): Promise<void> {
  await addColumnIfMissing(knex, 'ip_reservations', 'reserved_mac', (t) => {
    t.string('reserved_mac', 17).nullable();
  });
  if (await knex.schema.hasTable('site_items')) {
    await addColumnIfMissing(knex, 'ip_reservations', 'item_id', (t) => {
      t.integer('item_id').nullable().references('id').inTable('site_items').onDelete('SET NULL');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('ip_reservations'))) return;
  if (await knex.schema.hasColumn('ip_reservations', 'item_id')) {
    await knex.schema.alterTable('ip_reservations', (t) => { t.dropColumn('item_id'); });
  }
  if (await knex.schema.hasColumn('ip_reservations', 'reserved_mac')) {
    await knex.schema.alterTable('ip_reservations', (t) => { t.dropColumn('reserved_mac'); });
  }
}
