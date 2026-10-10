import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { smtpServerService } from '../services/smtpServer.service';
import { auditService } from '../services/audit.service';
import { REDACTED } from '../services/notification.service';
import { AppError } from '../middleware/errorHandler';
import { requireDbId } from '../utils/dbId';
import { logger } from '../utils/logger';

const createSchema = z.object({
  name: z.string().trim().min(1).max(128),
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean().optional(),
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(255),
  fromAddress: z.string().trim().min(1).max(255),
});

// Every field optional; an empty password keeps the stored one.
const updateSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  username: z.string().trim().min(1).max(255).optional(),
  password: z.string().max(255).optional(),
  fromAddress: z.string().trim().min(1).max(255).optional(),
});

export const smtpServerController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const servers = await smtpServerService.list(req.tenantId);
      res.json({ success: true, data: servers });
    } catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, 'Missing or invalid fields');
      const { name, host, port, secure, username, password, fromAddress } = parsed.data;
      const server = await smtpServerService.create({ name, host, port, secure: secure ?? false, username, password, fromAddress, tenantId: req.tenantId });
      void auditService.logReq(req, {
        action: 'smtp.server_created',
        resourceType: 'smtp_server',
        resourceId: server.id,
        details: { name, host, port },
      });
      res.status(201).json({ success: true, data: server });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'SMTP server id');
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, 'Invalid fields');
      const { name, host, port, secure, username, password, fromAddress } = parsed.data;
      const server = await smtpServerService.update(id, req.tenantId, {
        ...(name !== undefined && { name }),
        ...(host !== undefined && { host }),
        ...(port !== undefined && { port }),
        ...(secure !== undefined && { secure }),
        ...(username !== undefined && { username }),
        ...(password && password !== REDACTED ? { password } : {}),
        ...(fromAddress !== undefined && { fromAddress }),
      });
      if (!server) throw new AppError(404, 'SMTP server not found');
      void auditService.logReq(req, {
        action: 'smtp.server_updated',
        resourceType: 'smtp_server',
        resourceId: id,
        details: {
          fields: Object.keys(parsed.data).filter((k) => k !== 'password'),
          passwordChanged: !!password && password !== REDACTED,
        },
      });
      res.json({ success: true, data: server });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'SMTP server id');
      const removed = await smtpServerService.delete(id, req.tenantId);
      if (!removed) throw new AppError(404, 'SMTP server not found');
      void auditService.logReq(req, { action: 'smtp.server_deleted', resourceType: 'smtp_server', resourceId: id });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async test(req: Request, res: Response, next: NextFunction): Promise<void> {
    let id: number | null = null;
    try {
      id = requireDbId(req.params.id, 'SMTP server id');
      await smtpServerService.test(id, req.tenantId);
      void auditService.logReq(req, { action: 'smtp.server_tested', resourceType: 'smtp_server', resourceId: id, details: { ok: true } });
      res.json({ success: true, message: 'Connection successful' });
    } catch (err) {
      if (err instanceof AppError) { next(err); return; }
      // Library errors (host, port, server banner...) stay in the server log.
      logger.warn({ smtpServerId: id, err: err instanceof Error ? err.message : String(err) }, 'SMTP test failed');
      void auditService.logReq(req, { action: 'smtp.server_tested', resourceType: 'smtp_server', resourceId: id, details: { ok: false } });
      next(new AppError(400, 'Connection failed'));
    }
  },
};
