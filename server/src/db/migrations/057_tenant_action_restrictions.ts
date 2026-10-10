import type { Knex } from 'knex';

/**
 * Per-tenant action restrictions (ported from Obliance
 * migration 066_action_restrictions): tenants.action_restrictions maps an
 * action key (restriction.service ACTION_KEYS, e.g. 'tunnel.open') to its
 * level. Only 'sensitive' entries are stored — the action then needs a fresh
 * 2FA step-up (middleware/stepUp.ts). An empty object (the default, and every
 * existing tenant) keeps today's behaviour: no action is restricted.
 *
 * Idempotent (hasColumn guard) and non-destructive.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('tenants'))) return;
  if (await knex.schema.hasColumn('tenants', 'action_restrictions')) return;
  await knex.schema.alterTable('tenants', (t) => {
    t.jsonb('action_restrictions').notNullable().defaultTo('{}');
  });
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('tenants'))) return;
  if (!(await knex.schema.hasColumn('tenants', 'action_restrictions'))) return;
  await knex.schema.alterTable('tenants', (t) => {
    t.dropColumn('action_restrictions');
  });
}
