import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { isIP } from 'net';
import { smtpServerController } from '../controllers/smtpServer.controller';
import { requireAuth } from '../middleware/auth';
import { requireTenantCapability } from '../middleware/rbac';
import { assertPublicHttpUrl, TargetNotAllowedError } from '../utils/ssrfGuard';
import { toDbId } from '../utils/dbId';
import { logger } from '../utils/logger';
import { db } from '../db';

const router = Router();

// Mounted on the tenant router: SMTP servers of the current tenant, managed
// with the 'notifications.manage' tenant capability.
router.use(requireAuth, requireTenantCapability('notifications.manage'));

// SMTP hosts chosen below the platform level (SSRF). The connection test and
// every notification e-mail open a TCP connection from this server to
// host:port, so a tenant user could otherwise probe the server's own network
// (127.0.0.1:5432, the Docker network, the cloud metadata endpoint) through
// the test's answer and timing. Same screening as outbound webhooks
// (utils/ssrfGuard): the host must be public — a name is resolved and every
// answer checked — unless it, or its address, is listed in SSRF_ALLOWLIST
// (an internal mail relay). Platform admins, who alone managed SMTP servers
// before tenant capabilities, are not restricted.

function isPlatformAdmin(req: Request): boolean {
  return req.session?.role === 'admin';
}

/** Refuses (400 'Target not allowed') an SMTP host a tenant user may not reach. */
async function assertSmtpHostAllowed(req: Request, host: string): Promise<void> {
  const bare = host.trim().replace(/^\[(.*)\]$/, '$1');
  try {
    if (isIP(bare) === 6) {
      await assertPublicHttpUrl(`http://[${bare}]/`);
      return;
    }
    // Host names and IPv4 only. The URL parser normalises numeric forms
    // ('2130706433', '127.1', '0x7f.0.0.1') to the address they denote, and
    // that address is what gets checked.
    if (!/^[a-z0-9.-]+$/i.test(bare)) throw new TargetNotAllowedError('invalid SMTP host');
    await assertPublicHttpUrl(`http://${bare}/`);
  } catch (err) {
    if (err instanceof TargetNotAllowedError) {
      logger.warn({ userId: req.session?.userId, tenantId: req.tenantId, reason: err.reason }, 'SMTP host refused');
    }
    throw err;
  }
}

/** Create / update: screens the host of the body (absent: nothing to screen; the controller validates the body). */
function screenBodyHost() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const host = (req.body as { host?: unknown } | undefined)?.host;
      if (!isPlatformAdmin(req) && typeof host === 'string' && host.trim()) {
        await assertSmtpHostAllowed(req, host);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Test: screens the stored host again (a name may resolve elsewhere since it was saved). */
function screenStoredHost() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = toDbId(req.params.id);
      if (!isPlatformAdmin(req) && id !== null) {
        const server = await db('smtp_servers').where({ id, tenant_id: req.tenantId }).first('host') as
          { host: string } | undefined;
        // Unknown id or another tenant's server: the controller answers 404.
        if (server) await assertSmtpHostAllowed(req, String(server.host));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

router.get('/', smtpServerController.list);
router.post('/', screenBodyHost(), smtpServerController.create);
router.put('/:id', screenBodyHost(), smtpServerController.update);
router.delete('/:id', smtpServerController.delete);
router.post('/:id/test', screenStoredHost(), smtpServerController.test);

export default router;
