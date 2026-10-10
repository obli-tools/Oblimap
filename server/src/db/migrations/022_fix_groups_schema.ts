import type { Knex } from 'knex';

/**
 * Fix monitor_groups and group_closure tables.
 *
 * Migration 004 created these tables with an incomplete schema:
 * 1. monitor_groups — missing sort_order, is_general, group_notifications, kind,
 *    agent_thresholds, agent_group_config columns (required by group.service.ts)
 * 2. group_closure — created with `ancestor`/`descendant` columns but the service
 *    expects `ancestor_id`/`descendant_id`
 */
export async function up(knex: Knex): Promise<void> {
  // ── 1. Add missing columns to monitor_groups ──────────────────────────────
  await knex.schema.alterTable('monitor_groups', (t) => {
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('is_general').notNullable().defaultTo(false);
    t.boolean('group_notifications').notNullable().defaultTo(false);
    t.string('kind', 32).notNullable().defaultTo('monitor');
    t.jsonb('agent_thresholds').nullable();
    t.jsonb('agent_group_config').nullable();
  });

  // ── 2. Fix group_closure column names ─────────────────────────────────────
  // The original migration used `ancestor`/`descendant`; the service uses
  // `ancestor_id`/`descendant_id`. Recreate with correct names, preserving data.
  const hasOldSchema = await knex.schema.hasColumn('group_closure', 'ancestor');

  if (hasOldSchema) {
    // Save existing rows
    const existing = await knex('group_closure').select('ancestor', 'descendant', 'depth');

    // Drop and recreate with correct column names
    await knex.schema.dropTable('group_closure');
    await knex.schema.createTable('group_closure', (t) => {
      t.integer('ancestor_id')
        .notNullable()
        .references('id')
        .inTable('monitor_groups')
        .onDelete('CASCADE');
      t.integer('descendant_id')
        .notNullable()
        .references('id')
        .inTable('monitor_groups')
        .onDelete('CASCADE');
      t.integer('depth').notNullable();
      t.primary(['ancestor_id', 'descendant_id']);
    });

    // Restore data with renamed columns
    if (existing.length > 0) {
      await knex('group_closure').insert(
        existing.map((r: { ancestor: number; descendant: number; depth: number }) => ({
          ancestor_id: r.ancestor,
          descendant_id: r.descendant,
          depth: r.depth,
        })),
      );
    }
  } else {
    // group_closure already uses the new column names — nothing to do
  }
}

export async function down(knex: Knex): Promise<void> {
  // Restore group_closure to old schema
  const existing = await knex('group_closure').select('ancestor_id', 'descendant_id', 'depth');

  await knex.schema.dropTable('group_closure');
  await knex.schema.createTable('group_closure', (t) => {
    t.integer('ancestor')
      .notNullable()
      .references('id')
      .inTable('monitor_groups')
      .onDelete('CASCADE');
    t.integer('descendant')
      .notNullable()
      .references('id')
      .inTable('monitor_groups')
      .onDelete('CASCADE');
    t.integer('depth').notNullable();
    t.primary(['ancestor', 'descendant']);
  });

  if (existing.length > 0) {
    await knex('group_closure').insert(
      existing.map((r: { ancestor_id: number; descendant_id: number; depth: number }) => ({
        ancestor: r.ancestor_id,
        descendant: r.descendant_id,
        depth: r.depth,
      })),
    );
  }

  // Remove added columns from monitor_groups
  await knex.schema.alterTable('monitor_groups', (t) => {
    t.dropColumn('agent_group_config');
    t.dropColumn('agent_thresholds');
    t.dropColumn('kind');
    t.dropColumn('group_notifications');
    t.dropColumn('is_general');
    t.dropColumn('sort_order');
  });
}
