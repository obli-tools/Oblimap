import type { Knex } from 'knex';

/**
 * Tenant membership backfill (keeps existing users' access on upgrade).
 *
 * Before the security wave, a non-admin account WITHOUT any user_tenants row
 * signed in to tenant 1 (auth.controller setSessionTenant / 2FA verify /
 * Obligate callback / X-Auth-Token path all used `?? 1`). Accounts created
 * from the admin UI got their tenants in a separate step, so many have none.
 * Membership is now required (sign-in, /auth/me, requireTenant, socket.io):
 * without this backfill those users could no longer sign in.
 *
 * Every non-admin account with no membership at all gets role 'member' in
 * tenant 1 — exactly the tenant it used to land in. Nothing is done when
 * tenant 1 no longer exists (such accounts had no data access before either).
 * Platform admins (users.role = 'admin') have implicit access to every tenant
 * and are skipped. Idempotent (NOT EXISTS + ON CONFLICT DO NOTHING); runs once
 * at upgrade, so a membership an administrator removes later stays removed.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('user_tenants'))) return;
  if (!(await knex.schema.hasTable('tenants'))) return;
  const tenant1 = await knex('tenants').where({ id: 1 }).first('id');
  if (!tenant1) return;

  const result = await knex.raw(`
    INSERT INTO user_tenants (user_id, tenant_id, role)
    SELECT u.id, 1, 'member'
      FROM users u
     WHERE u.role <> 'admin'
       AND NOT EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.user_id = u.id)
    ON CONFLICT (user_id, tenant_id) DO NOTHING
  `);
  const count = Number((result as { rowCount?: number }).rowCount ?? 0);
  if (count > 0) {
    console.warn(`[migration] ${count} account(s) without a tenant were given membership of tenant 1 (their previous implicit tenant). Review them in Admin > Users.`);
  }
}

export async function down(): Promise<void> {
  // No-op: the added memberships cannot be told apart from ones created
  // afterwards, and removing them would lock those users out.
}
