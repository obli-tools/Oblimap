import type { Knex } from 'knex';

/**
 * Audit trail (port of Obliance audit_logs, device_id → probe_id,
 * resource_path → resource_id). Written by services/audit.service.ts.
 *
 * tenant_id is nullable: login failures and platform-level events have no
 * tenant. details never holds secrets (the service redacts them).
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('audit_logs')) return;

  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').nullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('probe_id').nullable().references('id').inTable('probes').onDelete('SET NULL');
    t.string('action', 100).notNullable();        // 'auth.login', 'probe.key_mismatch', ...
    t.string('resource_type', 50).nullable();     // 'user' | 'probe' | 'tunnel' | ...
    t.string('resource_id', 64).nullable();
    t.jsonb('details').nullable();                // context, never secrets
    t.string('ip_address', 45).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['tenant_id', 'created_at'], 'audit_logs_tenant_created_idx');
    t.index(['resource_type', 'resource_id'], 'audit_logs_resource_idx');
    t.index(['action'], 'audit_logs_action_idx');
    t.index(['user_id', 'created_at'], 'audit_logs_user_created_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_logs');
}
