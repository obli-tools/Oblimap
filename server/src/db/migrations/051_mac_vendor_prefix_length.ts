import type { Knex } from 'knex';

/**
 * IEEE MA-M (28-bit) and MA-S (36-bit) blocks in mac_vendors.
 * Idempotent and non-destructive:
 *  - mac_vendors.prefix widened to varchar(16) when shorter (it was
 *    varchar(8), "AA:BB:CC"): prefixes are upper-case hex with ':'
 *    separators truncated to the nibble length — 'AA:BB:CC' (24 bits),
 *    'AA:BB:CC:D' (28), 'AA:BB:CC:DD:E' (36);
 *  - mac_vendors.prefix_bits smallint NOT NULL default 24: every existing
 *    row is a 24-bit MA-L prefix.
 */

async function prefixLength(knex: Knex): Promise<number | null> {
  const res = await knex.raw(
    `SELECT character_maximum_length AS len
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'mac_vendors'
        AND column_name = 'prefix'`,
  ) as { rows?: Array<{ len: number | string | null }> };
  const len = res.rows?.[0]?.len;
  return len == null ? null : Number(len);
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('mac_vendors'))) return;

  const len = await prefixLength(knex);
  if (len !== null && Number.isFinite(len) && len < 16) {
    await knex.raw('ALTER TABLE mac_vendors ALTER COLUMN prefix TYPE varchar(16)');
  }

  if (!(await knex.schema.hasColumn('mac_vendors', 'prefix_bits'))) {
    await knex.schema.alterTable('mac_vendors', (t) => {
      t.smallint('prefix_bits').notNullable().defaultTo(24);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('mac_vendors'))) return;
  // The longer MA-M / MA-S prefixes do not fit the former varchar(8).
  await knex.raw('DELETE FROM mac_vendors WHERE length(prefix) > 8');
  if (await knex.schema.hasColumn('mac_vendors', 'prefix_bits')) {
    await knex.schema.alterTable('mac_vendors', (t) => { t.dropColumn('prefix_bits'); });
  }
  const len = await prefixLength(knex);
  if (len !== null && len > 8) {
    await knex.raw('ALTER TABLE mac_vendors ALTER COLUMN prefix TYPE varchar(8)');
  }
}
