import type { Knex } from 'knex';

/**
 * Probe update lifecycle. Idempotent (guarded)
 * and non-destructive.
 *
 * probes  last_update_error     short reason code of the last aborted update
 *                               ('checksum_mismatch', 'download_failed', …);
 *         last_update_error_at  when the probe reported it;
 *         last_update_target    the version it tried to install.
 * Written by update_aborted (WS) and POST /api/probe/agent/update-aborted
 * (HTTP), cleared when the probe reports another version.
 */

const COLUMNS: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
  ['last_update_error', (t) => { t.string('last_update_error', 64).nullable(); }],
  ['last_update_error_at', (t) => { t.timestamp('last_update_error_at', { useTz: true }).nullable(); }],
  ['last_update_target', (t) => { t.string('last_update_target', 32).nullable(); }],
];

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('probes'))) return;
  for (const [column, add] of COLUMNS) {
    if (!(await knex.schema.hasColumn('probes', column))) {
      await knex.schema.alterTable('probes', (t) => { add(t); });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('probes'))) return;
  for (const [column] of [...COLUMNS].reverse()) {
    if (await knex.schema.hasColumn('probes', column)) {
      await knex.schema.alterTable('probes', (t) => { t.dropColumn(column); });
    }
  }
}
