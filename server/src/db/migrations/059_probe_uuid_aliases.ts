import type { Knex } from 'knex';

// Obli* device identity v2 (same model as Obliance): probes move
// from a hardware-derived UUID to the shared random Obli* device ID. When a
// probe row is re-keyed, its previous UUID is kept here so in-flight requests
// (alias-aware authentication) and cross-app (Obligate) links keep resolving.
//
// `uuid` is NOT unique: a junk SMBIOS UUID shared by several machines can end
// up as an alias of each of them over time. Idempotent (guarded).
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('probe_uuid_aliases')) return;
  await knex.schema.createTable('probe_uuid_aliases', (t) => {
    t.increments('id').primary();
    t.integer('probe_id').notNullable().references('id').inTable('probes').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.uuid('uuid').notNullable();
    t.string('reason', 32).notNullable().defaultTo('migrated');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['uuid']);
    t.index(['probe_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('probe_uuid_aliases');
}
