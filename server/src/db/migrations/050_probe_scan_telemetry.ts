import type { Knex } from 'knex';

/**
 * Probe scan telemetry and settings inheritance by default.
 * Idempotent (guarded) and non-destructive.
 *
 * probes  last_scan_at, last_scan_duration_ms, last_scan_device_count,
 *         last_scanned_subnets (jsonb), skipped_subnets (jsonb) — the last
 *         scan report (null for probes that never sent one);
 *         last_push_error_code, last_push_error_at — the last push the server
 *         refused after authenticating the probe ('invalid_payload', …).
 *
 * probes.scan_config_override defaults to false: new probes follow the scan
 * settings of their site / group chain. Existing probes are flipped only when
 * nothing was customised on them (isDefaultProbeScanConfig): interval 300 s,
 * no excluded / extra subnet, no port scan, no probe-level settings row.
 * A probe with a custom interval or subnets keeps its own configuration.
 */

const TELEMETRY_COLUMNS: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
  ['last_scan_at', (t) => { t.timestamp('last_scan_at', { useTz: true }).nullable(); }],
  ['last_scan_duration_ms', (t) => { t.integer('last_scan_duration_ms').nullable(); }],
  ['last_scan_device_count', (t) => { t.integer('last_scan_device_count').nullable(); }],
  ['last_scanned_subnets', (t) => { t.jsonb('last_scanned_subnets').nullable(); }],
  ['skipped_subnets', (t) => { t.jsonb('skipped_subnets').nullable(); }],
  ['last_push_error_code', (t) => { t.string('last_push_error_code', 64).nullable(); }],
  ['last_push_error_at', (t) => { t.timestamp('last_push_error_at', { useTz: true }).nullable(); }],
];

/** The probe default interval written by registration before this migration. */
export const LEGACY_DEFAULT_SCAN_INTERVAL_SECONDS = 300;

function parseScanConfig(raw: unknown): Record<string, unknown> | null {
  let v = raw;
  if (typeof v === 'string') {
    if (v.trim() === '') return {};
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function isEmptyList(v: unknown): boolean {
  if (v == null) return true;
  return Array.isArray(v) && v.length === 0;
}

/**
 * True when a probe that overrides the settings chain carries nothing an
 * admin customised: the legacy default interval, no excluded / extra subnet,
 * no port scan, and no probe-level ('monitor' scope) settings row. Such a
 * probe is switched to inherit; anything else keeps its own config. An
 * unreadable scan_config counts as customised (kept). Pure (unit-tested).
 */
export function isDefaultProbeScanConfig(row: {
  scan_interval_seconds: unknown;
  scan_config: unknown;
  has_probe_settings: boolean;
}): boolean {
  if (row.has_probe_settings) return false;
  if (Number(row.scan_interval_seconds) !== LEGACY_DEFAULT_SCAN_INTERVAL_SECONDS) return false;
  const config = parseScanConfig(row.scan_config);
  if (config === null) return false;
  if (!isEmptyList(config.excludedSubnets) || !isEmptyList(config.extraSubnets)) return false;
  if (config.portScanEnabled === true) return false;
  return true;
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('probes'))) return;

  for (const [column, add] of TELEMETRY_COLUMNS) {
    if (!(await knex.schema.hasColumn('probes', column))) {
      await knex.schema.alterTable('probes', (t) => { add(t); });
    }
  }

  if (!(await knex.schema.hasColumn('probes', 'scan_config_override'))) return;
  await knex.raw('ALTER TABLE probes ALTER COLUMN scan_config_override SET DEFAULT false');

  // Conservative flip of the probes left on their registration defaults.
  const hasSettings = await knex.schema.hasTable('settings');
  const candidates = await knex('probes')
    .where({ scan_config_override: true, scan_interval_seconds: LEGACY_DEFAULT_SCAN_INTERVAL_SECONDS })
    .select('id', 'scan_interval_seconds', 'scan_config') as Array<{ id: number; scan_interval_seconds: unknown; scan_config: unknown }>;
  if (candidates.length === 0) return;

  const withSettings = new Set<number>();
  if (hasSettings) {
    const rows = await knex('settings')
      .where({ scope: 'monitor' })
      .whereIn('scope_id', candidates.map((c) => c.id))
      .distinct('scope_id') as Array<{ scope_id: number }>;
    for (const r of rows) withSettings.add(Number(r.scope_id));
  }

  const flip = candidates
    .filter((c) => isDefaultProbeScanConfig({ ...c, has_probe_settings: withSettings.has(Number(c.id)) }))
    .map((c) => c.id);
  for (let i = 0; i < flip.length; i += 500) {
    await knex('probes')
      .whereIn('id', flip.slice(i, i + 500))
      // Re-checked: nothing changed between the read and the write.
      .where({ scan_config_override: true, scan_interval_seconds: LEGACY_DEFAULT_SCAN_INTERVAL_SECONDS })
      .update({ scan_config_override: false });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('probes'))) return;
  // The flipped rows are not restored (they inherit the same values unless
  // the chain was customised); only the column default goes back.
  if (await knex.schema.hasColumn('probes', 'scan_config_override')) {
    await knex.raw('ALTER TABLE probes ALTER COLUMN scan_config_override SET DEFAULT true');
  }
  for (const [column] of [...TELEMETRY_COLUMNS].reverse()) {
    if (await knex.schema.hasColumn('probes', column)) {
      await knex.schema.alterTable('probes', (t) => { t.dropColumn(column); });
    }
  }
}
