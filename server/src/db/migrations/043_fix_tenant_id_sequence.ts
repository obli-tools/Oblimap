import type { Knex } from 'knex';

/**
 * Migration 003 seeds the Default tenant with an explicit id 1, which
 * does not advance tenants_id_seq: on a fresh install the first
 * POST /api/tenants drew nextval() = 1 and hit a duplicate primary key.
 *
 * Moves the sequence to at least MAX(tenants.id). Never moves it backwards
 * (a deployment whose sequence is already ahead — tenants 2..N, deleted
 * tenants — keeps it: ids of deleted tenants are not handed out again).
 * Idempotent and non-destructive.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('tenants'))) return;

  const seqRes = await knex.raw("SELECT pg_get_serial_sequence('tenants', 'id') AS seq");
  const seq = (seqRes.rows?.[0]?.seq as string | null | undefined) ?? null;
  if (!seq) return; // not a serial column: nothing to fix

  // pg_get_serial_sequence returns an already-quoted, schema-qualified name;
  // it goes through a regclass cast, never interpolated as SQL.
  const stateRes = await knex.raw(
    "SELECT last_value FROM pg_sequences WHERE (quote_ident(schemaname) || '.' || quote_ident(sequencename))::regclass = ?::regclass",
    [seq],
  );
  const state = stateRes.rows?.[0] as { last_value: string | number | null } | undefined;
  // pg_sequences.last_value is NULL until the sequence was first used.
  const current = state && state.last_value !== null && state.last_value !== undefined
    ? Number(state.last_value) || 0
    : 0;

  await knex.raw(
    'SELECT setval(?::regclass, GREATEST((SELECT COALESCE(MAX(id), 1) FROM tenants), ?::bigint, 1))',
    [seq, current],
  );
}

export async function down(): Promise<void> {
  // No-op: a sequence moved forward is harmless and must not go back.
}
