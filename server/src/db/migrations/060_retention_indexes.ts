import type { Knex } from 'knex';

/**
 * Indexes of the hourly retention steps added to the Device Checks sweeper
 * (deviceChecks/sweeper.ts runDeviceCheckRetention):
 *  - tunnels (closed_at) WHERE status IN ('closed','error'): finished tunnels
 *    closed for 30 days;
 *  - password_reset_tokens (expires_at): tokens expired for a day;
 *  - live_alerts (created_at): read / resolved alerts older than 30 days.
 * Idempotent (IF NOT EXISTS, table guards) and non-destructive.
 */

const INDEXES: Array<[table: string, name: string, definition: string]> = [
  ['tunnels', 'idx_tunnels_closed_at', `(closed_at) WHERE status IN ('closed', 'error')`],
  ['password_reset_tokens', 'idx_password_reset_tokens_expires_at', '(expires_at)'],
  ['live_alerts', 'idx_live_alerts_created_at', '(created_at)'],
];

export async function up(knex: Knex): Promise<void> {
  for (const [table, name, definition] of INDEXES) {
    if (!(await knex.schema.hasTable(table))) continue;
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} ${definition}`);
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const [, name] of INDEXES) {
    await knex.raw(`DROP INDEX IF EXISTS ${name}`);
  }
}
