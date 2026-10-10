import type { Knex } from 'knex';

/**
 * Real subnets of a site. The list shown to users merges these rows
 * (named by an admin: name, VLAN, gateway, description) with the prefixes the
 * site's probes report as scanned (probes.last_scanned_subnets, 050) — a
 * probe prefix needs no row; a row only carries metadata or declares a subnet
 * no probe scans. CIDRs are stored normalised (network address, IPv4 only).
 *
 * Idempotent (hasTable guard) and non-destructive.
 * Requires PostgreSQL 13+ (built-in gen_random_uuid(), already used by migration 033).
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('site_subnets')) return;
  await knex.schema.createTable('site_subnets', (t) => {
    t.increments('id').primary();
    t.uuid('uuid').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.string('cidr', 18).notNullable();
    t.string('name', 100).nullable();
    t.integer('vlan').nullable();
    t.string('gateway', 15).nullable();
    t.text('description').nullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['site_id', 'cidr'], { indexName: 'site_subnets_site_cidr_uq' });
    t.index(['tenant_id', 'site_id'], 'site_subnets_tenant_site_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('site_subnets');
}
