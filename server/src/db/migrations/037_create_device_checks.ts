import type { Knex } from 'knex';

/**
 * Device Checks v1: rules, write-only credentials, latest state per
 * (rule, item), append-only events, plus the probe capability columns.
 *
 * Idempotent: every table / column / constraint / index is guarded, so a re-run on a
 * database that already has (part of) the schema is a no-op.
 * Requires PostgreSQL 13+ (built-in gen_random_uuid(), already used by migration 033).
 * NULLS NOT DISTINCT needs PostgreSQL 15+ (the project targets 16+): on an older server
 * the credentials uniqueness is enforced by two partial unique indexes instead (same
 * guarantee) and a warning is printed.
 */

/** Same check as migration 034. */
async function pgSupportsNullsNotDistinct(knex: Knex): Promise<boolean> {
  const res = await knex.raw('SHOW server_version_num') as { rows: Array<{ server_version_num: string }> };
  const num = Number(res.rows?.[0]?.server_version_num ?? 0);
  return num >= 150000;
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('device_check_rules'))) {
    await knex.schema.createTable('device_check_rules', (t) => {
      t.increments('id').primary();
      t.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
      t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
      t.string('name', 128).notNullable();
      t.text('description').nullable();
      t.boolean('enabled').notNullable().defaultTo(false);           // created disabled
      t.string('suspended_reason', 255).nullable();                   // accountability gate / policy
      t.integer('group_id').nullable().references('id').inTable('monitor_groups').onDelete('CASCADE');
      t.integer('site_id').nullable().references('id').inTable('sites').onDelete('CASCADE');
      t.string('preset_key', 64).nullable();                          // 'barix.nowPlaying'
      t.integer('preset_version').nullable();                         // 1
      t.jsonb('spec').notNullable();                                  // DeviceCheckSpec, never secrets
      t.integer('revision').notNullable().defaultTo(1);               // bump on spec/scope change
      t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
      t.integer('updated_by').nullable().references('id').inTable('users').onDelete('SET NULL');
      t.timestamps(true, true);
      t.unique(['tenant_id', 'name']);
      t.index(['tenant_id', 'enabled']);
    });
  }
  // A rule is scoped to a group OR a site (or the whole tenant), never both
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'device_check_rules_one_scope'
          AND conrelid = 'device_check_rules'::regclass
      ) THEN
        ALTER TABLE device_check_rules ADD CONSTRAINT device_check_rules_one_scope
          CHECK (group_id IS NULL OR site_id IS NULL);
      END IF;
    END
    $$;
  `);

  if (!(await knex.schema.hasTable('device_check_credentials'))) {
    await knex.schema.createTable('device_check_credentials', (t) => {
      t.increments('id').primary();
      t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
      t.integer('rule_id').notNullable().references('id').inTable('device_check_rules').onDelete('CASCADE');
      t.integer('site_id').nullable().references('id').inTable('sites').onDelete('CASCADE'); // null = rule default
      t.string('kind', 16).notNullable().defaultTo('basic');
      t.string('username_masked', 64).notNullable();                  // "ad***"
      t.text('ciphertext').notNullable();                              // base64 AES-256-GCM of {"u":..,"p":..}
      t.string('iv', 32).notNullable();
      t.string('auth_tag', 32).notNullable();
      t.string('key_id', 32).notNullable();                            // DATA_ENCRYPTION_KEY_ID at write time
      t.integer('secret_version').notNullable().defaultTo(1);          // bump on replace -> config rev changes
      t.integer('updated_by').nullable().references('id').inTable('users').onDelete('SET NULL');
      t.timestamps(true, true);
    });
  }
  // One default (site_id NULL) + one override per site for each rule
  if (await pgSupportsNullsNotDistinct(knex)) {
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS device_check_credentials_rule_site_uq
      ON device_check_credentials (rule_id, site_id) NULLS NOT DISTINCT`);
  } else {
    console.warn('WARNING: migration 037: PostgreSQL < 15 — device_check_credentials uniqueness uses two partial unique indexes instead of NULLS NOT DISTINCT. Upgrade to PostgreSQL 16+.');
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS device_check_credentials_rule_override_uq
      ON device_check_credentials (rule_id, site_id) WHERE site_id IS NOT NULL`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS device_check_credentials_rule_default_uq
      ON device_check_credentials (rule_id) WHERE site_id IS NULL`);
  }

  if (!(await knex.schema.hasTable('device_check_state'))) {
    await knex.schema.createTable('device_check_state', (t) => {        // one row per (rule, item)
      t.increments('id').primary();
      t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
      t.integer('rule_id').notNullable().references('id').inTable('device_check_rules').onDelete('CASCADE');
      t.integer('site_item_id').notNullable().references('id').inTable('site_items').onDelete('CASCADE');
      t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
      t.integer('probe_id').nullable().references('id').inTable('probes').onDelete('SET NULL');
      t.integer('rule_revision').notNullable();
      t.string('status', 16).notNullable().defaultTo('pending');      // pending|ok|fail|error
      t.string('variant_id', 32).nullable();
      t.jsonb('values').notNullable().defaultTo('{}');                 // {field: value}, coerced + truncated
      t.jsonb('values_changed_at').notNullable().defaultTo('{}');      // {field: ISO}
      t.jsonb('assertions').nullable();                                // DeviceCheckAssertionResult[]
      t.jsonb('last_trace').nullable();                                // <= 8 KiB, no body
      t.string('last_error_code', 32).nullable();
      t.string('last_error', 200).nullable();
      t.timestamp('last_checked_at', { useTz: true }).nullable();
      t.integer('consecutive_bad').notNullable().defaultTo(0);
      t.integer('consecutive_ok').notNullable().defaultTo(0);
      t.timestamp('bad_since', { useTz: true }).nullable();
      t.timestamp('ok_since', { useTz: true }).nullable();
      t.string('alert_state', 16).notNullable().defaultTo('ok');       // ok|pending|alerting|suppressed
      t.timestamp('alert_since', { useTz: true }).nullable();
      t.timestamp('last_notified_at', { useTz: true }).nullable();
      t.timestamps(true, true);
      t.unique(['rule_id', 'site_item_id']);
      t.index(['site_id']);
      t.index(['tenant_id', 'alert_state']);
    });
  }

  if (!(await knex.schema.hasTable('device_check_events'))) {
    await knex.schema.createTable('device_check_events', (t) => {      // append-only history
      t.bigIncrements('id').primary();
      t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
      t.integer('rule_id').nullable().references('id').inTable('device_check_rules').onDelete('SET NULL');
      t.integer('site_item_id').nullable().references('id').inTable('site_items').onDelete('CASCADE');
      t.integer('site_id').nullable().references('id').inTable('sites').onDelete('CASCADE');
      t.integer('probe_id').nullable().references('id').inTable('probes').onDelete('SET NULL');
      t.string('kind', 32).notNullable();
      // status_changed | alert_opened | alert_closed | alert_reminder | alert_suppressed |
      // value_changed | notify_failed | result_rejected | rule_suspended
      t.string('from_status', 16).nullable();
      t.string('to_status', 16).nullable();
      t.jsonb('details').nullable();                                    // no secrets, strings <= 200 chars
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['rule_id', 'site_item_id', 'created_at']);
      t.index(['site_id', 'created_at']);
      t.index(['tenant_id', 'created_at']);
    });
  }

  // Probe capabilities (advertised by the probe) + the scheme of its configured server URL
  const hasCapabilities = await knex.schema.hasColumn('probes', 'capabilities');
  const hasServerScheme = await knex.schema.hasColumn('probes', 'server_scheme');
  if (!hasCapabilities || !hasServerScheme) {
    await knex.schema.alterTable('probes', (t) => {
      if (!hasCapabilities) t.jsonb('capabilities').nullable();          // ["device_checks:1"]
      if (!hasServerScheme) t.string('server_scheme', 8).nullable();     // 'https' | 'http' as configured on the probe
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasCapabilities = await knex.schema.hasColumn('probes', 'capabilities');
  const hasServerScheme = await knex.schema.hasColumn('probes', 'server_scheme');
  if (hasCapabilities || hasServerScheme) {
    await knex.schema.alterTable('probes', (t) => {
      if (hasServerScheme) t.dropColumn('server_scheme');
      if (hasCapabilities) t.dropColumn('capabilities');
    });
  }

  await knex.schema.dropTableIfExists('device_check_events');
  await knex.schema.dropTableIfExists('device_check_state');
  await knex.raw('DROP INDEX IF EXISTS device_check_credentials_rule_site_uq');
  await knex.raw('DROP INDEX IF EXISTS device_check_credentials_rule_override_uq');
  await knex.raw('DROP INDEX IF EXISTS device_check_credentials_rule_default_uq');
  await knex.schema.dropTableIfExists('device_check_credentials');
  // device_check_rules_one_scope is dropped with the table
  await knex.schema.dropTableIfExists('device_check_rules');
}
