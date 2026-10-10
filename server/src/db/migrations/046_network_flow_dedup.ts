import type { Knex } from 'knex';

/**
 * network_flows dedup key becomes unique, so flow ingestion can
 * upsert a whole push with batched INSERT … ON CONFLICT statements.
 * Idempotent and non-destructive for the data that matters:
 *  1. duplicate rows of (site_id, source_ip, dest_ip, dest_port, protocol) —
 *     possible with the former SELECT-then-INSERT under concurrent pushes —
 *     are merged into the oldest row (connection_count summed, earliest
 *     first_seen_at, latest last_seen_at), the extras deleted;
 *  2. CREATE UNIQUE INDEX IF NOT EXISTS on those columns;
 *  3. the former non-unique idx_flows_dedup (same columns) is dropped: the
 *     unique index serves the same lookups.
 * Also for the hourly retention (sweeper.ts) and the channel delivery log:
 *  4. plain indexes on network_flows(last_seen_at), item_ip_history(last_seen_at)
 *     and notification_log(created_at), so the retention deletes do not scan;
 *  5. notification_log.tenant_id (nullable): the tenant whose event was
 *     delivered, so a tenant a channel is shared with only reads its own
 *     deliveries. Rows written before stay NULL (visible to the owner only).
 */

const UNIQUE_INDEX = 'uq_network_flows_dedup';

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('notification_log')) {
    if (!(await knex.schema.hasColumn('notification_log', 'tenant_id'))) {
      await knex.schema.alterTable('notification_log', (t) => {
        t.integer('tenant_id').nullable();
      });
    }
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_notification_log_created_at ON notification_log (created_at)');
  }
  if (await knex.schema.hasTable('item_ip_history')) {
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_item_ip_history_last_seen ON item_ip_history (last_seen_at)');
  }

  if (!(await knex.schema.hasTable('network_flows'))) return;
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_network_flows_last_seen ON network_flows (last_seen_at)');

  await knex.raw(`
    WITH agg AS (
      SELECT MIN(id) AS keep_id,
             LEAST(SUM(connection_count), 2147483647)::int AS total,
             MIN(first_seen_at) AS first_seen,
             MAX(last_seen_at) AS last_seen
        FROM network_flows
       GROUP BY site_id, source_ip, dest_ip, dest_port, protocol
      HAVING COUNT(*) > 1
    )
    UPDATE network_flows f
       SET connection_count = agg.total,
           first_seen_at = agg.first_seen,
           last_seen_at = agg.last_seen
      FROM agg
     WHERE f.id = agg.keep_id
  `);
  await knex.raw(`
    DELETE FROM network_flows f
     USING network_flows k
     WHERE f.site_id = k.site_id
       AND f.source_ip = k.source_ip
       AND f.dest_ip = k.dest_ip
       AND f.dest_port = k.dest_port
       AND f.protocol = k.protocol
       AND f.id > k.id
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX}
      ON network_flows (site_id, source_ip, dest_ip, dest_port, protocol)
  `);
  await knex.raw('DROP INDEX IF EXISTS idx_flows_dedup');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_notification_log_created_at');
  await knex.raw('DROP INDEX IF EXISTS idx_item_ip_history_last_seen');
  await knex.raw('DROP INDEX IF EXISTS idx_network_flows_last_seen');
  if (await knex.schema.hasTable('notification_log') && await knex.schema.hasColumn('notification_log', 'tenant_id')) {
    await knex.schema.alterTable('notification_log', (t) => {
      t.dropColumn('tenant_id');
    });
  }
  if (!(await knex.schema.hasTable('network_flows'))) return;
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_flows_dedup
      ON network_flows (site_id, source_ip, dest_ip, dest_port, protocol)
  `);
  await knex.raw(`DROP INDEX IF EXISTS ${UNIQUE_INDEX}`);
}
