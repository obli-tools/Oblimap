import type { Knex } from 'knex';

/**
 * Device event history, per-device alert mode and structured live alerts
 * Idempotent and
 * non-destructive:
 *  1. site_item_events — append-only history of the devices: discovered,
 *     ip_changed, offline, online, takeover, ip_reassigned (scan pipeline),
 *     created, edited, deleted (manual changes, with the acting user), purged
 *     (stale device purge). site_id cascades with the site; item_id is set
 *     NULL when the device is deleted (its mac / ip stay on the row).
 *     Indexed on (site_id, created_at) and (item_id, created_at); kept 180
 *     days (hourly retention, deviceChecks/sweeper.ts);
 *  2. site_items.alert_mode varchar(8) NOT NULL default 'inherit' —
 *     'inherit' | 'always' | 'never' (offline / back-online alerts of the
 *     device, with the alertOnlyWatchedDevices setting);
 *  3. live_alerts.kind varchar(64) NULL and live_alerts.params jsonb NULL —
 *     the machine-readable kind of an alert and its parameters (clients
 *     render a translated, anonymized text; title / message stay English).
 */

const SITE_INDEX = 'idx_site_item_events_site_created';
const ITEM_INDEX = 'idx_site_item_events_item_created';
const TENANT_INDEX = 'idx_site_item_events_tenant_created';
const PROBE_INDEX = 'idx_site_item_events_probe';
const ACTOR_INDEX = 'idx_site_item_events_actor';

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('site_item_events'))) {
    await knex.schema.createTable('site_item_events', (t) => {
      t.bigIncrements('id').primary();
      t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
      t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
      t.integer('item_id').nullable().references('id').inTable('site_items').onDelete('SET NULL');
      t.string('mac', 17).nullable();
      t.string('ip', 45).nullable();
      t.string('kind', 32).notNullable();
      t.jsonb('details').nullable();
      t.integer('actor_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
      t.integer('probe_id').nullable().references('id').inTable('probes').onDelete('SET NULL');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${SITE_INDEX} ON site_item_events (site_id, created_at)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${ITEM_INDEX} ON site_item_events (item_id, created_at)`);
  // Tenant-wide history (GET /api/items/events without a site) and retention.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${TENANT_INDEX} ON site_item_events (tenant_id, created_at)`);
  // ON DELETE SET NULL of a probe / user: without these, deleting one scans
  // the whole history.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${PROBE_INDEX} ON site_item_events (probe_id) WHERE probe_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${ACTOR_INDEX} ON site_item_events (actor_user_id) WHERE actor_user_id IS NOT NULL`);

  if ((await knex.schema.hasTable('site_items')) && !(await knex.schema.hasColumn('site_items', 'alert_mode'))) {
    await knex.schema.alterTable('site_items', (t) => {
      t.string('alert_mode', 8).notNullable().defaultTo('inherit');
    });
  }

  if (await knex.schema.hasTable('live_alerts')) {
    if (!(await knex.schema.hasColumn('live_alerts', 'kind'))) {
      await knex.schema.alterTable('live_alerts', (t) => {
        t.string('kind', 64).nullable();
      });
    }
    if (!(await knex.schema.hasColumn('live_alerts', 'params'))) {
      await knex.schema.alterTable('live_alerts', (t) => {
        t.jsonb('params').nullable();
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('live_alerts')) {
    if (await knex.schema.hasColumn('live_alerts', 'params')) {
      await knex.schema.alterTable('live_alerts', (t) => {
        t.dropColumn('params');
      });
    }
    if (await knex.schema.hasColumn('live_alerts', 'kind')) {
      await knex.schema.alterTable('live_alerts', (t) => {
        t.dropColumn('kind');
      });
    }
  }
  if ((await knex.schema.hasTable('site_items')) && (await knex.schema.hasColumn('site_items', 'alert_mode'))) {
    await knex.schema.alterTable('site_items', (t) => {
      t.dropColumn('alert_mode');
    });
  }
  await knex.raw(`DROP INDEX IF EXISTS ${PROBE_INDEX}`);
  await knex.raw(`DROP INDEX IF EXISTS ${ACTOR_INDEX}`);
  await knex.schema.dropTableIfExists('site_item_events');
}
