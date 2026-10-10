import type { Knex } from 'knex';

/**
 * Fix missing columns and tables that were referenced by services
 * but not created in the original migrations.
 *
 * 1. notification_channels — add is_enabled + created_by columns
 * 2. notification_channel_tenants — new table for cross-tenant channel sharing
 * 3. team_memberships — correct table name (migration 007 created "team_members" instead)
 * 4. team_permissions — missing table for team group/site permissions
 */
export async function up(knex: Knex): Promise<void> {
  // ── 1. notification_channels: add missing columns ─────────────────────────
  await knex.schema.alterTable('notification_channels', (t) => {
    t.boolean('is_enabled').notNullable().defaultTo(true);
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
  });

  // ── 2. notification_channel_tenants (cross-tenant sharing) ────────────────
  await knex.schema.createTable('notification_channel_tenants', (t) => {
    t.integer('channel_id')
      .notNullable()
      .references('id')
      .inTable('notification_channels')
      .onDelete('CASCADE');
    t.integer('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.primary(['channel_id', 'tenant_id']);
  });

  // ── 3. team_memberships (the service expects this name; migration 007 used "team_members") ──
  // Migrate any existing data from team_members → team_memberships
  await knex.schema.createTable('team_memberships', (t) => {
    t.integer('team_id')
      .notNullable()
      .references('id')
      .inTable('user_teams')
      .onDelete('CASCADE');
    t.integer('user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    t.primary(['team_id', 'user_id']);
  });

  // Copy existing data (team_members has an extra "permission" column we can ignore)
  const existing = await knex('team_members').select('team_id', 'user_id');
  if (existing.length > 0) {
    await knex('team_memberships').insert(existing);
  }

  // Drop the old table
  await knex.schema.dropTableIfExists('team_members');

  // ── 4. team_permissions ───────────────────────────────────────────────────
  await knex.schema.createTable('team_permissions', (t) => {
    t.increments('id').primary();
    t.integer('team_id')
      .notNullable()
      .references('id')
      .inTable('user_teams')
      .onDelete('CASCADE');
    t.string('scope', 16).notNullable();  // 'group' | 'site'
    t.integer('scope_id').notNullable();
    t.string('level', 8).notNullable().defaultTo('ro');  // 'ro' | 'rw'
    t.unique(['team_id', 'scope', 'scope_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('team_permissions');

  // Restore team_members from team_memberships
  await knex.schema.createTable('team_members', (t) => {
    t.integer('team_id').notNullable().references('id').inTable('user_teams').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('permission', 16).notNullable().defaultTo('read');
    t.primary(['team_id', 'user_id']);
  });
  const existing = await knex('team_memberships').select('team_id', 'user_id');
  if (existing.length > 0) {
    await knex('team_members').insert(
      existing.map((r: { team_id: number; user_id: number }) => ({ ...r, permission: 'read' })),
    );
  }
  await knex.schema.dropTableIfExists('team_memberships');

  await knex.schema.dropTableIfExists('notification_channel_tenants');

  await knex.schema.alterTable('notification_channels', (t) => {
    t.dropColumn('created_by');
    t.dropColumn('is_enabled');
  });
}
