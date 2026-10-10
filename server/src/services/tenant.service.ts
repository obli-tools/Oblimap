import type { Server as SocketIOServer } from 'socket.io';
import type { Knex } from 'knex';
import { db } from '../db';
import type { Tenant } from '@oblimap/shared';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { permissionSetService, type TenantCapability } from './permissionSet.service';

interface TenantRow {
  id: number;
  name: string;
  slug: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * A tenant with the user's tenant role: any permission set slug ('admin' =
 * tenant admin, legacy 'member' = 'viewer'); same shape as the shared
 * TenantWithRole.
 */
export type TenantMembership = Tenant & { role: string };

interface UserRow {
  id: number;
  username: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
  email: string | null;
}

/**
 * A tenant role about to be written in `trx` must still be assignable; the
 * permission set it names stays locked until the write commits, so it cannot
 * be deleted in between (permissionSetService.delete). 400 otherwise.
 */
async function lockTenantRole(trx: Knex.Transaction, role: string): Promise<void> {
  if (!(await permissionSetService.lockAssignableTenantRole(trx, role))) {
    throw new AppError(400, "Unknown role: use 'admin', 'member' or the slug of an existing permission set");
  }
}

function rowToTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const tenantService = {
  async getAll(): Promise<Tenant[]> {
    const rows = await db('tenants').select<TenantRow[]>('*').orderBy('id');
    return rows.map(rowToTenant);
  },

  async getById(id: number): Promise<Tenant | null> {
    const row = await db('tenants').where({ id }).first<TenantRow>();
    return row ? rowToTenant(row) : null;
  },

  async getBySlug(slug: string): Promise<Tenant | null> {
    const row = await db('tenants').where({ slug }).first<TenantRow>();
    return row ? rowToTenant(row) : null;
  },

  async create(data: { name: string; slug: string }): Promise<Tenant> {
    const [row] = await db('tenants')
      .insert({ name: data.name, slug: data.slug })
      .returning('*');
    return rowToTenant(row as TenantRow);
  },

  async update(id: number, data: { name?: string; slug?: string }): Promise<Tenant | null> {
    const [row] = await db('tenants')
      .where({ id })
      .update({ ...data, updated_at: db.fn.now() })
      .returning('*');
    return row ? rowToTenant(row as TenantRow) : null;
  },

  /** Returns the number of tenants deleted (0 = not found). */
  async delete(id: number): Promise<number> {
    return Number(await db('tenants').where({ id }).delete()) || 0;
  },

  /** Returns the first tenant accessible by userId (lowest id). */
  async getFirstTenantForUser(userId: number): Promise<Tenant | null> {
    const row = await db('tenants')
      .join('user_tenants', 'tenants.id', 'user_tenants.tenant_id')
      .where('user_tenants.user_id', userId)
      .orderBy('tenants.id')
      .first<TenantRow & { role: string }>('tenants.*');
    return row ? rowToTenant(row) : null;
  },

  /**
   * Returns all tenants accessible by userId, with the tenant-level role: a
   * permission set slug ('admin' = tenant admin; legacy 'member' = 'viewer').
   */
  async getTenantsForUser(userId: number): Promise<TenantMembership[]> {
    const rows = await db('tenants')
      .join('user_tenants', 'tenants.id', 'user_tenants.tenant_id')
      .where('user_tenants.user_id', userId)
      .orderBy('tenants.id')
      .select<(TenantRow & { role: string })[]>('tenants.*', 'user_tenants.role');
    return rows.map((r) => ({ ...rowToTenant(r), role: String(r.role) }));
  },

  /** Check if user has access to a specific tenant. */
  async userHasAccess(userId: number, tenantId: number): Promise<boolean> {
    const row = await db('user_tenants')
      .where({ user_id: userId, tenant_id: tenantId })
      .first('user_id');
    return !!row;
  },

  async getMembers(tenantId: number): Promise<(UserRow & { tenantRole: string })[]> {
    return db('users')
      .join('user_tenants', 'users.id', 'user_tenants.user_id')
      .where('user_tenants.tenant_id', tenantId)
      .select<(UserRow & { tenantRole: string })[]>(
        'users.id',
        'users.username',
        'users.display_name',
        'users.role',
        'users.is_active',
        'users.email',
        db.raw('user_tenants.role as "tenantRole"'),
      )
      .orderBy('users.username');
  },

  /** The user's membership row in the tenant (tenant-level role), or null. */
  async getMembership(tenantId: number, userId: number): Promise<{ role: string } | null> {
    const row = await db('user_tenants')
      .where({ tenant_id: tenantId, user_id: userId })
      .first('role') as { role: string } | undefined;
    return row ? { role: String(row.role) } : null;
  },

  /**
   * Adds (or re-roles) a membership. `role`: 'admin', legacy 'member', or an
   * existing permission set slug — re-checked in the writing transaction
   * (lockTenantRole), so it cannot be a set deleted since the request was
   * validated.
   */
  async addUser(tenantId: number, userId: number, role: string): Promise<void> {
    await db.transaction(async (trx) => {
      await lockTenantRole(trx, role);
      await trx('user_tenants')
        .insert({ tenant_id: tenantId, user_id: userId, role })
        .onConflict(['user_id', 'tenant_id'])
        .merge({ role });
    });
  },

  /** Returns the number of memberships removed (0 = was not a member). */
  async removeUser(tenantId: number, userId: number): Promise<number> {
    return Number(await db('user_tenants').where({ tenant_id: tenantId, user_id: userId }).delete()) || 0;
  },

  /** Returns the number of memberships updated (0 = not a member). `role`: as for addUser. */
  async updateUserRole(tenantId: number, userId: number, role: string): Promise<number> {
    return db.transaction(async (trx) => {
      await lockTenantRole(trx, role);
      return Number(await trx('user_tenants')
        .where({ tenant_id: tenantId, user_id: userId })
        .update({ role })) || 0;
    });
  },
};

/**
 * Tenant capabilities with their own socket room (socket.ts): the members of
 * the tenant holding one of them without being tenant admins join
 * tenant:<id>:cap:<capability>, and the admin-scope events of that area
 * (tenantAdminEventRooms) reach them too — like the REST routes the
 * capability opens (probes, device check rules, settings).
 */
export const SOCKET_ROOM_CAPABILITIES = ['probes.manage', 'probes.read', 'deviceChecks.manage', 'settings'] as const satisfies readonly TenantCapability[];
export type SocketRoomCapability = typeof SOCKET_ROOM_CAPABILITIES[number];

/**
 * Capability rooms that also receive an area's admin-scope events: the probe
 * events (emitted for 'probes.manage') reach the 'probes.read' holders, who
 * may list and open the probes. Every probes.manage /
 * probes.approve holder holds probes.read too (CAPABILITY_IMPLIES); a socket
 * in several of the rooms gets each event once.
 */
const EVENT_ROOM_AUDIENCE: Partial<Record<SocketRoomCapability, readonly SocketRoomCapability[]>> = {
  'probes.manage': ['probes.read'],
};

export function tenantCapabilityRoom(tenantId: number, capability: SocketRoomCapability): string {
  return `tenant:${tenantId}:cap:${capability}`;
}

/**
 * Rooms of an admin-scope event of one capability area: tenant admins and the
 * capability's holders, plus the area's wider audience (EVENT_ROOM_AUDIENCE).
 * `exact: true` leaves the wider audience out, for events of another area
 * that reuse the capability (tunnel events: probes.read holders may not use
 * tunnels).
 */
export function tenantAdminEventRooms(
  tenantId: number,
  capability: SocketRoomCapability,
  options: { exact?: boolean } = {},
): string[] {
  return [
    `tenant:${tenantId}:admin`,
    tenantCapabilityRoom(tenantId, capability),
    ...(options.exact ? [] : (EVENT_ROOM_AUDIENCE[capability] ?? [])).map((c) => tenantCapabilityRoom(tenantId, c)),
  ];
}

/** Socket.io rooms scoped to one tenant (see socket.ts). */
export function tenantRoomNames(tenantId: number): string[] {
  return [
    `tenant:${tenantId}`,
    `tenant:${tenantId}:admin`,
    `tenant:${tenantId}:notifications`,
    ...SOCKET_ROOM_CAPABILITIES.map((c) => tenantCapabilityRoom(tenantId, c)),
  ];
}

/**
 * Live sockets stop receiving a tenant's events: those of one user (membership
 * removed — sockets join tenant rooms at handshake only), or everyone's when
 * userId is null (tenant deleted). Do not call it for a platform admin's own
 * membership: platform admins keep access to every tenant. Never throws.
 */
export function leaveTenantRooms(io: SocketIOServer | null | undefined, tenantId: number, userId: number | null): void {
  if (!io) return;
  try {
    const rooms = tenantRoomNames(tenantId);
    if (userId === null) {
      for (const room of rooms) io.in(room).socketsLeave(room);
    } else {
      io.in(`user:${userId}`).socketsLeave(rooms);
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, tenantId, userId }, 'Could not detach sockets from tenant rooms');
  }
}
