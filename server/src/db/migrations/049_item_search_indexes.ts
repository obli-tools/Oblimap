import type { Knex } from 'knex';

/**
 * Indexes of the tenant-wide device search (GET /api/items).
 * Idempotent and non-destructive (IF NOT EXISTS everywhere):
 *  1. CREATE EXTENSION IF NOT EXISTS pg_trgm, in its own (sub)transaction:
 *     a database role that may not create it (managed PostgreSQL, no CREATE
 *     privilege, extension not installed) only gets a warning;
 *  2. with pg_trgm: GIN trigram indexes on site_items hostname, custom_name
 *     and vendor (the ILIKE '%…%' search); without it: plain btree indexes on
 *     (tenant_id, hostname / custom_name / vendor) instead;
 *  3. btree indexes on site_items (tenant_id, mac) and (tenant_id, ip): the
 *     cross-site MAC / IP lookups of the device detail and the search.
 * down() drops the indexes, never the extension (other objects may use it).
 */

const TRGM_INDEXES = [
  ['idx_site_items_hostname_trgm', 'hostname'],
  ['idx_site_items_custom_name_trgm', 'custom_name'],
  ['idx_site_items_vendor_trgm', 'vendor'],
] as const;

const FALLBACK_INDEXES = [
  ['idx_site_items_tenant_hostname', 'hostname'],
  ['idx_site_items_tenant_custom_name', 'custom_name'],
  ['idx_site_items_tenant_vendor', 'vendor'],
] as const;

const LOOKUP_INDEXES = [
  ['idx_site_items_tenant_mac', 'mac'],
  ['idx_site_items_tenant_ip', 'ip'],
] as const;

async function ensureTrgm(knex: Knex): Promise<boolean> {
  try {
    // knex.transaction() inside the migration's transaction is a savepoint:
    // a refused CREATE EXTENSION does not abort the migration.
    await knex.transaction(async (trx) => {
      await trx.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    });
    return true;
  } catch (err) {
    console.warn(
      `WARNING: migration 049: pg_trgm is not available (${(err as Error)?.message ?? err}) — `
      + 'device search uses plain btree indexes instead of trigram indexes. '
      + 'For faster searches, run as a superuser: CREATE EXTENSION IF NOT EXISTS pg_trgm; then '
      + TRGM_INDEXES.map(([name, column]) =>
        `CREATE INDEX IF NOT EXISTS ${name} ON site_items USING gin (${column} gin_trgm_ops);`).join(' ')
      + ' (this migration does not run again by itself).',
    );
    return false;
  }
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('site_items'))) return;

  if (await ensureTrgm(knex)) {
    for (const [name, column] of TRGM_INDEXES) {
      await knex.raw(`CREATE INDEX IF NOT EXISTS ${name} ON site_items USING gin (${column} gin_trgm_ops)`);
    }
  } else {
    for (const [name, column] of FALLBACK_INDEXES) {
      await knex.raw(`CREATE INDEX IF NOT EXISTS ${name} ON site_items (tenant_id, ${column})`);
    }
  }
  for (const [name, column] of LOOKUP_INDEXES) {
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${name} ON site_items (tenant_id, ${column})`);
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const [name] of [...TRGM_INDEXES, ...FALLBACK_INDEXES, ...LOOKUP_INDEXES]) {
    await knex.raw(`DROP INDEX IF EXISTS ${name}`);
  }
}
