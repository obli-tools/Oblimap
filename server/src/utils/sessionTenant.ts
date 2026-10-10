import { db } from '../db';

// Which tenant a session may work in. Platform admins (users.role = 'admin')
// have implicit access to every tenant — their access is NOT materialised in
// user_tenants. Everyone else needs a user_tenants row. There is no fallback
// tenant: a user without membership gets null, never tenant 1.

function toPositiveInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

/**
 * Tenant to select at sign-in:
 *  1. the tenant whose slug is preferredSlug (cross-app handoff), when the
 *     user is a member of it or is a platform admin;
 *  2. otherwise the user's membership with the lowest tenant id;
 *  3. otherwise, for platform admins only, the lowest tenant id;
 *  4. otherwise null (the caller refuses the sign-in / tenant access).
 */
export async function pickInitialTenantId(
  userId: number,
  opts: { isPlatformAdmin: boolean; preferredSlug?: string | null },
): Promise<number | null> {
  const uid = toPositiveInt(userId);
  if (uid === null) return null;

  const slug = typeof opts.preferredSlug === 'string' ? opts.preferredSlug.trim() : '';
  if (slug && slug.length <= 128) {
    const match = opts.isPlatformAdmin
      ? await db('tenants').where({ slug }).first('id') as { id: number } | undefined
      : await db('tenants as t')
        .join('user_tenants as ut', 'ut.tenant_id', 't.id')
        .where({ 't.slug': slug, 'ut.user_id': uid })
        .first('t.id') as { id: number } | undefined;
    if (match) return Number(match.id);
  }

  const membership = await db('user_tenants')
    .where({ user_id: uid })
    .orderBy('tenant_id')
    .first('tenant_id') as { tenant_id: number } | undefined;
  if (membership) return Number(membership.tenant_id);

  if (opts.isPlatformAdmin) {
    const first = await db('tenants').orderBy('id').first('id') as { id: number } | undefined;
    if (first) return Number(first.id);
  }
  return null;
}

// userHasTenantAccess answers are cached a few seconds: it runs on every
// tenant-scoped request and socket handshake. Membership changes call
// invalidateTenantAccessCache(userId) so removals apply at once.
const TTL_MS = 5_000;
const MAX_ENTRIES = 10_000;
const accessCache = new Map<string, { at: number; ok: boolean }>();

/** Drops cached answers for one user, or for everyone when userId is omitted. */
export function invalidateTenantAccessCache(userId?: number): void {
  if (userId === undefined) { accessCache.clear(); return; }
  const prefix = `${userId}:`;
  for (const key of accessCache.keys()) {
    if (key.startsWith(prefix)) accessCache.delete(key);
  }
}

/**
 * True when the user may work in the tenant: platform admins for any existing
 * tenant, other users only with a user_tenants membership.
 */
export async function userHasTenantAccess(userId: number, tenantId: number, isPlatformAdmin: boolean): Promise<boolean> {
  const uid = toPositiveInt(userId);
  const tid = toPositiveInt(tenantId);
  if (uid === null || tid === null) return false;

  const key = `${uid}:${tid}:${isPlatformAdmin ? 1 : 0}`;
  const now = Date.now();
  const hit = accessCache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.ok;

  const row = isPlatformAdmin
    ? await db('tenants').where({ id: tid }).first('id')
    : await db('user_tenants').where({ user_id: uid, tenant_id: tid }).first('user_id');
  const ok = !!row;

  if (accessCache.size >= MAX_ENTRIES) accessCache.clear();
  accessCache.set(key, { at: now, ok });
  return ok;
}
