import type { Knex } from 'knex';

/**
 * Schema reconcile — brings the tables in line with what the code uses.
 * Idempotent: every step is guarded (hasTable / hasColumn / IF NOT EXISTS /
 * pg_constraint lookup), so it is safe on databases that drifted from the
 * migration history (columns or tables created by hand).
 *
 * 1. live_alerts.read_at — the service reads/writes read_at but migration 011
 *    created a `read` boolean. Added, and backfilled from `read` when present.
 * 2. notification_log — written by notificationService.logNotification but
 *    never created.
 * 3. notification_bindings — make sure tenant_id exists, remove duplicate
 *    bindings, then a unique index (tenant_id, channel_id, scope, scope_id)
 *    that treats a NULL scope_id (global) as equal, to back the upsert.
 * 4. settings — the unique constraint (scope, scope_id, key, tenant_id) never
 *    conflicts on global rows (scope_id NULL: NULLs are distinct), so every
 *    save of a global setting added a duplicate row. Keep the newest row per
 *    key, then replace the constraint with a NULLS NOT DISTINCT unique index
 *    on the same columns (the existing onConflict target keeps matching).
 * 5. uuid columns on monitor_groups, sites, notification_channels and
 *    user_teams — selected by import/export, never created.
 *
 * NULLS NOT DISTINCT needs PostgreSQL 15+ (the project targets 16+). On an
 * older server the unique indexes are created without it (the upserts keep
 * working, global rows are just not deduplicated) and a warning is printed.
 */

async function pgSupportsNullsNotDistinct(knex: Knex): Promise<boolean> {
  const res = await knex.raw('SHOW server_version_num') as { rows: Array<{ server_version_num: string }> };
  const num = Number(res.rows?.[0]?.server_version_num ?? 0);
  return num >= 150000;
}

/** Names of the unique constraints of `table` whose columns are exactly `columns`. */
async function uniqueConstraintsOn(knex: Knex, table: string, columns: string[]): Promise<string[]> {
  const res = await knex.raw(
    `SELECT con.conname AS name
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE con.contype = 'u'
        AND rel.relname = ?
        AND nsp.nspname = current_schema()
        AND cardinality(con.conkey) = ?
        AND (SELECT array_agg(att.attname::text)
               FROM pg_attribute att
              WHERE att.attrelid = con.conrelid
                AND att.attnum = ANY (con.conkey)) @> ?::text[]`,
    [table, columns.length, columns],
  ) as { rows: Array<{ name: string }> };
  return (res.rows ?? []).map((r) => r.name);
}

export async function up(knex: Knex): Promise<void> {
  const nullsNotDistinct = await pgSupportsNullsNotDistinct(knex);
  const nnd = nullsNotDistinct ? ' NULLS NOT DISTINCT' : '';
  if (!nullsNotDistinct) {
    console.warn('WARNING: migration 034: PostgreSQL < 15 — unique indexes created without NULLS NOT DISTINCT (global settings / bindings may still duplicate). Upgrade to PostgreSQL 16+.');
  }

  // ── 1. live_alerts.read_at ────────────────────────────────────────────────
  if (await knex.schema.hasTable('live_alerts') && !(await knex.schema.hasColumn('live_alerts', 'read_at'))) {
    await knex.schema.alterTable('live_alerts', (t) => {
      t.timestamp('read_at', { useTz: true }).nullable();
    });
    if (await knex.schema.hasColumn('live_alerts', 'read')) {
      const readAtValue = await knex.schema.hasColumn('live_alerts', 'updated_at') ? 'COALESCE(updated_at, now())' : 'now()';
      await knex.raw(`UPDATE live_alerts SET read_at = ${readAtValue} WHERE "read" = true`);
    }
  }

  // ── 2. notification_log ───────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('notification_log'))) {
    await knex.schema.createTable('notification_log', (t) => {
      t.bigIncrements('id').primary();
      t.integer('channel_id').notNullable().references('id').inTable('notification_channels').onDelete('CASCADE');
      t.integer('monitor_id').nullable();
      t.string('event_type', 32).notNullable();
      t.boolean('success').notNullable();
      t.text('error').nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['channel_id', 'created_at']);
    });
  }

  // ── 3. notification_bindings: tenant_id, dedupe, unique ──────────────────
  if (await knex.schema.hasTable('notification_bindings')) {
    if (!(await knex.schema.hasColumn('notification_bindings', 'tenant_id'))) {
      await knex.schema.alterTable('notification_bindings', (t) => {
        t.integer('tenant_id').nullable().references('id').inTable('tenants').onDelete('CASCADE');
      });
      // A binding belongs to the tenant of its channel.
      await knex.raw(
        `UPDATE notification_bindings b
            SET tenant_id = c.tenant_id
           FROM notification_channels c
          WHERE c.id = b.channel_id AND b.tenant_id IS NULL`,
      );
    }
    // Keep the newest binding of each (tenant, channel, scope, scope_id).
    await knex.raw(
      `DELETE FROM notification_bindings a
        USING notification_bindings b
        WHERE a.id < b.id
          AND a.tenant_id IS NOT DISTINCT FROM b.tenant_id
          AND a.channel_id = b.channel_id
          AND a.scope = b.scope
          AND a.scope_id IS NOT DISTINCT FROM b.scope_id`,
    );
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS notification_bindings_uq
         ON notification_bindings (tenant_id, channel_id, scope, scope_id)${nnd}`,
    );
  }

  // ── 4. settings: dedupe, replace the unique constraint ───────────────────
  if (await knex.schema.hasTable('settings')) {
    // Keep the newest row (highest id) per (tenant_id, scope, scope_id, key).
    await knex.raw(
      `DELETE FROM settings a
        USING settings b
        WHERE a.id < b.id
          AND a.tenant_id IS NOT DISTINCT FROM b.tenant_id
          AND a.scope = b.scope
          AND a.scope_id IS NOT DISTINCT FROM b.scope_id
          AND a.key = b.key`,
    );
    // The constraint name depends on how the table was created: look it up.
    const oldConstraints = await uniqueConstraintsOn(knex, 'settings', ['scope', 'scope_id', 'key', 'tenant_id']);
    for (const name of oldConstraints) {
      await knex.raw('ALTER TABLE settings DROP CONSTRAINT IF EXISTS ??', [name]);
    }
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS settings_scope_key_tenant_uq
         ON settings (scope, scope_id, key, tenant_id)${nnd}`,
    );
  }

  // ── 5. uuid columns used by import/export ─────────────────────────────────
  for (const table of ['monitor_groups', 'sites', 'notification_channels', 'user_teams']) {
    if (await knex.schema.hasTable(table) && !(await knex.schema.hasColumn(table, 'uuid'))) {
      // gen_random_uuid() is evaluated per existing row: every row gets its own uuid.
      await knex.raw('ALTER TABLE ?? ADD COLUMN IF NOT EXISTS uuid uuid NOT NULL DEFAULT gen_random_uuid()', [table]);
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  // Data steps (read_at backfill, dedupes, uuid columns) are kept: no-op.
  await knex.raw('DROP INDEX IF EXISTS notification_bindings_uq');

  if (await knex.schema.hasTable('settings')) {
    await knex.raw('DROP INDEX IF EXISTS settings_scope_key_tenant_uq');
    // Restore the original unique constraint so settings upserts keep a target.
    const existing = await uniqueConstraintsOn(knex, 'settings', ['scope', 'scope_id', 'key', 'tenant_id']);
    if (existing.length === 0) {
      await knex.raw(
        'ALTER TABLE settings ADD CONSTRAINT settings_scope_scope_id_key_tenant_id_unique UNIQUE (scope, scope_id, key, tenant_id)',
      );
    }
  }

  await knex.schema.dropTableIfExists('notification_log');
}
