import crypto from 'crypto';
import type { Knex } from 'knex';
import { db } from '../db';
import { hashPassword, comparePassword } from '../utils/crypto';

/** Thrown by findOrCreateForeignUser when the incoming username matches an existing local account. */
export class AccountLinkRequiredError extends Error {
  constructor(public readonly conflictingUsername: string) {
    super('account_link_required');
  }
}
import type { User, UserPreferences } from '@oblimap/shared';
import { logger } from '../utils/logger';
import { passwordSchema } from '../validators/password';

interface UserRow {
  id: number;
  username: string;
  password_hash: string | null;
  display_name: string | null;
  role: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  preferences?: UserPreferences | null;
  email?: string | null;
  preferred_language?: string;
  enrollment_version?: number;
  totp_enabled?: boolean;
  email_otp_enabled?: boolean;
  foreign_source?: string | null;
  foreign_id?: number | null;
  foreign_source_url?: string | null;
  avatar?: string | null;
  must_change_password?: boolean | null;
}

export function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as User['role'],
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    preferences: row.preferences ?? null,
    email: row.email ?? null,
    preferredLanguage: row.preferred_language ?? 'en',
    enrollmentVersion: row.enrollment_version ?? 0,
    totpEnabled: row.totp_enabled ?? false,
    emailOtpEnabled: row.email_otp_enabled ?? false,
    foreignSource: row.foreign_source ?? null,
    foreignId: row.foreign_id ?? null,
    foreignSourceUrl: row.foreign_source_url ?? null,
    hasPassword: row.password_hash !== null && row.password_hash !== '',
    avatar: row.avatar ?? null,
    mustChangePassword: row.must_change_password === true,
  };
}

/** Lower-cased, trimmed e-mail address; null for an empty value. */
export function normalizeEmail(email: string | null | undefined): string | null {
  const s = String(email ?? '').trim().toLowerCase();
  return s === '' ? null : s;
}

/** PostgreSQL unique violation (e.g. the unique lower(email) index of migration 036). */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === '23505';
}

/**
 * Update value for users.preferences (jsonb) that MERGES `patch` into the
 * stored object, in the UPDATE itself: stored keys the patch does not set are
 * kept (the theme, keys synced from Obligate). A stored value that is not a
 * JSON object is replaced.
 */
export function mergedPreferencesSql(patch: Record<string, unknown>): Knex.Raw {
  return db.raw(
    "(CASE WHEN jsonb_typeof(preferences) = 'object' THEN preferences ELSE '{}'::jsonb END) || ?::jsonb",
    [JSON.stringify(patch)],
  );
}

// Hash of a random secret, computed once (port of Obliance
// burnPasswordCompare): compared against when the account is unknown,
// disabled or has no local password, so a sign-in costs one bcrypt compare in
// every case and the answer time does not tell which accounts exist or hold a
// local password (e.g. which og_ SSO accounts do).
let timingDummyHash: Promise<string> | null = null;
async function burnPasswordCompare(password: string): Promise<void> {
  try {
    if (!timingDummyHash) {
      timingDummyHash = hashPassword(crypto.randomBytes(24).toString('hex'));
    }
    await comparePassword(password, await timingDummyHash);
  } catch { /* timing only */ }
}

export const authService = {
  async authenticate(username: string, password: string): Promise<User | null> {
    const row = await db<UserRow>('users')
      .where({ username, is_active: true })
      .first();

    // Unknown / disabled account, or a foreign (SSO) account with no local
    // password: refused, after the same bcrypt work as a wrong password.
    if (!row || !row.password_hash) {
      await burnPasswordCompare(password);
      return null;
    }

    const valid = await comparePassword(password, row.password_hash);
    if (!valid) return null;

    return rowToUser(row);
  },

  async getUserById(id: number): Promise<User | null> {
    const row = await db<UserRow>('users').where({ id }).first();
    if (!row) return null;
    return rowToUser(row);
  },

  /**
   * True when another account already uses this e-mail address
   * (case-insensitive, local and SSO accounts alike).
   */
  async isEmailTaken(email: string, exceptUserId: number): Promise<boolean> {
    const normalized = normalizeEmail(email);
    if (!normalized) return false;
    const row = await db('users')
      .whereRaw('lower(trim(email)) = ?', [normalized])
      .whereNot({ id: exceptUserId })
      .first('id');
    return !!row;
  },

  async createUser(
    username: string,
    password: string,
    role: string = 'user',
    displayName?: string,
  ): Promise<User> {
    const passwordHash = await hashPassword(password);

    const [row] = await db<UserRow>('users')
      .insert({
        username,
        password_hash: passwordHash,
        display_name: displayName || null,
        role,
      })
      .returning('*');

    return rowToUser(row);
  },

  /**
   * Find or create a foreign SSO user.
   * Uses the sso_foreign_users table to support multiple linked sources per user.
   * Returns the user + whether this is their first ever login.
   */
  async findOrCreateForeignUser(
    foreignSource: string,
    foreignId: number,
    foreignSourceUrl: string,
    info: { username: string; email?: string | null },
  ): Promise<{ user: User; isFirstLogin: boolean }> {
    // Look up via sso_foreign_users — supports multiple sources per user without overwriting
    const link = await db('sso_foreign_users')
      .where({ foreign_source: foreignSource, foreign_user_id: foreignId })
      .first() as { local_user_id: number } | undefined;

    if (link) {
      const existing = await db<UserRow>('users').where({ id: link.local_user_id }).first();
      if (existing) {
        // Sync username/email from source (they may have changed)
        await db('users').where({ id: existing.id }).update({
          username: info.username,
          email: info.email ?? existing.email,
          foreign_source_url: foreignSourceUrl,
          updated_at: new Date(),
        });
        const updated = await db<UserRow>('users').where({ id: existing.id }).first() as UserRow;
        return { user: rowToUser(updated), isFirstLogin: false };
      }
    }

    // Check for username collision with any existing account.
    const anyCollision = await db('users')
      .where({ username: info.username })
      .first() as (UserRow & { password_hash: string | null }) | undefined;

    if (anyCollision) {
      if (!anyCollision.password_hash) {
        // The existing account is a password-less SSO account (created via another source).
        // Auto-link this new source — no password proof needed since the account has no secret.
        await db('sso_foreign_users')
          .insert({ foreign_source: foreignSource, foreign_user_id: foreignId, local_user_id: anyCollision.id })
          .onConflict(['foreign_source', 'foreign_user_id'])
          .merge({ local_user_id: anyCollision.id });
        await db('users').where({ id: anyCollision.id }).update({
          email: info.email ?? anyCollision.email,
          foreign_source_url: foreignSourceUrl,
          updated_at: new Date(),
        });
        const updated = await db<UserRow>('users').where({ id: anyCollision.id }).first() as UserRow;
        return { user: rowToUser(updated), isFirstLogin: false };
      }
      // The existing account has a password (local account) — require the user to prove ownership.
      throw new AccountLinkRequiredError(info.username);
    }

    // Create new foreign user (no password, enrollment pending)
    const [row] = await db<UserRow>('users')
      .insert({
        username: info.username,
        password_hash: null,
        display_name: info.username,
        role: 'user',
        is_active: true,
        email: info.email ?? null,
        preferred_language: 'en',
        enrollment_version: 0,
        foreign_source: foreignSource,
        foreign_id: foreignId,
        foreign_source_url: foreignSourceUrl,
      })
      .returning('*');

    // Record the link in sso_foreign_users for future lookups
    await db('sso_foreign_users').insert({
      foreign_source: foreignSource,
      foreign_user_id: foreignId,
      local_user_id: row.id,
    });

    return { user: rowToUser(row), isFirstLogin: true };
  },

  /**
   * Bootstraps the first administrator of an EMPTY database. Never re-creates
   * one because no admin is left (all demoted / deactivated / deleted): that
   * would hand the configured — often default — credentials to whoever knows
   * them, and crash at start-up when that username still exists. The account
   * must change its password at first sign-in (must_change_password).
   */
  async ensureDefaultAdmin(username: string, password: string): Promise<void> {
    const anyUser = await db('users').first('id');
    if (anyUser) return;

    const passwordHash = await hashPassword(password);
    const inserted = await db('users')
      .insert({
        username,
        password_hash: passwordHash,
        display_name: 'Administrator',
        role: 'admin',
        must_change_password: true,
      })
      .onConflict('username')
      .ignore()
      .returning('id') as Array<{ id: number } | number>;

    if (inserted.length === 0) {
      logger.error(`Default admin "${username}" not created: an account with that username already exists`);
      return;
    }
    logger.info(`Default admin user "${username}" created — its password must be changed at first sign-in`);
    if (!passwordSchema.safeParse(password).success) {
      logger.warn('The default admin password (DEFAULT_ADMIN_PASSWORD) does not meet the password policy — change it at first sign-in');
    }
  },
};
