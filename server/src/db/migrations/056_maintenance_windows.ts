import type { Knex } from 'knex';

/**
 * Maintenance windows (ported from Obliance maintenance_windows).
 * While a window covering a site is active, the IPAM pipeline still updates
 * device / probe states and resolves alerts, but raises no NEW live alert
 * and sends no channel notification (maintenance.service).
 *
 * - scope 'tenant' (scope_id NULL), 'group' (the group and its sub-groups,
 *   group_closure) or 'site'. scope_id is polymorphic (no foreign key): a
 *   window whose group / site was deleted simply covers nothing.
 * - kind 'one_time': starts_at → ends_at (instants).
 * - kind 'recurring': recurrence { days: ['mon'…], start: 'HH:MM', end: 'HH:MM' }
 *   read in `timezone` (IANA); end before start crosses midnight.
 *
 * Idempotent (hasTable guard) and non-destructive.
 * Requires PostgreSQL 13+ (built-in gen_random_uuid(), already used by migration 033).
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('maintenance_windows')) return;
  await knex.schema.createTable('maintenance_windows', (t) => {
    t.increments('id').primary();
    t.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    t.string('scope', 16).notNullable().defaultTo('tenant');
    t.integer('scope_id').nullable();
    t.string('kind', 16).notNullable().defaultTo('one_time');
    t.timestamp('starts_at', { useTz: true }).nullable();
    t.timestamp('ends_at', { useTz: true }).nullable();
    t.jsonb('recurrence').nullable();
    t.string('timezone', 64).notNullable().defaultTo('UTC');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenant_id', 'enabled'], 'maintenance_windows_tenant_enabled_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('maintenance_windows');
}
