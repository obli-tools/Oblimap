import type { Knex } from 'knex';

/**
 * Alert pipeline (offline debounce, probe-offline job, live-alert resolution).
 * Idempotent (every step guarded) and non-destructive.
 *
 * site_items   missed_scans — consecutive scans of the device's probe that
 *              did not see it; the device goes offline only once it reaches
 *              the site's maxMissedPushes (probe.service processDevices).
 * live_alerts  resolved_at — the problem is over (device / probe back
 *              online); resolved alerts are hidden from the lists by default.
 *              site_id — the site the alert is about (only the members who
 *              may read that site receive it); the alert goes with the site.
 *              Existing alerts pointing at a site of their tenant
 *              (navigate_to '/sites/<id>…') get that site.
 * probes       offline_alerted_at — set when the probe-offline job declared
 *              the probe offline, cleared when it is seen again. Approved
 *              probes silent for over a day at upgrade get it at once (no
 *              burst of stale "Probe offline" alerts).
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
  // ── site_items: offline debounce ──────────────────────────────────────────
  await addColumnIfMissing(knex, 'site_items', 'missed_scans', (t) => {
    t.integer('missed_scans').notNullable().defaultTo(0);
  });

  // ── live_alerts: resolution + site ────────────────────────────────────────
  if (await knex.schema.hasTable('live_alerts')) {
    await addColumnIfMissing(knex, 'live_alerts', 'resolved_at', (t) => {
      t.timestamp('resolved_at', { useTz: true }).nullable();
    });
    if (await knex.schema.hasTable('sites')) {
      const added = await addColumnIfMissing(knex, 'live_alerts', 'site_id', (t) => {
        t.integer('site_id').nullable().references('id').inTable('sites').onDelete('CASCADE');
      });
      if (added && await knex.schema.hasColumn('live_alerts', 'navigate_to')) {
        // substring() yields at most 9 digits (fits an int) or NULL: no cast
        // error. (No question mark in this SQL: knex would read it as a binding.)
        await knex.raw(`
          UPDATE live_alerts la
             SET site_id = s.id
            FROM sites s
           WHERE la.site_id IS NULL
             AND s.id = (substring(la.navigate_to from '^/sites/([0-9]{1,9})([^0-9]|$)'))::int
             AND s.tenant_id = la.tenant_id
        `);
      }
    }
    await knex.raw('CREATE INDEX IF NOT EXISTS live_alerts_tenant_resolved_idx ON live_alerts (tenant_id, resolved_at)');
  }

  // ── probes: probe-offline job ─────────────────────────────────────────────
  const probeColumnAdded = await addColumnIfMissing(knex, 'probes', 'offline_alerted_at', (t) => {
    t.timestamp('offline_alerted_at', { useTz: true }).nullable();
  });
  // Approved probes already silent for over a day (decommissioned but never
  // deleted) count as already reported: without this, the first run of the
  // job would raise one "Probe offline" alert + notification for each of them.
  // One that comes back is handled as usual (alert resolved, back online).
  if (probeColumnAdded
    && await knex.schema.hasColumn('probes', 'status')
    && await knex.schema.hasColumn('probes', 'last_seen_at')) {
    await knex.raw(`
      UPDATE probes
         SET offline_alerted_at = now()
       WHERE status = 'approved'
         AND last_seen_at < now() - interval '1 day'
         AND offline_alerted_at IS NULL
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS live_alerts_tenant_resolved_idx');

  const drops: Array<[string, string]> = [
    ['probes', 'offline_alerted_at'],
    ['live_alerts', 'site_id'],
    ['live_alerts', 'resolved_at'],
    ['site_items', 'missed_scans'],
  ];
  for (const [table, column] of drops) {
    if (await knex.schema.hasTable(table) && await knex.schema.hasColumn(table, column)) {
      await knex.schema.alterTable(table, (t) => { t.dropColumn(column); });
    }
  }
}
