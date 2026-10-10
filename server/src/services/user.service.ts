import type { Knex } from 'knex';
import { db } from '../db';
import { hashPassword } from '../utils/crypto';
import { AppError } from '../middleware/errorHandler';
import { permissionSetService, LEGACY_MEMBER_SET } from './permissionSet.service';
import type { User, UserRole, UserTenantAssignment } from '@oblimap/shared';

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  avatar?: string | null;
  email?: string | null;
}

/** A member of one tenant, as listed to its users.manage holders. */
export interface TenantUser {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  isActive: boolean;
  foreignSource: string | null;
  /** Tenant role (permission set slug, legacy 'member' read as 'viewer'). */
  role: string;
  isPlatformAdmin: boolean;
  lastLoginAt: string | null;
}

/** Throws AppError(400) unless every id names an existing tenant. */
async function assertTenantsExist(trx: Knex | Knex.Transaction, tenantIds: number[]): Promise<void> {
  if (tenantIds.length === 0) return;
  const found = await trx('tenants').whereIn('id', tenantIds).pluck('id') as unknown[];
  if (new Set(found.map(Number)).size !== tenantIds.length) throw new AppError(400, 'Unknown tenant');
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as UserRole,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    preferredLanguage: (row as any).preferred_language ?? 'en',
    enrollmentVersion: (row as any).enrollment_version ?? 0,
    foreignSource: (row as any).foreign_source ?? null,
    foreignId: (row as any).foreign_id ?? null,
    foreignSourceUrl: (row as any).foreign_source_url ?? null,
    avatar: row.avatar ?? null,
    email: row.email ?? null,
  };
}

export const userService = {
  async getAll(): Promise<User[]> {
    const rows = await db<UserRow>('users').orderBy('username');
    return rows.map(rowToUser);
  },

  async getById(id: number): Promise<User | null> {
    const row = await db<UserRow>('users').where({ id }).first();
    return row ? rowToUser(row) : null;
  },

  /**
   * Creates the user and its tenant memberships in one transaction, with the
   * tenant role `tenantRole` (default 'viewer'; the legacy 'member'
   * is no longer written). tenantIds must not be empty: no account without a
   * tenant.
   */
  async create(data: {
    username: string;
    password: string;
    displayName?: string | null;
    role?: UserRole;
    email?: string | null;
  }, tenantIds: number[], tenantRole: string = LEGACY_MEMBER_SET): Promise<User> {
    const tids = [...new Set(tenantIds)];
    if (tids.length === 0) throw new AppError(400, 'At least one tenant is required');
    const passwordHash = await hashPassword(data.password);

    return db.transaction(async (trx) => {
      await assertTenantsExist(trx, tids);
      if (!(await permissionSetService.lockAssignableTenantRole(trx, tenantRole))) {
        throw new AppError(400, 'Unknown tenant role');
      }
      const [row] = await trx<UserRow>('users')
        .insert({
          username: data.username,
          password_hash: passwordHash,
          display_name: data.displayName || null,
          role: data.role || 'user',
          ...(data.email ? { email: data.email } : {}),
        })
        .returning('*');

      // user_tenants (migration 003) has no created_at column.
      await trx('user_tenants').insert(tids.map((tenantId) => ({
        user_id: row.id,
        tenant_id: tenantId,
        role: tenantRole,
      })));

      return rowToUser(row);
    });
  },

  async update(id: number, data: {
    displayName?: string | null;
    role?: UserRole;
    isActive?: boolean;
    email?: string | null;
  }, opts: { guard?: (trx: Knex.Transaction) => Promise<void> } = {}): Promise<User | null> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (data.displayName !== undefined) updateData.display_name = data.displayName;
    if (data.role !== undefined) updateData.role = data.role;
    if (data.isActive !== undefined) updateData.is_active = data.isActive;
    if (data.email !== undefined) updateData.email = data.email || null;

    // opts.guard runs in the writing transaction (last-tenant-admin guard).
    return db.transaction(async (trx) => {
      if (opts.guard) await opts.guard(trx);
      const [row] = await trx<UserRow>('users')
        .where({ id })
        .update(updateData)
        .returning('*');
      return row ? rowToUser(row) : null;
    });
  },

  /**
   * Sets a new password. opts.mustChange (password chosen by an admin): the
   * user must replace it at the next sign-in (middleware/accountPolicy.ts).
   */
  async changePassword(id: number, newPassword: string, opts: { mustChange?: boolean } = {}): Promise<boolean> {
    const passwordHash = await hashPassword(newPassword);
    const now = new Date();
    const count = await db('users')
      .where({ id })
      .update({
        password_hash: passwordHash,
        must_change_password: opts.mustChange === true,
        password_changed_at: now,
        updated_at: now,
      });
    return count > 0;
  },

  /**
   * Admin reset of the second factors: TOTP secret, enabled
   * flag and anti-replay step, e-mail OTP. False when the user is missing.
   */
  async resetSecondFactors(id: number): Promise<boolean> {
    const count = await db('users').where({ id }).update({
      totp_secret: null,
      totp_enabled: false,
      totp_last_step: null,
      email_otp_enabled: false,
      updated_at: new Date(),
    });
    return count > 0;
  },

  /**
   * Members of one tenant (scoped list). lastLoginAt: the latest
   * sign-in in the audit log (auth.login / sso.login, kept 365 days).
   */
  async getTenantUsers(tenantId: number): Promise<TenantUser[]> {
    const rows = await db('users')
      .join('user_tenants', 'users.id', 'user_tenants.user_id')
      .where('user_tenants.tenant_id', tenantId)
      .select(
        'users.id', 'users.username', 'users.display_name', 'users.email', 'users.is_active',
        'users.foreign_source', 'users.role as platform_role', 'user_tenants.role as tenant_role',
      )
      .orderBy('users.username') as Array<{
        id: number; username: string; display_name: string | null; email: string | null; is_active: boolean;
        foreign_source: string | null; platform_role: string; tenant_role: string;
      }>;
    const ids = rows.map((r) => Number(r.id));
    const logins = new Map<number, string>();
    if (ids.length > 0) {
      const last = await db('audit_logs')
        .whereIn('user_id', ids)
        .whereIn('action', ['auth.login', 'sso.login'])
        .groupBy('user_id')
        .select('user_id', db.raw('MAX(created_at) as last_login')) as Array<{ user_id: number; last_login: Date | string | null }>;
      for (const l of last) {
        if (l.last_login) logins.set(Number(l.user_id), new Date(l.last_login).toISOString());
      }
    }
    return rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      displayName: r.display_name ?? null,
      email: r.email ?? null,
      isActive: r.is_active !== false,
      foreignSource: r.foreign_source ?? null,
      role: String(r.tenant_role) === 'member' ? LEGACY_MEMBER_SET : String(r.tenant_role),
      isPlatformAdmin: r.platform_role === 'admin',
      lastLoginAt: logins.get(Number(r.id)) ?? null,
    }));
  },

  async delete(id: number, opts: { guard?: (trx: Knex.Transaction) => Promise<void> } = {}): Promise<boolean> {
    return db.transaction(async (trx) => {
      if (opts.guard) await opts.guard(trx);
      const count = await trx('users').where({ id }).del();
      return count > 0;
    });
  },

  /** Returns all tenants with this user's membership status and role. */
  async getUserTenantAssignments(userId: number): Promise<UserTenantAssignment[]> {
    const rows = await db('tenants as t')
      .leftJoin('user_tenants as ut', function () {
        this.on('ut.tenant_id', '=', 't.id').andOnVal('ut.user_id', '=', userId);
      })
      .select(
        't.id as tenantId',
        't.name as tenantName',
        't.slug as tenantSlug',
        db.raw('(ut.user_id IS NOT NULL) as is_member'),
        db.raw("COALESCE(ut.role, 'viewer') as role"),
      )
      .orderBy('t.name');

    return rows.map((r) => ({
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      tenantSlug: r.tenantSlug,
      isMember: Boolean(r.is_member),
      role: String(r.role),
    }));
  },

  /**
   * Bulk-replaces all tenant memberships for a user. Returns the memberships
   * held before the change.
   */
  async setUserTenantAssignments(
    userId: number,
    assignments: { tenantId: number; role: string }[],
    opts: { guard?: (trx: Knex.Transaction) => Promise<void> } = {},
  ): Promise<{ tenantId: number; role: string }[]> {
    // One row per tenant (the last assignment wins).
    const unique = [...new Map(assignments.map((a) => [a.tenantId, a] as const)).values()];
    return db.transaction(async (trx) => {
      // opts.guard runs before any write (last-tenant-admin guard).
      if (opts.guard) await opts.guard(trx);
      await assertTenantsExist(trx, unique.map((a) => a.tenantId));
      // Every role must be 'admin', legacy 'member' or an existing permission
      // set slug, checked under a FOR SHARE lock so a concurrent set delete
      // cannot leave a membership on a slug that no longer exists.
      for (const role of new Set(unique.map((a) => a.role))) {
        if (!(await permissionSetService.lockAssignableTenantRole(trx, role))) {
          throw new AppError(400, 'Unknown tenant role');
        }
      }
      const before = await trx('user_tenants')
        .where({ user_id: userId })
        .select('tenant_id', 'role') as { tenant_id: number; role: string }[];
      await trx('user_tenants').where({ user_id: userId }).del();
      if (unique.length > 0) {
        await trx('user_tenants').insert(
          unique.map((a) => ({
            user_id: userId,
            tenant_id: a.tenantId,
            role: a.role,
          })),
        );
      }
      return before.map((r) => ({ tenantId: Number(r.tenant_id), role: String(r.role) }));
    });
  },
};
