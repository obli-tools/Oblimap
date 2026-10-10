import type { Knex } from 'knex';

/**
 * Security hardening columns and indexes. Idempotent (every step guarded).
 *
 * users    totp_last_step (TOTP anti-replay), must_change_password (default
 *          false: existing accounts are NOT forced to change their password),
 *          password_changed_at.
 * probes   token_hash / token_issued_at — per-probe identity token (sha256 of
 *          the secret; issued trust-on-first-use to probes that advertise it).
 *          token_pending_hash / token_pending_at — the last token issued and
 *          not yet presented by the probe (bound on first use; kept in the
 *          row so a server restart does not discard it).
 * tunnels  last_activity_at — idle expiry of TCP tunnels.
 * session  expression index on sess->>'userId' (and a partial one on
 *          pendingMfaUserId) for the per-user session kill-switch.
 * users    unique lower(email) for local accounts — skipped with a warning
 *          when the existing data already holds duplicates.
 */

async function addColumnIfMissing(
  knex: Knex,
  table: string,
  column: string,
  build: (t: Knex.AlterTableBuilder) => void,
): Promise<void> {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, column)) return;
  await knex.schema.alterTable(table, build);
}

export async function up(knex: Knex): Promise<void> {
  // ── users ─────────────────────────────────────────────────────────────────
  await addColumnIfMissing(knex, 'users', 'totp_last_step', (t) => {
    t.bigInteger('totp_last_step').nullable();
  });
  await addColumnIfMissing(knex, 'users', 'must_change_password', (t) => {
    t.boolean('must_change_password').notNullable().defaultTo(false);
  });
  await addColumnIfMissing(knex, 'users', 'password_changed_at', (t) => {
    t.timestamp('password_changed_at', { useTz: true }).nullable();
  });

  // ── probes: identity token ────────────────────────────────────────────────
  await addColumnIfMissing(knex, 'probes', 'token_hash', (t) => {
    t.string('token_hash', 64).nullable();
  });
  await addColumnIfMissing(knex, 'probes', 'token_issued_at', (t) => {
    t.timestamp('token_issued_at', { useTz: true }).nullable();
  });
  await addColumnIfMissing(knex, 'probes', 'token_pending_hash', (t) => {
    t.string('token_pending_hash', 64).nullable();
  });
  await addColumnIfMissing(knex, 'probes', 'token_pending_at', (t) => {
    t.timestamp('token_pending_at', { useTz: true }).nullable();
  });

  // ── tunnels: idle tracking ────────────────────────────────────────────────
  await addColumnIfMissing(knex, 'tunnels', 'last_activity_at', (t) => {
    t.timestamp('last_activity_at', { useTz: true }).nullable();
  });

  // ── session: per-user lookup for killSessionsForUser ─────────────────────
  // Same expressions as the DELETE in services/userSessions.service.ts so the
  // planner can use them (works whether sess is json or jsonb).
  if (await knex.schema.hasTable('session')) {
    await knex.raw(`CREATE INDEX IF NOT EXISTS session_user_id_idx ON session ((sess->>'userId'))`);
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS session_pending_mfa_user_id_idx ON session ((sess->>'pendingMfaUserId'))
        WHERE (sess->>'pendingMfaUserId') IS NOT NULL`,
    );
  }

  // ── users: unique e-mail (local accounts) ─────────────────────────────────
  // SSO-provisioned accounts (foreign_source set) are left out: their e-mail
  // comes from the identity provider and may legitimately equal the e-mail of
  // an older local account (enrollment.controller.ts skips the check for
  // them) — including them would make the SSO callback fail for such users.
  if (await knex.schema.hasTable('users') && await knex.schema.hasColumn('users', 'email')) {
    const predicate = `email IS NOT NULL AND email <> '' AND foreign_source IS NULL`;
    const dup = await knex.raw(
      `SELECT lower(email) AS email FROM users WHERE ${predicate} GROUP BY 1 HAVING count(*) > 1 LIMIT 1`,
    ) as { rows: unknown[] };
    if ((dup.rows ?? []).length > 0) {
      console.warn(
        'WARNING: migration 036: several local accounts share the same e-mail address (case-insensitive) — '
        + 'unique e-mail index NOT created. Give each local account its own address; the index is not retried automatically.',
      );
    } else {
      await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq ON users (lower(email)) WHERE ${predicate}`);
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS users_email_lower_uq');
  await knex.raw('DROP INDEX IF EXISTS session_pending_mfa_user_id_idx');
  await knex.raw('DROP INDEX IF EXISTS session_user_id_idx');

  const drops: Array<[string, string]> = [
    ['tunnels', 'last_activity_at'],
    ['probes', 'token_pending_at'],
    ['probes', 'token_pending_hash'],
    ['probes', 'token_issued_at'],
    ['probes', 'token_hash'],
    ['users', 'password_changed_at'],
    ['users', 'must_change_password'],
    ['users', 'totp_last_step'],
  ];
  for (const [table, column] of drops) {
    if (await knex.schema.hasTable(table) && await knex.schema.hasColumn(table, column)) {
      await knex.schema.alterTable(table, (t) => { t.dropColumn(column); });
    }
  }
}
