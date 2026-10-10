import type { Knex } from 'knex';

/**
 * Daily IPAM snapshot per site, modeled on Obliance's
 * fleet_daily_snapshot. Written by dashboardService.snapshotToday() at boot
 * and every hour (idempotent upsert on (site_id, day)); read by the dashboard
 * timeseries and the "vs yesterday" deltas, always filtered on the sites the
 * viewer may read — which is why the snapshot is per site, not per tenant.
 * Rows older than 400 days are purged by the same job.
 *
 * Idempotent (hasTable guard) and non-destructive.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('ipam_daily_snapshot')) return;
  await knex.schema.createTable('ipam_daily_snapshot', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.date('day').notNullable();
    t.integer('hosts_total').notNullable().defaultTo(0);
    t.integer('hosts_online').notNullable().defaultTo(0);
    t.integer('new_hosts').notNullable().defaultTo(0);
    t.integer('ip_conflicts').notNullable().defaultTo(0);
    t.integer('failing_checks').notNullable().defaultTo(0);
    t.integer('subnets').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['site_id', 'day'], { indexName: 'ipam_daily_snapshot_site_day_uq' });
    t.index(['tenant_id', 'day'], 'ipam_daily_snapshot_tenant_day_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ipam_daily_snapshot');
}
