import type { Knex } from 'knex';

/**
 * Device tracking pipeline.
 * Idempotent and non-destructive:
 *  1. site_items.device_type_source varchar(16) NULL — 'manual' | 'rule' |
 *     'ports' | 'probe'. When the column is added, every row whose
 *     device_type is not 'unknown' becomes 'manual': the scan pipeline
 *     never re-classifies a type that existed before this release;
 *  2. site_items.mac_randomized boolean NOT NULL default false — when the
 *     column is added, true for locally administered MACs (bit 0x02 of the
 *     first octet: second hex digit 2, 6, A or E);
 *  3. item_ip_history: duplicate (site_id, mac, ip) rows — possible with the
 *     former SELECT-then-INSERT under concurrent pushes — are merged into
 *     the oldest row (earliest first_seen_at, latest last_seen_at), then a
 *     unique index on (site_id, mac, ip) lets the push upsert the whole
 *     history in one INSERT … ON CONFLICT, and an index on
 *     (site_id, ip, last_seen_at) serves the IP-instability query.
 */

const UNIQUE_INDEX = 'uq_item_ip_history_site_mac_ip';
const LOOKUP_INDEX = 'idx_item_ip_history_site_ip_seen';

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('site_items')) {
    if (!(await knex.schema.hasColumn('site_items', 'device_type_source'))) {
      await knex.schema.alterTable('site_items', (t) => {
        t.string('device_type_source', 16).nullable();
      });
      await knex.raw(`
        UPDATE site_items
           SET device_type_source = 'manual'
         WHERE device_type IS NOT NULL
           AND device_type <> 'unknown'
      `);
    }
    if (!(await knex.schema.hasColumn('site_items', 'mac_randomized'))) {
      await knex.schema.alterTable('site_items', (t) => {
        t.boolean('mac_randomized').notNullable().defaultTo(false);
      });
      await knex.raw(`
        UPDATE site_items
           SET mac_randomized = true
         WHERE mac IS NOT NULL
           AND upper(substring(mac FROM 2 FOR 1)) IN ('2', '6', 'A', 'E')
      `);
    }
  }

  if (!(await knex.schema.hasTable('item_ip_history'))) return;

  await knex.raw(`
    WITH agg AS (
      SELECT MIN(id) AS keep_id,
             MIN(first_seen_at) AS first_seen,
             MAX(last_seen_at) AS last_seen
        FROM item_ip_history
       GROUP BY site_id, mac, ip
      HAVING COUNT(*) > 1
    )
    UPDATE item_ip_history h
       SET first_seen_at = agg.first_seen,
           last_seen_at = agg.last_seen
      FROM agg
     WHERE h.id = agg.keep_id
  `);
  await knex.raw(`
    DELETE FROM item_ip_history h
     USING item_ip_history k
     WHERE h.site_id = k.site_id
       AND h.mac = k.mac
       AND h.ip = k.ip
       AND h.id > k.id
  `);

  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON item_ip_history (site_id, mac, ip)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${LOOKUP_INDEX} ON item_ip_history (site_id, ip, last_seen_at)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS ${LOOKUP_INDEX}`);
  await knex.raw(`DROP INDEX IF EXISTS ${UNIQUE_INDEX}`);
  if (await knex.schema.hasTable('site_items')) {
    if (await knex.schema.hasColumn('site_items', 'mac_randomized')) {
      await knex.schema.alterTable('site_items', (t) => {
        t.dropColumn('mac_randomized');
      });
    }
    if (await knex.schema.hasColumn('site_items', 'device_type_source')) {
      await knex.schema.alterTable('site_items', (t) => {
        t.dropColumn('device_type_source');
      });
    }
  }
}
