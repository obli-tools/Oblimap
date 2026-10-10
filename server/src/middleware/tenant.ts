import type { Request, Response, NextFunction } from 'express';
import { toDbId } from '../utils/dbId';
import { userHasTenantAccess } from '../utils/sessionTenant';
import { logger } from '../utils/logger';

// Extend Express.Request to carry the resolved tenantId
declare global {
  namespace Express {
    interface Request {
      tenantId: number;
    }
  }
}

function noTenantAccess(res: Response): void {
  res.status(403).json({ success: false, error: 'no_tenant_access' });
}

/**
 * Resolves req.tenantId from the session.
 * Must be applied after requireAuth on all routes that operate on tenant-scoped data.
 *
 * The session's tenant is re-checked on every request (cached a few seconds,
 * utils/sessionTenant.ts): platform admins may work in any existing tenant,
 * everyone else only in a tenant they are still a member of. A session
 * without a tenant, or whose tenant is no longer accessible (membership
 * removed, tenant deleted), answers 403 'no_tenant_access' — never a
 * fallback tenant. An inaccessible tenant is also cleared from the session,
 * so /auth/me or a tenant switch picks a valid one.
 */
export async function requireTenant(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = req.session;
  const userId = toDbId(session?.userId);
  const tenantId = toDbId(session?.currentTenantId);
  if (!session || userId === null || tenantId === null) {
    noTenantAccess(res);
    return;
  }

  let allowed: boolean;
  try {
    allowed = await userHasTenantAccess(userId, tenantId, session.role === 'admin');
  } catch (err) {
    logger.error({ err, userId }, 'requireTenant: tenant access lookup failed');
    res.status(503).json({ success: false, error: 'Service unavailable' });
    return;
  }
  if (!allowed) {
    delete (session as { currentTenantId?: number }).currentTenantId;
    logger.warn({ userId, tenantId }, 'Session tenant no longer accessible — cleared');
    noTenantAccess(res);
    return;
  }

  req.tenantId = tenantId;
  next();
}
